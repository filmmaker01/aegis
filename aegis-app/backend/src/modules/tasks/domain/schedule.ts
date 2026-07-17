/**
 * Timezone-aware scheduling maths. Pure: no I/O, no Telegram, no database.
 *
 * The whole product stores instants in UTC. A timezone matters in exactly two
 * places, both of which live here:
 *   - resolving a wall-clock intent ("сегодня вечером") to a UTC instant;
 *   - rendering a UTC instant back as the owner's local time.
 *
 * Conversion uses Intl (full ICU ships with Bun) rather than a date library, so
 * no new dependency is introduced and DST is handled by the platform's tz data.
 */

import type { ReminderSlot, SnoozeSlot } from './types'

/** Wall-clock hour treated as "вечером". */
export const EVENING_HOUR = 19
/** Wall-clock hour treated as "утром". */
export const MORNING_HOUR = 9

export interface WallClock {
  year: number
  /** 1-12 (not the JS 0-11). */
  month: number
  day: number
  hour: number
  minute: number
}

/** Is this a timezone the runtime's tz database actually knows? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const PARTS_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = PARTS_FORMAT_CACHE.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    PARTS_FORMAT_CACHE.set(timeZone, fmt)
  }
  return fmt
}

/** The wall-clock reading a given zone shows at a given instant. */
export function toWallClock(instant: Date, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value
    return value === undefined ? 0 : Number(value)
  }
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

/** Zone offset (ms east of UTC) in effect at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value
    return value === undefined ? 0 : Number(value)
  }
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  // Second-resolution: the formatter drops sub-second, so align the comparison.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * Resolve a wall-clock reading in `timeZone` to the UTC instant it denotes.
 *
 * Two passes: the offset itself depends on the instant we are solving for, so we
 * guess with the offset at the naive timestamp, then correct with the offset that
 * actually applies there. This settles DST transitions (a shift only moves the
 * answer by the offset delta, and the second pass applies exactly that delta).
 */
export function fromWallClock(wall: WallClock, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
  const firstGuess = naive - zoneOffsetMs(new Date(naive), timeZone)
  const corrected = naive - zoneOffsetMs(new Date(firstGuess), timeZone)
  return new Date(corrected)
}

/** Same calendar day in `timeZone`, at the given wall-clock hour. */
function atHourOnDay(day: WallClock, hour: number, timeZone: string): Date {
  return fromWallClock({ ...day, hour, minute: 0 }, timeZone)
}

/** The wall-clock date `days` after the given one (calendar arithmetic, not +24h). */
function addDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  }
}

/**
 * Resolve a preset to a UTC instant.
 *
 * Returns null for 'none' (a task with no reminder). 'custom' is not resolvable
 * here — it hands off to parseCustomDateTime — so it also returns null.
 *
 * "Сегодня вечером" rolls to tomorrow when 19:00 local has already passed, so the
 * button never silently schedules a reminder in the past.
 */
export function resolveSlot(slot: ReminderSlot, now: Date, timeZone: string): Date | null {
  switch (slot) {
    case '30m':
      return new Date(now.getTime() + 30 * 60_000)
    case '1h':
      return new Date(now.getTime() + 60 * 60_000)
    case 'evening': {
      const today = toWallClock(now, timeZone)
      const tonight = atHourOnDay(today, EVENING_HOUR, timeZone)
      return tonight.getTime() > now.getTime()
        ? tonight
        : atHourOnDay(addDays(today, 1), EVENING_HOUR, timeZone)
    }
    case 'morning':
      return atHourOnDay(addDays(toWallClock(now, timeZone), 1), MORNING_HOUR, timeZone)
    case 'none':
    case 'custom':
      return null
  }
}

/**
 * The UTC half-open interval [from, to) covering the owner's local calendar day
 * containing `now`. Drives /today: a "day" is the user's day, not a UTC day, and
 * it is not always 24h long (DST).
 */
export function dayWindow(now: Date, timeZone: string): { from: Date; to: Date } {
  const today = toWallClock(now, timeZone)
  const from = fromWallClock({ ...today, hour: 0, minute: 0 }, timeZone)
  const to = fromWallClock({ ...addDays(today, 1), hour: 0, minute: 0 }, timeZone)
  return { from, to }
}

/** Snooze presets on a fired reminder — always relative to now. */
export function resolveSnooze(slot: SnoozeSlot, now: Date): Date | null {
  switch (slot) {
    case '15m':
      return new Date(now.getTime() + 15 * 60_000)
    case '1h':
      return new Date(now.getTime() + 60 * 60_000)
    case 'custom':
      return null
  }
}

const COLON_TIME = /^(\d{1,2}):(\d{2})$/
const DOT_TIME = /^(\d{1,2})\.(\d{2})$/
const DATE_TIME = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:\s+(\d{1,2})[:.](\d{2}))?$/

/**
 * Parse a user-typed date for the "📅 Другая дата" step, interpreted in the
 * owner's timezone. Accepted: `HH:MM`, `DD.MM`, `DD.MM HH:MM`, `DD.MM.YYYY HH:MM`.
 *
 * A bare time means today, rolling to tomorrow if already past. A bare date
 * defaults to 09:00, rolling to next year if that date already passed. A
 * two-digit year means 20xx. Returns null when the input is unparseable, not a
 * real calendar date, or resolves to the past — the caller re-prompts rather than
 * scheduling something the user did not mean.
 *
 * A dot is ambiguous: `25.12` is a date, `18.45` cannot be one. Dates therefore
 * win, and a dotted pair only falls back to a time when it is not a real date.
 */
export function parseCustomDateTime(input: string, now: Date, timeZone: string): Date | null {
  const text = input.trim()

  const colonTime = COLON_TIME.exec(text)
  if (colonTime) return timeToday(Number(colonTime[1]), Number(colonTime[2]), now, timeZone)

  const dateTime = DATE_TIME.exec(text)
  if (dateTime) {
    const resolved = resolveDateTime(dateTime, now, timeZone)
    if (resolved) return resolved
  }

  const dotTime = DOT_TIME.exec(text)
  if (dotTime) return timeToday(Number(dotTime[1]), Number(dotTime[2]), now, timeZone)

  return null
}

/** A bare wall-clock time: today if still ahead, otherwise tomorrow. */
function timeToday(hour: number, minute: number, now: Date, timeZone: string): Date | null {
  if (!isValidTime(hour, minute)) return null
  const today = toWallClock(now, timeZone)
  const at = fromWallClock({ ...today, hour, minute }, timeZone)
  if (at.getTime() > now.getTime()) return at
  return fromWallClock({ ...addDays(today, 1), hour, minute }, timeZone)
}

function resolveDateTime(match: RegExpExecArray, now: Date, timeZone: string): Date | null {
  const today = toWallClock(now, timeZone)
  const day = Number(match[1])
  const month = Number(match[2])
  const explicitYear = match[3] !== undefined
  const year = explicitYear ? normalizeYear(Number(match[3])) : today.year
  const hour = match[4] === undefined ? MORNING_HOUR : Number(match[4])
  const minute = match[5] === undefined ? 0 : Number(match[5])

  if (!isValidTime(hour, minute)) return null
  if (!isRealDate(year, month, day)) return null

  const at = fromWallClock({ year, month, day, hour, minute }, timeZone)
  if (at.getTime() > now.getTime()) return at
  // A bare DD.MM that already passed this year means the user meant next year.
  if (explicitYear) return null
  if (!isRealDate(year + 1, month, day)) return null
  return fromWallClock({ year: year + 1, month, day, hour, minute }, timeZone)
}

function isValidTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
}

// ── Natural language ─────────────────────────────────────────────────────────
//
// A pragmatic Russian time grammar (the "core set"): relative offsets, the
// сегодня/завтра/послезавтра words, month names, parts of the day, and bare
// clock times. Everything resolves through fromWallClock, so it stays
// timezone- and DST-correct. Anything it does not recognise falls through to
// parseCustomDateTime, and an unrecognised input returns null.

/** Wall-clock hour meant by each part-of-day word. */
const PART_OF_DAY: Record<string, number> = {
  'утром': MORNING_HOUR,
  'утра': MORNING_HOUR,
  'днём': 13,
  'днем': 13,
  'дня': 13,
  'вечером': EVENING_HOUR,
  'вечера': EVENING_HOUR,
  'ночью': 23,
  'ночи': 23,
}

const MONTH_STEMS: Array<[RegExp, number]> = [
  [/^янв/, 1], [/^фев/, 2], [/^мар/, 3], [/^апр/, 4], [/^ма[йя]/, 5], [/^июн/, 6],
  [/^июл/, 7], [/^авг/, 8], [/^сен/, 9], [/^окт/, 10], [/^ноя/, 11], [/^дек/, 12],
]

function monthFromWord(word: string): number | null {
  for (const [re, n] of MONTH_STEMS) if (re.test(word)) return n
  return null
}

/** A clock time or a part-of-day word -> {hour, minute}. `в` prefix is optional. */
function parseClockOrPart(s: string): { hour: number; minute: number } | null {
  const t = s.trim().replace(/^в\s+/, '')
  if (t in PART_OF_DAY) return { hour: PART_OF_DAY[t]!, minute: 0 }
  // Colon time or a bare hour only. Dotted forms (8.30) are left to
  // parseCustomDateTime so they never collide with a DD.MM date.
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t)
  if (m) {
    const hour = Number(m[1])
    const minute = m[2] === undefined ? 0 : Number(m[2])
    if (isValidTime(hour, minute)) return { hour, minute }
  }
  return null
}

// \w does NOT match Cyrillic in JS, so word tails use [а-яё]* explicitly.
const RELATIVE_RE = /^через\s+(?:(\d+)\s*)?(минут[а-яё]*|мин\.?|час[а-яё]*|ч\.?|день|дн[а-яё]*|недел[а-яё]*|нед\.?)$/
const DAY_WORD_RE = /^(сегодня|завтра|послезавтра)(?:\s+(.*))?$/
const MONTH_RE = /^(\d{1,2})\s+([а-яё]+)(?:\s+(.*))?$/

/**
 * Resolve a Russian time phrase to a UTC instant, or null.
 *
 * Supported (core set):
 *   через 3 часа | через 30 минут | через 2 дня | через неделю
 *   сегодня/завтра/послезавтра [в] 18 | … 18:30 | … утром/вечером
 *   1 августа | 1 августа 09:30
 *   утром/вечером/ночью/днём
 *   в 18 | 18:30 | 25.12 | 25.12 14:30      (last two via parseCustomDateTime)
 */
export function parseNaturalLanguage(input: string, now: Date, timeZone: string): Date | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) return null
  const today = toWallClock(now, timeZone)

  // 1. Relative offset from now.
  const rel = RELATIVE_RE.exec(text)
  if (rel) {
    const n = rel[1] === undefined ? 1 : Number(rel[1])
    const unit = rel[2]!
    if (/^мин/.test(unit)) return new Date(now.getTime() + n * 60_000)
    if (unit === 'ч' || /^час/.test(unit)) return new Date(now.getTime() + n * 3_600_000)
    if (/^нед/.test(unit)) return fromWallClock(addDays(today, n * 7), timeZone)
    // The remaining units are день / дня / дней / дн.
    return fromWallClock(addDays(today, n), timeZone)
  }

  // 2. сегодня / завтра / послезавтра [+ time].
  const dayWord = DAY_WORD_RE.exec(text)
  if (dayWord) {
    const offset = dayWord[1] === 'сегодня' ? 0 : dayWord[1] === 'завтра' ? 1 : 2
    const rest = (dayWord[2] ?? '').trim()
    const clock = rest ? parseClockOrPart(rest) : { hour: MORNING_HOUR, minute: 0 }
    if (!clock) return null
    const at = fromWallClock({ ...addDays(today, offset), hour: clock.hour, minute: clock.minute }, timeZone)
    // "сегодня в 8" when 08:00 already passed is not a real future time.
    if (at.getTime() <= now.getTime()) return null
    return at
  }

  // 3. "1 августа" / "1 августа 09:30".
  const monthMatch = MONTH_RE.exec(text)
  if (monthMatch) {
    const day = Number(monthMatch[1])
    const month = monthFromWord(monthMatch[2]!)
    if (month !== null) {
      const clock = monthMatch[3]?.trim() ? parseClockOrPart(monthMatch[3]!.trim()) : { hour: MORNING_HOUR, minute: 0 }
      if (clock && isRealDate(today.year, month, day)) {
        const at = fromWallClock({ year: today.year, month, day, hour: clock.hour, minute: clock.minute }, timeZone)
        if (at.getTime() > now.getTime()) return at
        if (isRealDate(today.year + 1, month, day)) {
          return fromWallClock({ year: today.year + 1, month, day, hour: clock.hour, minute: clock.minute }, timeZone)
        }
      }
    }
  }

  // 4. A bare part-of-day or clock time -> today, rolling to tomorrow if past.
  const clock = parseClockOrPart(text)
  if (clock) return timeToday(clock.hour, clock.minute, now, timeZone)

  // 5. Structured fallback (DD.MM, DD.MM.YYYY, HH:MM, 8.30).
  return parseCustomDateTime(input, now, timeZone)
}

/**
 * Split a free message into a title and a trailing time phrase, e.g.
 * "Купить хлеб завтра в 18" -> { title: "Купить хлеб", remindAt: … }.
 *
 * Returns null when no time phrase is found (the whole message is the title) or
 * when the phrase is present but does not parse — so a create flow can fall back
 * to treating the text as a plain title rather than guessing.
 */
export function splitTitleAndTime(
  input: string,
  now: Date,
  timeZone: string,
): { title: string; remindAt: Date } | null {
  const text = input.trim()
  const lower = text.toLowerCase()

  // Triggers that mark where a time phrase begins. `в` and month names use an
  // explicit space/start boundary because \b is unreliable around Cyrillic.
  const triggers = [
    /через\s+(?:\d+\s*)?(?:минут|мин|час|ч|день|дн|дня|дней|недел|нед)/,
    /(?:^|\s)(сегодня|завтра|послезавтра)(?:\s|$)/,
    /(?:^|\s)\d{1,2}\s+(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек)/,
    /(?:^|\s)(утром|утра|днём|днем|дня|вечером|вечера|ночью|ночи)(?:\s|$)/,
    /(?:^|\s)в\s+\d/,
    /(?:^|\s)\d{1,2}:\d{2}(?:\s|$)/,
    /(?:^|\s)\d{1,2}\.\d{1,2}(?:\s|$)/,
  ]

  let cut = -1
  for (const re of triggers) {
    const m = re.exec(lower)
    if (!m) continue
    // Skip the leading whitespace the boundary group may have captured.
    let idx = m.index
    if (/\s/.test(lower[idx] ?? '')) idx += 1
    if (cut === -1 || idx < cut) cut = idx
  }
  if (cut <= 0) return null // no trigger, or the phrase is the whole message

  const title = text.slice(0, cut).trim()
  const phrase = text.slice(cut).trim()
  if (!title || !phrase) return null

  const remindAt = parseNaturalLanguage(phrase, now, timeZone)
  if (!remindAt) return null
  return { title, remindAt }
}

// ── Calendar ─────────────────────────────────────────────────────────────────

/** Month names for a card header (nominative) and for "1 августа" (genitive). */
export const MONTHS_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

/** Add `delta` calendar months to a year/month (month is 1-12). */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = (year * 12 + (month - 1)) + delta
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 }
}

/**
 * A month laid out as weeks of day numbers, Monday-first, with 0 for the padding
 * cells before the 1st and after the last day. Pure calendar arithmetic (no tz):
 * the weekday of a given Y/M/D is timezone-independent.
 */
export function monthMatrix(year: number, month: number): number[][] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  // Mon=0 … Sun=6 for the 1st of the month.
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7

  const cells: number[] = Array(firstWeekday).fill(0)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(0)

  const weeks: number[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** Is Y/M/D strictly before the owner's local today? (for greying past days) */
export function isBeforeToday(year: number, month: number, day: number, now: Date, timeZone: string): boolean {
  const today = toWallClock(now, timeZone)
  return (year * 10000 + month * 100 + day) < (today.year * 10000 + today.month * 100 + today.day)
}

/** Rejects 31.02 and friends: round-tripping a real date preserves its parts. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year
}
