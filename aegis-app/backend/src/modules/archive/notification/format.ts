/**
 * Pure formatting for Aegis owner-facing notifications (the normal chat with the
 * bot — NOT the Mini App). No I/O, no Telegram calls: given already-parsed data
 * it returns HTML message text, captions, and inline keyboards. This keeps the
 * copy, escaping, length limits and callback_data encoding unit-testable.
 *
 * Style rules (product): Russian, clean, compact, minimal emoji, never claims WHO
 * deleted a message (Telegram does not report the initiator).
 */

import type { MediaType } from '../domain/types'

// Telegram hard limits.
export const MESSAGE_TEXT_LIMIT = 4096
export const CAPTION_LIMIT = 1024
export const CALLBACK_DATA_LIMIT = 64

// Reserve headroom so a header + quoted body never exceeds the message limit.
const QUOTED_BODY_LIMIT = 3500

/** Escape the five characters that matter for Telegram HTML parse mode. */
export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Truncate to `max` visible chars, adding an ellipsis when cut. Operates on the
 * raw string BEFORE HTML escaping so we never split an entity. */
export function truncate(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…'
}

/** Split raw text into chunks each <= max chars, on line/space boundaries when
 * possible. Used for long saved text that must go across several messages. */
export function splitText(text: string, max = MESSAGE_TEXT_LIMIT): string[] {
  if ([...text].length <= max) return [text]
  const out: string[] = []
  let rest = text
  while ([...rest].length > max) {
    const slice = [...rest].slice(0, max).join('')
    // Prefer to break on the last newline, then space, to avoid mid-word cuts.
    const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
    const cut = breakAt > max * 0.5 ? breakAt : slice.length
    out.push([...rest].slice(0, cut).join('').trimEnd())
    rest = [...rest].slice(cut).join('').trimStart()
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/** Russian plural: pick form for [one, few, many]. */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1]
  return forms[2]
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * Compact timestamp for a card: `HH:MM` when the event is from the same UTC day
 * as `now`, otherwise `DD.MM · HH:MM`. UTC is used deliberately — per-owner
 * timezone is a future setting; centralising it here keeps that change local.
 */
export function formatTimestamp(date: Date, now: Date = new Date()): string {
  const hhmm = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
  const sameDay =
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  if (sameDay) return hhmm
  return `${pad2(date.getUTCDate())}.${pad2(date.getUTCMonth() + 1)} · ${hhmm}`
}

export interface PeerRef {
  /** Display name (chat title / first name). */
  name?: string | null
  /** @username without the leading @, if any. */
  username?: string | null
}

/** `<b>Roman</b>\n@roman · 23:45` (all parts optional & HTML-escaped). */
function peerLine(peer: PeerRef, at: Date, now: Date): string {
  const name = peer.name?.trim()
  const nameHtml = name ? `<b>${escapeHtml(name)}</b>` : '<b>Собеседник</b>'
  const meta: string[] = []
  if (peer.username) meta.push(`@${escapeHtml(peer.username)}`)
  meta.push(formatTimestamp(at, now))
  return `${nameHtml}\n${meta.join(' · ')}`
}

const RU_MEDIA: Record<MediaType, [string, string, string]> = {
  photo: ['фото', 'фото', 'фото'],
  video: ['видео', 'видео', 'видео'],
  voice: ['голосовое', 'голосовых', 'голосовых'],
  video_note: ['видеосообщение', 'видеосообщения', 'видеосообщений'],
  audio: ['аудио', 'аудио', 'аудио'],
  document: ['документ', 'документа', 'документов'],
  animation: ['GIF', 'GIF', 'GIF'],
  sticker: ['стикер', 'стикера', 'стикеров'],
}

export function mediaNoun(type: MediaType, n = 1): string {
  return pluralRu(n, RU_MEDIA[type])
}

// ── Card builders ────────────────────────────────────────────────────────────
// Each returns a ready-to-send HTML string (parse_mode=HTML). Keyboards are
// built separately (buildKeyboard / keyboards below) so callers compose freely.

export interface DeletedTextCardInput {
  peer: PeerRef
  at: Date
  savedText?: string | null
  /** False when the message predates monitoring and was never archived. */
  archived: boolean
  now?: Date
}

export function deletedTextCard(input: DeletedTextCardInput): string {
  const now = input.now ?? new Date()
  if (!input.archived) {
    return [
      '🗑 <b>Обнаружено удаление</b>',
      '',
      peerLine(input.peer, input.at, now),
      '',
      '<i>Сообщение в этом чате было удалено, но его копия не сохранена — оно старше начала наблюдения.</i>',
    ].join('\n')
  }
  const body =
    input.savedText && input.savedText.trim().length > 0
      ? escapeHtml(truncate(input.savedText, QUOTED_BODY_LIMIT))
      : '<i>(без текста)</i>'
  return [
    '🗑 <b>Сообщение удалено</b>',
    '',
    peerLine(input.peer, input.at, now),
    '',
    body,
  ].join('\n')
}

export interface EditedCardInput {
  peer: PeerRef
  at: Date
  before?: string | null
  after?: string | null
  now?: Date
}

export function editedCard(input: EditedCardInput): string {
  const now = input.now ?? new Date()
  const before =
    input.before && input.before.trim().length > 0
      ? escapeHtml(truncate(input.before, 1500))
      : '<i>(пусто)</i>'
  const after =
    input.after && input.after.trim().length > 0
      ? escapeHtml(truncate(input.after, 1500))
      : '<i>(пусто)</i>'
  return [
    '✏️ <b>Сообщение изменено</b>',
    '',
    peerLine(input.peer, input.at, now),
    '',
    '<b>Было:</b>',
    before,
    '',
    '<b>Стало:</b>',
    after,
  ].join('\n')
}

export interface MediaLeadCardInput {
  peer: PeerRef
  at: Date
  types: MediaType[]
  caption?: string | null
  archived: boolean
  now?: Date
}

/** Short text card sent BEFORE the stored media file(s). */
export function mediaLeadCard(input: MediaLeadCardInput): string {
  const now = input.now ?? new Date()
  const noun =
    input.types.length === 1
      ? mediaNoun(input.types[0]!)
      : `вложения (${input.types.length})`
  const lines = ['🗑 <b>Удалено сообщение с медиа</b>', '', peerLine(input.peer, input.at, now), '', `📎 ${escapeHtml(noun)}`]
  if (input.caption && input.caption.trim().length > 0) {
    lines.push('', '<b>Подпись:</b>', escapeHtml(truncate(input.caption, 1500)))
  }
  return lines.join('\n')
}

/** Caption attached to a re-sent media file (<= Telegram caption limit). */
export function mediaCaption(text: string | null | undefined): string | undefined {
  if (!text || text.trim().length === 0) return undefined
  return escapeHtml(truncate(text, CAPTION_LIMIT - 8))
}

/** Honest note when a stored media file could not be re-sent. */
export function mediaFailedNote(types: MediaType[]): string {
  const listed = types.map((t) => escapeHtml(mediaNoun(t))).join(', ')
  return `⚠️ Не удалось переслать сохранённое вложение (${listed}). Копия могла не успеть сохраниться до удаления.`
}

export interface BatchPreview {
  savedText?: string | null
  mediaTypes?: MediaType[]
}

export interface BatchCardInput {
  peer: PeerRef
  count: number
  previews: BatchPreview[]
  now?: Date
  at: Date
}

/** One card for a bulk deletion instead of N separate messages. */
export function batchCard(input: BatchCardInput): string {
  const now = input.now ?? new Date()
  const noun = pluralRu(input.count, ['сообщение', 'сообщения', 'сообщений'])
  const lines = [
    `🗑 <b>Удалено ${input.count} ${escapeHtml(noun)}</b>`,
    '',
    peerLine(input.peer, input.at, now),
    '',
  ]
  const shown = input.previews.slice(0, 5)
  for (const p of shown) {
    const text = p.savedText?.trim()
    if (text) {
      lines.push(`• ${escapeHtml(truncate(text, 80))}`)
    } else if (p.mediaTypes && p.mediaTypes.length > 0) {
      lines.push(`• 📎 ${escapeHtml(mediaNoun(p.mediaTypes[0]!))}`)
    } else {
      lines.push('• <i>(без текста)</i>')
    }
  }
  if (input.count > shown.length) {
    lines.push('', `<i>…и ещё ${input.count - shown.length}</i>`)
  }
  return lines.join('\n')
}

export interface VersionView {
  versionNo: number
  text?: string | null
  at?: Date | null
}

export interface HistoryViewInput {
  versions: VersionView[]
  page: number
  pageSize: number
  total: number
  now?: Date
}

/** Compact edit-history view for the chat (paginated; full history lives in the Mini App). */
export function historyView(input: HistoryViewInput): string {
  const now = input.now ?? new Date()
  const totalPages = Math.max(1, Math.ceil(input.total / input.pageSize))
  const page = Math.min(Math.max(1, input.page), totalPages)
  const lines = [`✏️ <b>История сообщения</b>  ·  стр. ${page}/${totalPages}`, '']
  for (const v of input.versions) {
    const when = v.at ? ` · ${formatTimestamp(v.at, now)}` : ''
    const text = v.text?.trim() ? escapeHtml(truncate(v.text, 600)) : '<i>(без текста)</i>'
    lines.push(`<b>Версия ${v.versionNo}</b>${when}`, text, '')
  }
  return lines.join('\n').trimEnd()
}

function countTypes(types: MediaType[]): Array<[MediaType, number]> {
  const m = new Map<MediaType, number>()
  for (const t of types) m.set(t, (m.get(t) ?? 0) + 1)
  return [...m.entries()]
}

export interface ArchiveDetailInput {
  peer: PeerRef
  at: Date
  savedText?: string | null
  mediaTypes: MediaType[]
  versionCount: number
  now?: Date
}

/** In-chat "open archive" detail for a single archived message (full saved text). */
export function archiveDetailCard(input: ArchiveDetailInput): string {
  const now = input.now ?? new Date()
  const lines = ['📄 <b>Архивная копия</b>', '', peerLine(input.peer, input.at, now), '']
  lines.push(
    input.savedText && input.savedText.trim().length > 0
      ? escapeHtml(truncate(input.savedText, QUOTED_BODY_LIMIT))
      : '<i>(без текста)</i>',
  )
  const meta: string[] = []
  if (input.mediaTypes.length > 0) {
    meta.push('📎 ' + countTypes(input.mediaTypes).map(([t, n]) => `${mediaNoun(t, n)}${n > 1 ? ` ×${n}` : ''}`).join(', '))
  }
  if (input.versionCount > 1) meta.push(`✏️ версий: ${input.versionCount}`)
  if (meta.length > 0) lines.push('', meta.join('  ·  '))
  return lines.join('\n')
}

export interface ArchiveListItem {
  tgMessageId: number
  savedText?: string | null
  mediaTypes?: MediaType[]
}

export interface ArchiveListInput {
  peer: PeerRef
  at: Date
  items: ArchiveListItem[]
  now?: Date
}

/** In-chat "show all" list for a bulk deletion — every archived item, numbered. */
export function archiveListCard(input: ArchiveListInput): string {
  const now = input.now ?? new Date()
  const n = input.items.length
  const lines = [`📄 <b>Удалённые сообщения · ${n}</b>`, '', peerLine(input.peer, input.at, now), '']
  const shown = input.items.slice(0, 30)
  shown.forEach((it, i) => {
    const t = it.savedText?.trim()
    if (t) lines.push(`${i + 1}. ${escapeHtml(truncate(t, 120))}`)
    else if (it.mediaTypes && it.mediaTypes.length > 0) lines.push(`${i + 1}. 📎 ${escapeHtml(mediaNoun(it.mediaTypes[0]!))}`)
    else lines.push(`${i + 1}. <i>(без текста)</i>`)
  })
  if (n > shown.length) lines.push('', `<i>…и ещё ${n - shown.length}</i>`)
  return lines.join('\n')
}

// ── Inline keyboards ─────────────────────────────────────────────────────────

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}
export type InlineKeyboard = { inline_keyboard: InlineButton[][] }

/** callback_data codec. Keeps payloads well under Telegram's 64-byte limit. */
export function encodeCallback(action: string, ...parts: (string | number)[]): string {
  const data = [action, ...parts.map(String)].join(':')
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_LIMIT) {
    throw new Error(`callback_data too long (${data.length} chars): ${action}`)
  }
  return data
}

export function decodeCallback(data: string): { action: string; parts: string[] } {
  const [action, ...parts] = data.split(':')
  return { action: action ?? '', parts }
}

export function deletedKeyboard(eventId: string, opts: { hasHistory: boolean; archived: boolean }): InlineKeyboard {
  const row1: InlineButton[] = []
  if (opts.archived) row1.push({ text: 'Восстановить', callback_data: encodeCallback('restore', eventId) })
  if (opts.hasHistory) row1.push({ text: 'История изменений', callback_data: encodeCallback('history', eventId) })
  const rows: InlineButton[][] = []
  if (row1.length > 0) rows.push(row1)
  rows.push([{ text: 'Открыть архив', callback_data: encodeCallback('archive', eventId) }])
  return { inline_keyboard: rows }
}

export function editedKeyboard(eventId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Восстановить прошлую версию', callback_data: encodeCallback('restore', eventId) },
        { text: 'Все версии', callback_data: encodeCallback('history', eventId) },
      ],
    ],
  }
}

export function historyKeyboard(eventId: string, page: number, totalPages: number): InlineKeyboard {
  const nav: InlineButton[] = []
  if (page > 1) nav.push({ text: '‹ Назад', callback_data: encodeCallback('history', eventId, page - 1) })
  if (page < totalPages) nav.push({ text: 'Дальше ›', callback_data: encodeCallback('history', eventId, page + 1) })
  const rows: InlineButton[][] = []
  if (nav.length > 0) rows.push(nav)
  return { inline_keyboard: rows.length > 0 ? rows : [[{ text: 'Открыть архив', callback_data: encodeCallback('archive', eventId) }]] }
}

export function batchKeyboard(eventId: string, count: number): InlineKeyboard {
  return {
    inline_keyboard: [[{ text: `Показать все (${count})`, callback_data: encodeCallback('archive', eventId) }]],
  }
}
