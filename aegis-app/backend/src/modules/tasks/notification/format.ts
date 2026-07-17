/**
 * Pure formatting for the planner's owner-facing messages. No I/O, no Telegram
 * calls: given already-parsed data it returns HTML message text and inline
 * keyboards. This keeps the copy, escaping, length limits and callback_data
 * encoding unit-testable.
 *
 * The escaping/truncation/codec primitives are carried over from the archive's
 * notification layer — they encode Telegram's hard limits, which have not changed.
 *
 * Style rules (product): Russian, clean, compact, minimal emoji.
 */

import {
  isBeforeToday,
  MONTHS_NOMINATIVE,
  monthMatrix,
  toWallClock,
  zoneOffsetMs,
} from '../domain/schedule'
import type { Task } from '../domain/types'

// Telegram hard limits.
export const MESSAGE_TEXT_LIMIT = 4096
export const CALLBACK_DATA_LIMIT = 64

/** Telegram rejects a task title longer than this once wrapped in a card. */
export const TITLE_LIMIT = 200

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
 * possible. */
export function splitText(text: string, max = MESSAGE_TEXT_LIMIT): string[] {
  if ([...text].length <= max) return [text]
  const out: string[] = []
  let rest = text
  while ([...rest].length > max) {
    const slice = [...rest].slice(0, max).join('')
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

const MONTHS_RU = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
]

/**
 * Render a UTC instant as the owner's local time: `сегодня, 19:00` /
 * `завтра, 09:00` / `25 дек, 14:30`. Relative words are computed on calendar days
 * in the owner's zone, not on 24-hour spans.
 */
export function formatWhen(instant: Date, timeZone: string, now: Date = new Date()): string {
  const at = toWallClock(instant, timeZone)
  const today = toWallClock(now, timeZone)
  const hhmm = `${pad2(at.hour)}:${pad2(at.minute)}`

  const dayIndex = (w: { year: number; month: number; day: number }) =>
    Math.floor(Date.UTC(w.year, w.month - 1, w.day) / 86_400_000)
  const delta = dayIndex(at) - dayIndex(today)

  if (delta === 0) return `сегодня, ${hhmm}`
  if (delta === 1) return `завтра, ${hhmm}`
  if (delta === -1) return `вчера, ${hhmm}`
  const month = MONTHS_RU[at.month - 1] ?? ''
  const year = at.year === today.year ? '' : ` ${at.year}`
  return `${at.day} ${month}${year}, ${hhmm}`
}

// ── callback_data codec ──────────────────────────────────────────────────────

/** Keeps payloads well under Telegram's 64-byte limit. */
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

// ── Inline keyboards ─────────────────────────────────────────────────────────

export interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}
export type InlineKeyboard = { inline_keyboard: InlineButton[][] }

export function mainMenuKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '➕ Создать задачу', callback_data: encodeCallback('new') }],
      [{ text: '📋 Мои задачи', callback_data: encodeCallback('list') }],
    ],
  }
}

/** A button that does nothing (calendar padding / labels). Answered silently. */
const NOOP = encodeCallback('noop')
/** Invisible label for empty calendar cells (Telegram needs non-empty text). */
const BLANK = '⁣'

/**
 * The "when?" step after a title: quick presets, a calendar entry, and — because
 * the card also accepts a typed phrase — an implicit natural-language option.
 * Used for both creating and editing a reminder time.
 */
export function whenKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Через 30 минут', callback_data: encodeCallback('slot', '30m') },
        { text: 'Через 1 час', callback_data: encodeCallback('slot', '1h') },
      ],
      [
        { text: 'Сегодня вечером', callback_data: encodeCallback('slot', 'evening') },
        { text: 'Завтра утром', callback_data: encodeCallback('slot', 'morning') },
      ],
      [{ text: '📅 Выбрать дату и время', callback_data: encodeCallback('cal') }],
      [{ text: 'Без напоминания', callback_data: encodeCallback('slot', 'none') }],
      [{ text: '✕ Отмена', callback_data: encodeCallback('cancel') }],
    ],
  }
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

/**
 * Month grid, Monday-first. Days before the owner's today are shown but not
 * pickable (there is no point scheduling a reminder in the past). Navigation
 * arrows change the month; a day tap advances to the hour picker.
 */
export function calendarKeyboard(year: number, month: number, now: Date, timeZone: string): InlineKeyboard {
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 }
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }

  const rows: InlineButton[][] = [
    [
      { text: '‹', callback_data: encodeCallback('calnav', prev.y, prev.m) },
      { text: `${MONTHS_NOMINATIVE[month - 1]} ${year}`, callback_data: NOOP },
      { text: '›', callback_data: encodeCallback('calnav', next.y, next.m) },
    ],
    WEEKDAYS.map((w) => ({ text: w, callback_data: NOOP })),
  ]

  for (const week of monthMatrix(year, month)) {
    rows.push(
      week.map((day) => {
        if (day === 0) return { text: BLANK, callback_data: NOOP }
        if (isBeforeToday(year, month, day, now, timeZone)) return { text: `·${day}`, callback_data: NOOP }
        return { text: String(day), callback_data: encodeCallback('calday', year, month, day) }
      }),
    )
  }

  const today = toWallClock(now, timeZone)
  rows.push([
    { text: 'Сегодня', callback_data: encodeCallback('calday', today.year, today.month, today.day) },
    { text: '← Назад', callback_data: encodeCallback('when') },
  ])
  return { inline_keyboard: rows }
}

/**
 * Hour grid for a chosen day. On today, hours already fully past are shown but
 * not pickable. "Ввести вручную" jumps to a typed HH:MM for the same date.
 */
export function hourKeyboard(year: number, month: number, day: number, now: Date, timeZone: string): InlineKeyboard {
  const today = toWallClock(now, timeZone)
  const isToday = year === today.year && month === today.month && day === today.day

  const rows: InlineButton[][] = []
  for (let base = 0; base < 24; base += 6) {
    rows.push(
      Array.from({ length: 6 }, (_, i) => {
        const h = base + i
        const label = String(h).padStart(2, '0')
        // On today, an hour whose last minute (h:59) has passed is unusable.
        if (isToday && h < today.hour) return { text: `·${label}`, callback_data: NOOP }
        return { text: label, callback_data: encodeCallback('calh', year, month, day, h) }
      }),
    )
  }
  rows.push([
    { text: '✏️ Ввести время', callback_data: encodeCallback('calman', year, month, day) },
    { text: '← Дни', callback_data: encodeCallback('cal') },
  ])
  return { inline_keyboard: rows }
}

/** Minute grid (5-minute steps) for a chosen date+hour. */
export function minuteKeyboard(
  year: number,
  month: number,
  day: number,
  hour: number,
  now: Date,
  timeZone: string,
): InlineKeyboard {
  const today = toWallClock(now, timeZone)
  const isNowHour = year === today.year && month === today.month && day === today.day && hour === today.hour

  const rows: InlineButton[][] = []
  for (let base = 0; base < 60; base += 20) {
    rows.push(
      Array.from({ length: 4 }, (_, i) => {
        const mm = base + i * 5
        const label = ':' + String(mm).padStart(2, '0')
        if (isNowHour && mm <= today.minute) return { text: `·${label}`, callback_data: NOOP }
        return { text: label, callback_data: encodeCallback('calm', year, month, day, hour, mm) }
      }),
    )
  }
  rows.push([
    { text: '← Часы', callback_data: encodeCallback('calday', year, month, day) },
    { text: '✏️ Ввести время', callback_data: encodeCallback('calman', year, month, day) },
  ])
  return { inline_keyboard: rows }
}

/** Cancel-only keyboard for the manual-time text step. */
export function cancelKeyboard(): InlineKeyboard {
  return { inline_keyboard: [[{ text: '✕ Отмена', callback_data: encodeCallback('cancel') }]] }
}

export function confirmKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Создать', callback_data: encodeCallback('confirm') },
        { text: '✕ Отмена', callback_data: encodeCallback('cancel') },
      ],
    ],
  }
}

/**
 * One row per task, plus a create button.
 *
 * The buttons ARE the list — the card text no longer repeats them. Each label
 * carries the title and when it is due, so nothing is lost by not printing the
 * same rows twice.
 */
export function taskListKeyboard(tasks: Task[], timeZone: string, now?: Date): InlineKeyboard {
  const at = now ?? new Date()
  const rows = tasks.map((t) => [
    { text: taskListLabel(t, timeZone, at), callback_data: encodeCallback('open', t.id) },
  ])
  rows.push([{ text: '➕ Создать задачу', callback_data: encodeCallback('new') }])
  return { inline_keyboard: rows }
}

/** Button labels are plain text (never HTML) and must stay scannable. */
function taskListLabel(task: Task, timeZone: string, now: Date): string {
  const title = truncate(task.title, 32)
  if (task.status === 'done') return `✅ ${title}`
  if (!task.remindAt) return `▫️ ${title}`
  return `▫️ ${title} · ${formatWhen(task.remindAt, timeZone, now)}`
}

export function taskDetailKeyboard(task: Task): InlineKeyboard {
  const rows: InlineButton[][] = []
  if (task.status === 'active') {
    rows.push([
      { text: '✅ Выполнено', callback_data: encodeCallback('done', task.id) },
      { text: '⏰ Изменить время', callback_data: encodeCallback('edittime', task.id) },
    ])
  } else {
    // "Выполнено" is one tap and easy to hit by mistake; without this the only way
    // back is deleting the task and typing it again.
    rows.push([{ text: '↩️ Вернуть в работу', callback_data: encodeCallback('reopen', task.id) }])
  }
  rows.push([
    { text: '✏️ Изменить', callback_data: encodeCallback('edit', task.id) },
    { text: '🗑 Удалить', callback_data: encodeCallback('del', task.id) },
  ])
  rows.push([{ text: '← Назад', callback_data: encodeCallback('list') }])
  return { inline_keyboard: rows }
}

/** The snooze picker for an existing task ("⏰ Перенести"). */
export function snoozeKeyboard(taskId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '⏱ Через 15 минут', callback_data: encodeCallback('snz', taskId, '15m') },
        { text: '⏱ Через 1 час', callback_data: encodeCallback('snz', taskId, '1h') },
      ],
      [{ text: '📅 Другая дата', callback_data: encodeCallback('snz', taskId, 'custom') }],
      [{ text: '← Назад', callback_data: encodeCallback('open', taskId) }],
    ],
  }
}

/** The keyboard on a fired reminder. */
export function reminderKeyboard(taskId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: '✅ Выполнено', callback_data: encodeCallback('done', taskId) }],
      [
        { text: '⏱ Через 15 минут', callback_data: encodeCallback('snz', taskId, '15m') },
        { text: '⏱ Через 1 час', callback_data: encodeCallback('snz', taskId, '1h') },
      ],
      [{ text: '📅 Другое время', callback_data: encodeCallback('edittime', taskId) }],
    ],
  }
}

export function deleteConfirmKeyboard(taskId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '🗑 Удалить', callback_data: encodeCallback('delyes', taskId) },
        { text: '← Отмена', callback_data: encodeCallback('open', taskId) },
      ],
    ],
  }
}

/** Offered at /start and /settings. Kept to one screen of two-column rows. */
export const TIMEZONES: Array<{ id: string; label: string }> = [
  { id: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
  { id: 'Europe/Moscow', label: 'Москва (UTC+3)' },
  { id: 'Europe/Samara', label: 'Самара (UTC+4)' },
  { id: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
  { id: 'Asia/Omsk', label: 'Омск (UTC+6)' },
  { id: 'Asia/Krasnoyarsk', label: 'Красноярск (UTC+7)' },
  { id: 'Asia/Irkutsk', label: 'Иркутск (UTC+8)' },
  { id: 'Asia/Yakutsk', label: 'Якутск (UTC+9)' },
  { id: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
  { id: 'Asia/Magadan', label: 'Магадан (UTC+11)' },
  { id: 'Asia/Kamchatka', label: 'Камчатка (UTC+12)' },
  { id: 'Europe/Minsk', label: 'Минск (UTC+3)' },
  { id: 'Asia/Almaty', label: 'Алматы (UTC+5)' },
  { id: 'UTC', label: 'UTC' },
]

export function timezoneKeyboard(): InlineKeyboard {
  const rows: InlineButton[][] = []
  for (let i = 0; i < TIMEZONES.length; i += 2) {
    rows.push(
      TIMEZONES.slice(i, i + 2).map((tz) => ({
        text: tz.label,
        callback_data: encodeCallback('tz', tz.id),
      })),
    )
  }
  return { inline_keyboard: rows }
}

/**
 * The human label for an IANA zone. `Europe/Moscow` is an implementation detail
 * and must never reach the user; an unlisted zone degrades to its UTC offset.
 */
export function timezoneLabel(timeZone: string, now: Date = new Date()): string {
  const known = TIMEZONES.find((tz) => tz.id === timeZone)
  if (known) return known.label
  const offsetMinutes = Math.round(zoneOffsetMs(now, timeZone) / 60_000)
  const sign = offsetMinutes < 0 ? '−' : '+'
  const hours = Math.floor(Math.abs(offsetMinutes) / 60)
  const minutes = Math.abs(offsetMinutes) % 60
  return `UTC${sign}${hours}${minutes ? `:${pad2(minutes)}` : ''}`
}

// ── Card builders ────────────────────────────────────────────────────────────
// Each returns a ready-to-send HTML string (parse_mode=HTML).

export function mainMenuCard(): string {
  return ['<b>Мои задачи</b>', '', 'С чего начнём?'].join('\n')
}

/**
 * First contact: greeting, what the bot is for, and the timezone question — all
 * in ONE message that carries the picker. A bare picker read like a setup wizard;
 * splitting it in two just meant two notifications before the user did anything.
 */
export function welcomeCard(): string {
  return [
    '👋 <b>Привет!</b>',
    '',
    'Я помогу не забыть о делах: запишу задачу и напомню о ней вовремя.',
    '',
    'Для начала — выберите ближайший к вам город, чтобы «завтра утром»',
    'значило именно ваше утро.',
  ].join('\n')
}

export function timezoneCard(current: string | null, now?: Date): string {
  const lines = ['🌍 <b>Часовой пояс</b>', '']
  if (current) {
    lines.push(`Сейчас: <b>${escapeHtml(timezoneLabel(current, now))}</b>`, '', 'Можно выбрать другой:')
  } else {
    lines.push('Выберите ближайший к вам город:')
  }
  return lines.join('\n')
}

export function askTitleCard(): string {
  return ['➕ <b>Новая задача</b>', '', 'Что нужно сделать?'].join('\n')
}

/** The "when?" step: presets + calendar, and it also accepts a typed phrase. */
export function askWhenCard(title: string, editing = false): string {
  return [
    editing ? '⏰ <b>Изменить время</b>' : '➕ <b>Новая задача</b>',
    '',
    escapeHtml(truncate(title, TITLE_LIMIT)),
    '',
    '<b>Когда напомнить?</b>',
    'Выберите кнопкой или напишите словами:',
    '<i>«завтра в 18», «через 3 часа», «1 августа 09:30»</i>',
  ].join('\n')
}

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/** "15 августа 2026" for a Y/M/D chosen in the calendar. */
function longDate(year: number, month: number, day: number): string {
  return `${day} ${MONTHS_GENITIVE[month - 1]} ${year}`
}

export function calendarCard(): string {
  return ['📅 <b>Выберите дату</b>', '', 'Или напишите словами, например <i>«завтра в 18»</i>.'].join('\n')
}

export function hourCard(year: number, month: number, day: number): string {
  return [`📅 <b>${longDate(year, month, day)}</b>`, '', 'Выберите час:'].join('\n')
}

export function minuteCard(year: number, month: number, day: number, hour: number): string {
  return [`📅 <b>${longDate(year, month, day)}, ${String(hour).padStart(2, '0')}:__</b>`, '', 'Выберите минуты:'].join('\n')
}

export function manualTimeCard(year: number, month: number, day: number): string {
  return [
    `📅 <b>${longDate(year, month, day)}</b>`,
    '',
    'Введите время сообщением, например <code>14:30</code> или <code>9:05</code>.',
  ].join('\n')
}

export function invalidTimeCard(): string {
  return [
    '⚠️ <b>Не понял время</b>',
    '',
    'Нужен формат <code>ЧЧ:ММ</code>, например <code>14:30</code>. И время в будущем.',
  ].join('\n')
}

export function invalidWhenCard(): string {
  return [
    '⚠️ <b>Не получилось разобрать</b>',
    '',
    'Попробуйте словами — <i>«завтра в 18», «через 2 часа», «1 августа 09:30»</i> —',
    'или выберите дату кнопкой 📅.',
  ].join('\n')
}

export function askCustomDateCard(): string {
  return [
    '📅 <b>Другая дата</b>',
    '',
    'Введите дату и время сообщением. Например:',
    '<code>25.12 14:30</code> · <code>25.12.2026 09:00</code> · <code>18:45</code>',
  ].join('\n')
}

export function invalidDateCard(): string {
  return [
    '📅 <b>Другая дата</b>',
    '',
    '⚠️ Не получилось разобрать — попробуйте так:',
    '<code>25.12 14:30</code> · <code>25.12.2026 09:00</code> · <code>18:45</code>',
    '',
    'И убедитесь, что время ещё не прошло.',
  ].join('\n')
}

export function confirmCard(title: string, remindAt: Date | null, timeZone: string, now?: Date): string {
  const when = remindAt ? formatWhen(remindAt, timeZone, now ?? new Date()) : 'без напоминания'
  return [
    '➕ <b>Новая задача</b>',
    '',
    escapeHtml(truncate(title, TITLE_LIMIT)),
    '',
    `⏰ ${escapeHtml(when)}`,
    '',
    'Создаём?',
  ].join('\n')
}

export function createdCard(title: string, remindAt: Date | null, timeZone: string, now?: Date): string {
  const when = remindAt ? formatWhen(remindAt, timeZone, now ?? new Date()) : 'без напоминания'
  return [
    '✅ <b>Задача создана</b>',
    '',
    escapeHtml(truncate(title, TITLE_LIMIT)),
    '',
    `⏰ ${escapeHtml(when)}`,
  ].join('\n')
}

/** Header only — the keyboard below it carries the tasks themselves. */
export function taskListCard(tasks: Task[]): string {
  if (tasks.length === 0) {
    return ['📋 <b>Мои задачи</b>', '', 'Пока пусто — самое время добавить первую.'].join('\n')
  }
  const active = tasks.filter((t) => t.status === 'active').length
  const summary =
    active === 0
      ? 'Всё сделано 🎉'
      : `${active} ${pluralRu(active, ['задача', 'задачи', 'задач'])} в работе`
  return ['📋 <b>Мои задачи</b>', '', summary].join('\n')
}

export function todayCard(tasks: Task[], timeZone: string, now?: Date): string {
  if (tasks.length === 0) {
    return ['📅 <b>Сегодня</b>', '', 'На сегодня ничего не запланировано.'].join('\n')
  }
  const at = now ?? new Date()
  const lines = [`📅 <b>Сегодня</b>`, '']
  for (const t of tasks) {
    const when = t.remindAt ? escapeHtml(formatWhen(t.remindAt, timeZone, at).replace('сегодня, ', '')) : ''
    lines.push(`${when} — ${escapeHtml(truncate(t.title, 80))}`)
  }
  return lines.join('\n')
}

/**
 * One line describing where a task stands.
 *
 * A completed task deliberately does NOT show its reminder time: the reminder
 * will never fire again (the due scan only claims active tasks), so showing it
 * would promise something that cannot happen.
 */
function statusLine(task: Task, timeZone: string, now: Date): string {
  if (task.status === 'done') {
    const when = task.completedAt ? ` · ${formatWhen(task.completedAt, timeZone, now)}` : ''
    return `✅ Выполнено${when}`
  }
  if (!task.remindAt) return 'Без напоминания'
  return `⏰ ${formatWhen(task.remindAt, timeZone, now)}`
}

export function taskDetailCard(task: Task, timeZone: string, now?: Date): string {
  const at = now ?? new Date()
  return [
    `<b>${escapeHtml(truncate(task.title, TITLE_LIMIT))}</b>`,
    '',
    escapeHtml(statusLine(task, timeZone, at)),
  ].join('\n')
}

export function reminderCard(task: Task): string {
  return ['⏰ <b>Напоминание</b>', '', escapeHtml(truncate(task.title, TITLE_LIMIT))].join('\n')
}

export function askEditTitleCard(task: Task): string {
  return [
    '✏️ <b>Изменить название</b>',
    '',
    `Сейчас: ${escapeHtml(truncate(task.title, TITLE_LIMIT))}`,
    '',
    'Введите новое название одним сообщением.',
  ].join('\n')
}

export function deleteConfirmCard(task: Task): string {
  return [
    '🗑 <b>Удалить задачу?</b>',
    '',
    escapeHtml(truncate(task.title, TITLE_LIMIT)),
    '',
    '<i>Это действие необратимо.</i>',
  ].join('\n')
}

export function askSnoozeCard(task: Task, timeZone: string, now?: Date): string {
  const when = task.remindAt
    ? formatWhen(task.remindAt, timeZone, now ?? new Date())
    : 'без напоминания'
  return [
    '⏰ <b>Перенести</b>',
    '',
    escapeHtml(truncate(task.title, TITLE_LIMIT)),
    '',
    `Сейчас: ${escapeHtml(when)}`,
  ].join('\n')
}

/** Shown for a command we do not know — says so, then offers what does work. */
export function unknownCommandCard(): string {
  return ['🤔 <b>Не знаю такой команды</b>', '', 'Вот что я умею:', '', COMMAND_LIST].join('\n')
}

export function helpCard(): string {
  return ['<b>Мои задачи</b>', '', 'Что я умею:', '', COMMAND_LIST].join('\n')
}

const COMMAND_LIST = [
  '/new — новая задача',
  '/tasks — все мои задачи',
  '/today — что сегодня',
  '/settings — часовой пояс',
  '/cancel — отменить то, что сейчас вводите',
].join('\n')
