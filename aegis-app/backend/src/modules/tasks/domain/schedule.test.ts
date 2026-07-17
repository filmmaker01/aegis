import { describe, expect, test } from 'bun:test'

import {
  dayWindow,
  fromWallClock,
  isValidTimeZone,
  parseCustomDateTime,
  resolveSlot,
  resolveSnooze,
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
