import { describe, expect, test } from 'bun:test'

import { validateDigitalOceanCronSchedule } from './do-cron.mjs'

describe('validateDigitalOceanCronSchedule', () => {
  test('accepts schedules at or above DigitalOcean scheduled job cadence', () => {
    expect(validateDigitalOceanCronSchedule('*/15 * * * *')).toBe('*/15 * * * *')
    expect(validateDigitalOceanCronSchedule('0,15,30,45 * * * *')).toBe('0,15,30,45 * * * *')
    expect(validateDigitalOceanCronSchedule('0 3 * * *')).toBe('0 3 * * *')
    expect(validateDigitalOceanCronSchedule('0 3 1,15 1-12/2 1-5')).toBe('0 3 1,15 1-12/2 1-5')
  })

  test('rejects schedules that run more often than every 15 minutes', () => {
    expect(() => validateDigitalOceanCronSchedule('* * * * *')).toThrow('15 minutes')
    expect(() => validateDigitalOceanCronSchedule('*/5 * * * *')).toThrow('15 minutes')
    expect(() => validateDigitalOceanCronSchedule('0,10,30 * * * *')).toThrow('15 minutes')
    expect(() => validateDigitalOceanCronSchedule('0,50 * * * *')).toThrow('15 minutes')
  })

  test('rejects malformed minute or hour fields', () => {
    expect(() => validateDigitalOceanCronSchedule('0 0 1')).toThrow('five-field')
    expect(() => validateDigitalOceanCronSchedule('*/0 * * * *')).toThrow('positive')
    expect(() => validateDigitalOceanCronSchedule('60 * * * *')).toThrow('between 0 and 59')
  })

  test('rejects malformed day, month, or day-of-week fields', () => {
    expect(() => validateDigitalOceanCronSchedule('0 3 nope * *')).toThrow('day-of-month field')
    expect(() => validateDigitalOceanCronSchedule('0 3 0 * *')).toThrow('between 1 and 31')
    expect(() => validateDigitalOceanCronSchedule('0 3 * 13 *')).toThrow('between 1 and 12')
    expect(() => validateDigitalOceanCronSchedule('0 3 * * 8')).toThrow('between 0 and 7')
    expect(() => validateDigitalOceanCronSchedule('0 3 * * MON')).toThrow('day-of-week field')
  })
})
