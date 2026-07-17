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

/** Rejects 31.02 and friends: round-tripping a real date preserves its parts. */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year
}
