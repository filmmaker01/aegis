import { describe, expect, test } from 'bun:test'

import {
  addMonths,
  dayWindow,
  fromWallClock,
  isBeforeToday,
  isValidTimeZone,
  monthMatrix,
  parseCustomDateTime,
  parseNaturalLanguage,
  resolveSlot,
  resolveSnooze,
  splitTitleAndTime,
  toWallClock,
  zoneOffsetMs,
} from './schedule'

const MSK = 'Europe/Moscow' // UTC+3 year-round, no DST
const BERLIN = 'Europe/Berlin' // UTC+1 / UTC+2, has DST

describe('isValidTimeZone', () => {
  test('accepts real zones and rejects junk', () => {
    expect(isValidTimeZone(MSK)).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('zoneOffsetMs', () => {
  test('Moscow is UTC+3', () => {
    expect(zoneOffsetMs(new Date('2026-07-17T12:00:00Z'), MSK)).toBe(3 * 3_600_000)
  })

  test('Berlin shifts with DST', () => {
    expect(zoneOffsetMs(new Date('2026-01-15T12:00:00Z'), BERLIN)).toBe(1 * 3_600_000)
    expect(zoneOffsetMs(new Date('2026-07-15T12:00:00Z'), BERLIN)).toBe(2 * 3_600_000)
  })
})

describe('toWallClock / fromWallClock', () => {
  test('reads the local wall clock', () => {
    expect(toWallClock(new Date('2026-07-17T12:30:00Z'), MSK)).toEqual({
      year: 2026,
      month: 7,
      day: 17,
      hour: 15,
      minute: 30,
    })
  })

  test('round-trips a wall clock back to its instant', () => {
    const instant = new Date('2026-07-17T09:00:00Z')
    expect(fromWallClock(toWallClock(instant, MSK), MSK).toISOString()).toBe(instant.toISOString())
  })

  test('resolves a wall clock across a DST boundary', () => {
    // 2026-03-29: Berlin jumps 02:00 -> 03:00. 12:00 local that day is UTC+2.
    expect(fromWallClock({ year: 2026, month: 3, day: 29, hour: 12, minute: 0 }, BERLIN).toISOString()).toBe(
      '2026-03-29T10:00:00.000Z',
    )
    // The day before is still UTC+1.
    expect(fromWallClock({ year: 2026, month: 3, day: 28, hour: 12, minute: 0 }, BERLIN).toISOString()).toBe(
      '2026-03-28T11:00:00.000Z',
    )
  })
})

describe('resolveSlot', () => {
  const now = new Date('2026-07-17T09:00:00Z') // 12:00 MSK

  test('relative slots are simple offsets', () => {
    expect(resolveSlot('30m', now, MSK)!.toISOString()).toBe('2026-07-17T09:30:00.000Z')
    expect(resolveSlot('1h', now, MSK)!.toISOString()).toBe('2026-07-17T10:00:00.000Z')
  })

  test('"сегодня вечером" is 19:00 local today', () => {
    // 19:00 MSK == 16:00 UTC
    expect(resolveSlot('evening', now, MSK)!.toISOString()).toBe('2026-07-17T16:00:00.000Z')
  })

  test('"сегодня вечером" rolls to tomorrow once 19:00 local has passed', () => {
    const late = new Date('2026-07-17T18:00:00Z') // 21:00 MSK — evening is gone
    expect(resolveSlot('evening', late, MSK)!.toISOString()).toBe('2026-07-18T16:00:00.000Z')
  })

  test('"завтра утром" is 09:00 local on the next calendar day', () => {
    // 09:00 MSK on the 18th == 06:00 UTC
    expect(resolveSlot('morning', now, MSK)!.toISOString()).toBe('2026-07-18T06:00:00.000Z')
  })

  test('"завтра утром" crosses the month correctly near local midnight', () => {
    // 2026-07-31 22:00 UTC is already 2026-08-01 01:00 MSK, so "tomorrow" is Aug 2.
    const nearMidnight = new Date('2026-07-31T22:00:00Z')
    expect(resolveSlot('morning', nearMidnight, MSK)!.toISOString()).toBe('2026-08-02T06:00:00.000Z')
  })

  test('none and custom carry no instant', () => {
    expect(resolveSlot('none', now, MSK)).toBeNull()
    expect(resolveSlot('custom', now, MSK)).toBeNull()
  })

  test('a slot never resolves into the past', () => {
    for (const at of ['2026-07-17T05:00:00Z', '2026-07-17T16:30:00Z', '2026-07-17T20:59:00Z']) {
      const t = new Date(at)
      for (const slot of ['30m', '1h', 'evening', 'morning'] as const) {
        expect(resolveSlot(slot, t, MSK)!.getTime()).toBeGreaterThan(t.getTime())
      }
    }
  })
})

describe('resolveSnooze', () => {
  const now = new Date('2026-07-17T09:00:00Z')

  test('offsets from now', () => {
    expect(resolveSnooze('15m', now)!.toISOString()).toBe('2026-07-17T09:15:00.000Z')
    expect(resolveSnooze('1h', now)!.toISOString()).toBe('2026-07-17T10:00:00.000Z')
    expect(resolveSnooze('custom', now)).toBeNull()
  })
})

describe('parseCustomDateTime', () => {
  const now = new Date('2026-07-17T09:00:00Z') // 12:00 MSK, Friday

  test('parses a date with time in the owner timezone', () => {
    expect(parseCustomDateTime('25.12 14:30', now, MSK)!.toISOString()).toBe('2026-12-25T11:30:00.000Z')
  })

  test('parses an explicit year', () => {
    expect(parseCustomDateTime('25.12.2027 09:00', now, MSK)!.toISOString()).toBe('2027-12-25T06:00:00.000Z')
    expect(parseCustomDateTime('25.12.27 09:00', now, MSK)!.toISOString()).toBe('2027-12-25T06:00:00.000Z')
  })

  test('a bare date defaults to 09:00 local', () => {
    expect(parseCustomDateTime('25.12', now, MSK)!.toISOString()).toBe('2026-12-25T06:00:00.000Z')
  })

  test('a bare time means today when still ahead', () => {
    // 18:45 MSK today == 15:45 UTC
    expect(parseCustomDateTime('18:45', now, MSK)!.toISOString()).toBe('2026-07-17T15:45:00.000Z')
  })

  test('a bare time that already passed rolls to tomorrow', () => {
    // 08:00 MSK today is behind 12:00 MSK now
    expect(parseCustomDateTime('08:00', now, MSK)!.toISOString()).toBe('2026-07-18T05:00:00.000Z')
  })

  test('a bare DD.MM that already passed this year means next year', () => {
    expect(parseCustomDateTime('01.01', now, MSK)!.toISOString()).toBe('2027-01-01T06:00:00.000Z')
  })

  test('rejects a past explicit date rather than scheduling it', () => {
    expect(parseCustomDateTime('01.01.2020 10:00', now, MSK)).toBeNull()
  })

  test('rejects impossible calendar dates', () => {
    expect(parseCustomDateTime('31.02 10:00', now, MSK)).toBeNull()
    expect(parseCustomDateTime('32.01 10:00', now, MSK)).toBeNull()
    expect(parseCustomDateTime('10.13 10:00', now, MSK)).toBeNull()
  })

  test('rejects impossible times', () => {
    expect(parseCustomDateTime('25:00', now, MSK)).toBeNull()
    expect(parseCustomDateTime('12:99', now, MSK)).toBeNull()
    expect(parseCustomDateTime('25.12 99:99', now, MSK)).toBeNull()
  })

  test('rejects free-form junk', () => {
    expect(parseCustomDateTime('завтра', now, MSK)).toBeNull()
    expect(parseCustomDateTime('', now, MSK)).toBeNull()
    expect(parseCustomDateTime('drop table tasks', now, MSK)).toBeNull()
  })

  test('accepts dot as a time separator and tolerates padding', () => {
    expect(parseCustomDateTime('  18.45  ', now, MSK)).not.toBeNull()
  })
})

describe('dayWindow', () => {
  test('covers the owner local day, not the UTC day', () => {
    // 22:00 UTC is already the next day in Moscow.
    const { from, to } = dayWindow(new Date('2026-07-17T22:00:00Z'), MSK)
    expect(from.toISOString()).toBe('2026-07-17T21:00:00.000Z') // 18 Jul 00:00 MSK
    expect(to.toISOString()).toBe('2026-07-18T21:00:00.000Z') // 19 Jul 00:00 MSK
  })

  test('is exactly 24h in a zone without DST', () => {
    const { from, to } = dayWindow(new Date('2026-07-17T09:00:00Z'), MSK)
    expect(to.getTime() - from.getTime()).toBe(24 * 3_600_000)
  })

  test('is 23h on a DST spring-forward day', () => {
    const { from, to } = dayWindow(new Date('2026-03-29T10:00:00Z'), BERLIN)
    expect(to.getTime() - from.getTime()).toBe(23 * 3_600_000)
  })
})

describe('parseNaturalLanguage', () => {
  const now = new Date('2026-07-17T09:00:00Z') // 12:00 MSK, Friday

  test('relative offsets', () => {
    expect(parseNaturalLanguage('через 30 минут', now, MSK)!.toISOString()).toBe('2026-07-17T09:30:00.000Z')
    expect(parseNaturalLanguage('через 3 часа', now, MSK)!.toISOString()).toBe('2026-07-17T12:00:00.000Z')
    expect(parseNaturalLanguage('через час', now, MSK)!.toISOString()).toBe('2026-07-17T10:00:00.000Z')
    expect(parseNaturalLanguage('через 2 дня', now, MSK)!.toISOString()).toBe('2026-07-19T09:00:00.000Z')
    expect(parseNaturalLanguage('через неделю', now, MSK)!.toISOString()).toBe('2026-07-24T09:00:00.000Z')
  })

  test('сегодня / завтра / послезавтра with a time', () => {
    // 18:00 MSK == 15:00 UTC
    expect(parseNaturalLanguage('завтра в 18', now, MSK)!.toISOString()).toBe('2026-07-18T15:00:00.000Z')
    expect(parseNaturalLanguage('завтра 18:30', now, MSK)!.toISOString()).toBe('2026-07-18T15:30:00.000Z')
    expect(parseNaturalLanguage('сегодня в 20', now, MSK)!.toISOString()).toBe('2026-07-17T17:00:00.000Z')
    expect(parseNaturalLanguage('послезавтра в 9', now, MSK)!.toISOString()).toBe('2026-07-19T06:00:00.000Z')
  })

  test('завтра alone defaults to the morning', () => {
    expect(parseNaturalLanguage('завтра', now, MSK)!.toISOString()).toBe('2026-07-18T06:00:00.000Z')
  })

  test('parts of the day', () => {
    expect(parseNaturalLanguage('завтра утром', now, MSK)!.toISOString()).toBe('2026-07-18T06:00:00.000Z')
    expect(parseNaturalLanguage('завтра вечером', now, MSK)!.toISOString()).toBe('2026-07-18T16:00:00.000Z')
    // "вечером" today: 19:00 MSK is still ahead of 12:00 MSK
    expect(parseNaturalLanguage('вечером', now, MSK)!.toISOString()).toBe('2026-07-17T16:00:00.000Z')
  })

  test('a today time that already passed is rejected', () => {
    expect(parseNaturalLanguage('сегодня в 8', now, MSK)).toBeNull()
  })

  test('month names', () => {
    expect(parseNaturalLanguage('1 августа 09:30', now, MSK)!.toISOString()).toBe('2026-08-01T06:30:00.000Z')
    expect(parseNaturalLanguage('25 декабря', now, MSK)!.toISOString()).toBe('2026-12-25T06:00:00.000Z')
    // a month/day already past this year rolls to next year
    expect(parseNaturalLanguage('1 января', now, MSK)!.toISOString()).toBe('2027-01-01T06:00:00.000Z')
  })

  test('bare clock times', () => {
    expect(parseNaturalLanguage('в 18', now, MSK)!.toISOString()).toBe('2026-07-17T15:00:00.000Z')
    expect(parseNaturalLanguage('18:30', now, MSK)!.toISOString()).toBe('2026-07-17T15:30:00.000Z')
    // 08:00 already passed -> tomorrow
    expect(parseNaturalLanguage('в 8', now, MSK)!.toISOString()).toBe('2026-07-18T05:00:00.000Z')
  })

  test('falls back to structured dates', () => {
    expect(parseNaturalLanguage('25.12 14:30', now, MSK)!.toISOString()).toBe('2026-12-25T11:30:00.000Z')
  })

  test('junk returns null', () => {
    expect(parseNaturalLanguage('когда-нибудь потом', now, MSK)).toBeNull()
    expect(parseNaturalLanguage('', now, MSK)).toBeNull()
    expect(parseNaturalLanguage('через много часов', now, MSK)).toBeNull()
  })
})

describe('splitTitleAndTime', () => {
  const now = new Date('2026-07-17T09:00:00Z') // 12:00 MSK Friday

  test('splits a trailing time phrase off the title', () => {
    const r = splitTitleAndTime('Купить хлеб завтра в 18', now, MSK)
    expect(r!.title).toBe('Купить хлеб')
    expect(r!.remindAt.toISOString()).toBe('2026-07-18T15:00:00.000Z')
  })

  test('handles "через" phrases', () => {
    const r = splitTitleAndTime('Позвонить врачу через 3 часа', now, MSK)
    expect(r!.title).toBe('Позвонить врачу')
    expect(r!.remindAt.toISOString()).toBe('2026-07-17T12:00:00.000Z')
  })

  test('handles month names and bare "в HH"', () => {
    expect(splitTitleAndTime('Оплатить счёт 1 августа 09:30', now, MSK)!.title).toBe('Оплатить счёт')
    const r = splitTitleAndTime('Позвонить маме в 9', now, MSK)
    expect(r!.title).toBe('Позвонить маме')
    expect(r!.remindAt.toISOString()).toBe('2026-07-18T06:00:00.000Z') // 9:00 passed today -> tomorrow
  })

  test('no time phrase -> null (whole text is the title)', () => {
    expect(splitTitleAndTime('Купить 5 яблок', now, MSK)).toBeNull()
    expect(splitTitleAndTime('Встреча в офисе', now, MSK)).toBeNull()
    expect(splitTitleAndTime('Помыть машину', now, MSK)).toBeNull()
  })

  test('a phrase with no title before it -> null', () => {
    expect(splitTitleAndTime('завтра в 18', now, MSK)).toBeNull()
  })
})

describe('calendar helpers', () => {
  test('addMonths wraps years', () => {
    expect(addMonths(2026, 8, 1)).toEqual({ year: 2026, month: 9 })
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(addMonths(2026, 3, -5)).toEqual({ year: 2025, month: 10 })
  })

  test('monthMatrix lays out a month Monday-first', () => {
    // August 2026: the 1st is a Saturday.
    const grid = monthMatrix(2026, 8)
    expect(grid[0]).toEqual([0, 0, 0, 0, 0, 1, 2]) // Mon..Sun, 1st on Saturday
    // every real day 1..31 appears exactly once
    const flat = grid.flat().filter((d) => d !== 0)
    expect(flat).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    // full weeks of 7
    for (const week of grid) expect(week).toHaveLength(7)
  })

  test('monthMatrix handles February in a leap year', () => {
    const flat = monthMatrix(2028, 2).flat().filter((d) => d !== 0)
    expect(flat).toHaveLength(29)
  })

  test('isBeforeToday greys only past days in the owner zone', () => {
    const now = new Date('2026-07-17T09:00:00Z') // 17 Jul MSK
    expect(isBeforeToday(2026, 7, 16, now, MSK)).toBe(true)
    expect(isBeforeToday(2026, 7, 17, now, MSK)).toBe(false)
    expect(isBeforeToday(2026, 7, 18, now, MSK)).toBe(false)
  })
})
