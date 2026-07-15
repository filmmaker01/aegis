import { recordNotifyFailure } from '../../../monitoring'
import type { SendResult, TelegramFileClient } from '../../telegram/file-client'
import type { DeletionNotification, Notifier } from '../application/ports'
import type { MediaStorage } from '../media/storage'

/** No-op notifier (used when no bot token is configured, e.g. local dev). */
export const noopNotifier: Notifier = {
  async notifyDeletion() {},
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Notifies the owner on deletion, in `business_connection.user_chat_id` (NOT the
 * monitored chat.id). Sends the saved text, then re-sends stored media via the
 * type-appropriate Bot API method. If media sending fails, sends an honest text
 * note instead. Limited retry (honors 429 retry_after). Logs only safe
 * diagnostics — never file bytes, tokens, storage keys, or personal data.
 */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly fileClient: TelegramFileClient,
    private readonly storage: MediaStorage,
    private readonly maxAttempts = 3,
  ) {}

  async notifyDeletion(n: DeletionNotification): Promise<void> {
    // Base text notification — always delivered so context isn't lost even if media fails.
    const textOk = await this.withRetry(n.tgMessageId, () =>
      this.fileClient.sendMessage(n.ownerTgChatId, this.headerText(n)),
    )

    if (!textOk) recordNotifyFailure()

    if (n.media.length === 0) {
      console.log(`[notify] message_id=${n.tgMessageId} archived=${n.archived} media=0 text=${textOk ? 'ok' : 'fail'}`)
      return
    }

    let sent = 0
    const failedTypes: string[] = []
    for (const m of n.media) {
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
      const ok = await this.withRetry(n.tgMessageId, () =>
        this.fileClient.sendMedia(m.type, n.ownerTgChatId, bytes as Buffer, {
          filename: m.fileName ?? undefined,
          contentType: m.mimeType ?? undefined,
        }),
      )
      if (ok) sent++
      else failedTypes.push(m.type)
    }

    if (failedTypes.length > 0) {
      recordNotifyFailure()
      // Honest fallback: tell the owner which media could not be re-sent.
      await this.withRetry(n.tgMessageId, () =>
        this.fileClient.sendMessage(
          n.ownerTgChatId,
          `⚠️ Couldn't re-send the saved ${failedTypes.join(', ')} (${sent}/${n.media.length} media delivered).`,
        ),
      )
    }
    console.log(`[notify] message_id=${n.tgMessageId} archived=${n.archived} media=${n.media.length} sent=${sent}`)
  }

  private headerText(n: DeletionNotification): string {
    const peer = n.peerLabel ? ` with ${n.peerLabel}` : ''
    if (!n.archived) {
      return `🗑 A message in your chat${peer} was deleted, but its content was not in your archive (it predates monitoring).`
    }
    const lines = [`🗑 Deleted message in your chat${peer}:`]
    if (n.savedText) lines.push('', n.savedText)
    if (n.hasMedia && n.media.length === 0) lines.push('', '📎 (media was not saved or is still downloading)')
    else if (n.media.length > 0) lines.push('', '📎 saved copy attached below')
    else if (!n.savedText) lines.push('', '(no text content)')
    return lines.join('\n')
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
