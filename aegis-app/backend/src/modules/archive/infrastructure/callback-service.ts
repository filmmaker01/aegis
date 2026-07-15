import type { InlineKeyboardMarkup, TelegramFileClient } from '../../telegram/file-client'
import type { ArchiveRepository, CallbackEventRef, CallbackMessageRef } from '../application/ports'
import type { IncomingCallback } from '../domain/types'
import type { MediaStorage } from '../media/storage'
import {
  archiveDetailCard,
  archiveListCard,
  decodeCallback,
  deletedKeyboard,
  historyKeyboard,
  historyView,
  mediaCaption,
  splitText,
  type InlineKeyboard,
} from '../notification/format'

const HISTORY_PAGE_SIZE = 5

/**
 * Handles inline-button presses (callback_query) from the owner's chat cards.
 *
 * SECURITY: every action resolves the opaque id in the callback_data back to its
 * owner and requires callback_query.from.id === ownerTgUserId. Any foreign or
 * unknown id gets a neutral "Недоступно" and NOTHING else happens — the bot never
 * reveals whether an id exists (anti-enumeration).
 *
 * Restore/history re-send content to the CALLBACK chat (the owner's chat with the
 * bot), never into the original monitored chat. Never logs message text, tokens,
 * storage keys, or ids beyond safe action labels.
 */
export class CallbackService {
  // Best-effort idempotency for repeat Restore presses (MVP: in-process; a restart
  // just allows a safe, repeatable re-send). Keyed by "del:<eventId>"/"msg:<id>".
  private readonly restored = new Set<string>()

  constructor(
    private readonly repo: ArchiveRepository,
    private readonly fileClient: TelegramFileClient,
    private readonly storage: MediaStorage,
  ) {}

  async handle(cb: IncomingCallback): Promise<void> {
    const { action, parts } = decodeCallback(cb.data)
    try {
      switch (action) {
        case 'restore':
          await this.restore(cb, parts[0])
          break
        case 'history':
          await this.history(cb, parts[0], parts[1])
          break
        case 'archive':
          await this.archive(cb, parts[0])
          break
        default:
          await this.deny(cb)
      }
    } catch (err) {
      console.error(`[callback] action=${action} error=${(err as Error).name}`)
      await this.deny(cb).catch(() => {})
    }
  }

  // ── restore ────────────────────────────────────────────────────────────────

  private async restore(cb: IncomingCallback, id: string | undefined): Promise<void> {
    if (!id) return this.deny(cb)
    const ev = await this.repo.getEventForCallback(id)
    if (ev) {
      if (ev.ownerTgUserId !== cb.fromTgId) return this.deny(cb)
      return this.restoreDeletion(cb, ev)
    }
    const m = await this.repo.getMessageForCallback(id)
    if (m && m.ownerTgUserId === cb.fromTgId) return this.restoreEdit(cb, m)
    return this.deny(cb)
  }

  private async restoreDeletion(cb: IncomingCallback, ev: CallbackEventRef): Promise<void> {
    const guard = `del:${ev.eventId}`
    if (this.restored.has(guard)) return this.answer(cb, 'Уже восстановлено')
    if (!ev.messageId) return this.answer(cb, 'Копия не была сохранена')

    const m = await this.repo.getMessageForCallback(ev.messageId)
    const text = m?.currentText ?? null
    const media = await this.repo.getStoredMediaForMessageId(ev.messageId)

    let delivered = false
    if (media.length > 0) {
      delivered = await this.resendMedia(cb.chatId, media, text)
    }
    if (!delivered && text && text.trim().length > 0) {
      delivered = await this.resendText(cb.chatId, text)
    }
    if (!delivered) return this.answer(cb, 'Не удалось восстановить')

    this.restored.add(guard)
    await this.answer(cb, 'Восстановлено')
  }

  private async restoreEdit(cb: IncomingCallback, m: CallbackMessageRef): Promise<void> {
    const guard = `msg:${m.messageId}`
    if (this.restored.has(guard)) return this.answer(cb, 'Уже восстановлено')

    const total = await this.repo.countMessageVersions(m.messageId)
    if (total < 2) return this.answer(cb, 'Нет предыдущей версии')
    const prev = await this.repo.getMessageVersions(m.messageId, total - 2, 1)
    const text = prev[0]?.text ?? null
    if (!text || text.trim().length === 0) return this.answer(cb, 'Предыдущая версия без текста')

    const ok = await this.resendText(cb.chatId, text)
    if (!ok) return this.answer(cb, 'Не удалось восстановить')

    this.restored.add(guard)
    await this.answer(cb, 'Восстановлено')
  }

  /** Re-sends the saved text as PLAIN text (no parse mode) so stored content can
   * never be interpreted as markup or inject formatting. Split for length. */
  private async resendText(chatId: number, text: string): Promise<boolean> {
    let ok = false
    for (const chunk of splitText(text)) {
      const res = await this.fileClient.sendMessage(chatId, chunk)
      if (res.ok) ok = true
    }
    return ok
  }

  /** Re-sends stored media; the caption (escaped HTML) rides on the first file. */
  private async resendMedia(
    chatId: number,
    media: Awaited<ReturnType<ArchiveRepository['getStoredMediaForMessageId']>>,
    text: string | null,
  ): Promise<boolean> {
    let delivered = false
    for (let i = 0; i < media.length; i++) {
      const m = media[i]!
      let bytes: Buffer | null = null
      try {
        bytes = await this.storage.get(m.storageKey)
      } catch {
        bytes = null
      }
      if (!bytes) continue
      const caption = i === 0 ? mediaCaption(text) : undefined
      const res = await this.fileClient.sendMedia(m.type, chatId, bytes, {
        filename: m.fileName ?? undefined,
        contentType: m.mimeType ?? undefined,
        ...(caption ? { caption, parseMode: 'HTML' as const } : {}),
      })
      if (res.ok) delivered = true
    }
    return delivered
  }

  // ── history ──────────────────────────────────────────────────────────────

  private async history(
    cb: IncomingCallback,
    id: string | undefined,
    pageStr: string | undefined,
  ): Promise<void> {
    if (!id) return this.deny(cb)
    let messageId: string | null = null
    const ev = await this.repo.getEventForCallback(id)
    if (ev) {
      if (ev.ownerTgUserId !== cb.fromTgId) return this.deny(cb)
      messageId = ev.messageId
    } else {
      const m = await this.repo.getMessageForCallback(id)
      if (!m || m.ownerTgUserId !== cb.fromTgId) return this.deny(cb)
      messageId = m.messageId
    }
    if (!messageId) return this.answer(cb, 'История недоступна')

    const total = await this.repo.countMessageVersions(messageId)
    const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))
    const page = Math.min(parsePage(pageStr), totalPages)
    const offset = (page - 1) * HISTORY_PAGE_SIZE
    const rows = await this.repo.getMessageVersions(messageId, offset, HISTORY_PAGE_SIZE)

    const text = historyView({
      versions: rows.map((r) => ({ versionNo: r.versionNo, text: r.text, at: r.at })),
      page,
      pageSize: HISTORY_PAGE_SIZE,
      total,
    })
    // Send a new message for the page (in-place text edit is out of scope for MVP;
    // the buttons let the owner page forward/back). Full history lives in the Mini App.
    await this.fileClient.sendMessage(cb.chatId, text, {
      parseMode: 'HTML',
      replyMarkup: historyKeyboard(id, page, totalPages) as InlineKeyboardMarkup,
    })
    await this.answer(cb)
  }

  // ── archive (rendered IN-CHAT, not the Mini App) ───────────────────────────

  /**
   * "Открыть архив" / "Показать все": renders the archived copy directly in the
   * chat. A single deletion -> a full detail card (untruncated saved text + media
   * summary + Restore/History). A bulk deletion -> the full list of its items.
   */
  private async archive(cb: IncomingCallback, id: string | undefined): Promise<void> {
    if (!id) return this.deny(cb)
    const ctx = await this.repo.getArchiveContext(id)
    if (!ctx || ctx.ownerTgUserId !== cb.fromTgId) return this.deny(cb)
    const peer = { name: ctx.peerTitle, username: ctx.peerUsername }

    if (ctx.items.length > 1) {
      const text = archiveListCard({
        peer,
        at: ctx.detectedAt,
        items: ctx.items.map((i) => ({ tgMessageId: i.tgMessageId, savedText: i.savedText, mediaTypes: i.mediaTypes })),
      })
      await this.sendChunks(cb.chatId, text)
      return this.answer(cb)
    }

    const it = ctx.items[0]
    if (!it || !it.messageId) return this.answer(cb, 'Копия не сохранена')
    const text = archiveDetailCard({
      peer,
      at: ctx.detectedAt,
      savedText: it.savedText,
      mediaTypes: it.mediaTypes,
      versionCount: it.versionCount,
    })
    const kb = deletedKeyboard(it.eventId, { hasHistory: it.versionCount > 1, archived: true })
    await this.sendChunks(cb.chatId, text, kb)
    await this.answer(cb)
  }

  /** Sends card text (HTML) across length-safe chunks; keyboard on the last chunk. */
  private async sendChunks(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const chunks = splitText(text)
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      await this.fileClient.sendMessage(chatId, chunks[i]!, {
        parseMode: 'HTML',
        ...(isLast && keyboard ? { replyMarkup: keyboard as InlineKeyboardMarkup } : {}),
      })
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async deny(cb: IncomingCallback): Promise<void> {
    await this.fileClient.answerCallbackQuery(cb.id, { text: 'Недоступно' })
  }

  private async answer(cb: IncomingCallback, text?: string, showAlert = false): Promise<void> {
    await this.fileClient.answerCallbackQuery(cb.id, { ...(text ? { text } : {}), showAlert })
  }
}

function parsePage(pageStr: string | undefined): number {
  const n = Number(pageStr)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}
