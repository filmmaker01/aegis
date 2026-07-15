import { recordNotifyFailure } from '../../../monitoring'
import type { InlineKeyboardMarkup, SendResult, TelegramFileClient } from '../../telegram/file-client'
import type {
  BatchDeletionNotification,
  DeletionNotification,
  EditNotification,
  Notifier,
} from '../application/ports'
import type { MediaType } from '../domain/types'
import type { MediaStorage } from '../media/storage'
import {
  batchCard,
  batchKeyboard,
  deletedKeyboard,
  deletedTextCard,
  editedCard,
  editedKeyboard,
  mediaCaption,
  mediaFailedNote,
  mediaLeadCard,
  splitText,
  type InlineKeyboard,
  type PeerRef,
} from '../notification/format'

/** No-op notifier (used when no bot token is configured, e.g. local dev). */
export const noopNotifier: Notifier = {
  async notifyDeletion() {},
  async notifyEdit() {},
  async notifyBatchDeletion() {},
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const peerOf = (n: { peerTitle?: string | null; peerUsername?: string | null }): PeerRef => ({
  name: n.peerTitle ?? null,
  username: n.peerUsername ?? null,
})

/**
 * Owner-facing notifier. Builds Russian cards via the pure format module and
 * sends them to `business_connection.user_chat_id` (NOT the monitored chat) with
 * HTML parse mode and inline action buttons. Media deletions send a lead card,
 * then re-send each stored file; on failure an honest note is sent instead.
 * Limited retry (honors 429 retry_after). Logs only safe diagnostics — never file
 * bytes, tokens, storage keys, message text, or personal data.
 */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly fileClient: TelegramFileClient,
    private readonly storage: MediaStorage,
    private readonly maxAttempts = 3,
  ) {}

  async notifyDeletion(n: DeletionNotification): Promise<void> {
    const peer = peerOf(n)

    if (!n.archived) {
      const text = deletedTextCard({ peer, at: n.at, archived: false })
      const kb = deletedKeyboard(n.eventId, { hasHistory: false, archived: false })
      const ok = await this.sendCard(n.tgMessageId, n.ownerTgChatId, text, kb)
      if (!ok) recordNotifyFailure()
      console.log(`[notify] deletion message_id=${n.tgMessageId} archived=false media=0 text=${ok ? 'ok' : 'fail'}`)
      return
    }

    const kb = deletedKeyboard(n.eventId, { hasHistory: n.hasHistory, archived: true })

    if (n.media.length === 0) {
      const text = deletedTextCard({ peer, at: n.at, savedText: n.savedText, archived: true })
      const ok = await this.sendCard(n.tgMessageId, n.ownerTgChatId, text, kb)
      if (!ok) recordNotifyFailure()
      console.log(`[notify] deletion message_id=${n.tgMessageId} archived=true media=0 text=${ok ? 'ok' : 'fail'}`)
      return
    }

    // Media deletion: a lead card (with the action buttons), then each stored file.
    const types = n.media.map((m) => m.type)
    const lead = mediaLeadCard({ peer, at: n.at, types, archived: true })
    const leadOk = await this.sendCard(n.tgMessageId, n.ownerTgChatId, lead, kb)
    if (!leadOk) recordNotifyFailure()

    let sent = 0
    const failedTypes: MediaType[] = []
    for (let i = 0; i < n.media.length; i++) {
      const m = n.media[i]!
      let bytes: Buffer | null = null
      try {
        bytes = await this.storage.get(m.storageKey)
      } catch {
        bytes = null
      }
      if (!bytes) {
        failedTypes.push(m.type)
        continue
      }
      // Put the caption on the first re-sent file only, to avoid repetition.
      const caption = i === 0 ? mediaCaption(n.savedText) : undefined
      const ok = await this.withRetry(n.tgMessageId, () =>
        this.fileClient.sendMedia(m.type, n.ownerTgChatId, bytes as Buffer, {
          filename: m.fileName ?? undefined,
          contentType: m.mimeType ?? undefined,
          ...(caption ? { caption, parseMode: 'HTML' as const } : {}),
        }),
      )
      if (ok) sent++
      else failedTypes.push(m.type)
    }

    if (failedTypes.length > 0) {
      recordNotifyFailure()
      await this.withRetry(n.tgMessageId, () =>
        this.fileClient.sendMessage(n.ownerTgChatId, mediaFailedNote(failedTypes), { parseMode: 'HTML' }),
      )
    }
    console.log(`[notify] deletion message_id=${n.tgMessageId} archived=true media=${n.media.length} sent=${sent}`)
  }

  async notifyEdit(n: EditNotification): Promise<void> {
    const peer = peerOf(n)
    const text = editedCard({ peer, at: n.at, before: n.before, after: n.after })
    const kb = editedKeyboard(n.messageId)
    const ok = await this.sendCard(n.tgMessageId, n.ownerTgChatId, text, kb)
    if (!ok) recordNotifyFailure()
    console.log(`[notify] edit message_id=${n.tgMessageId} text=${ok ? 'ok' : 'fail'}`)
  }

  async notifyBatchDeletion(n: BatchDeletionNotification): Promise<void> {
    const peer = peerOf(n)
    const text = batchCard({ peer, at: n.at, count: n.count, previews: n.previews })
    const kb = batchKeyboard(n.eventId, n.count)
    const ok = await this.sendCard(0, n.ownerTgChatId, text, kb)
    if (!ok) recordNotifyFailure()
    console.log(`[notify] batch chat=${n.tgChatId} count=${n.count} text=${ok ? 'ok' : 'fail'}`)
  }

  /**
   * Sends card text with HTML parse mode and an inline keyboard. splitText is a
   * safety net for text that would exceed the message limit (cards are normally
   * bounded well under it); the keyboard is attached to the final chunk.
   */
  private async sendCard(
    logMessageId: number,
    chatId: number,
    text: string,
    keyboard: InlineKeyboard,
  ): Promise<boolean> {
    const chunks = splitText(text)
    let allOk = true
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const ok = await this.withRetry(logMessageId, () =>
        this.fileClient.sendMessage(chatId, chunks[i]!, {
          parseMode: 'HTML',
          ...(isLast ? { replyMarkup: keyboard as InlineKeyboardMarkup } : {}),
        }),
      )
      if (!ok) allOk = false
    }
    return allOk
  }

  private async withRetry(messageId: number, send: () => Promise<SendResult>): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await send()
        if (res.ok) return true
        console.error(`[notify] message_id=${messageId} attempt=${attempt} status=${res.status}`)
        if (attempt < this.maxAttempts) await sleep(500 * attempt)
      } catch (err) {
        console.error(`[notify] message_id=${messageId} attempt=${attempt} error=${(err as Error).name}`)
        if (attempt < this.maxAttempts) await sleep(500 * attempt)
      }
    }
    return false
  }
}
