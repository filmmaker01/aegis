import { describe, expect, test } from 'bun:test'

import type { SendResult } from '../../telegram'
import { classifySendResult } from './telegram-notifier'

const fail = (status: number, description?: string, retryAfterSeconds?: number): SendResult => ({
  ok: false,
  status,
  ...(description ? { description } : {}),
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
})

describe('classifySendResult', () => {
  test('a successful send is sent', () => {
    expect(classifySendResult({ ok: true, status: 200, messageId: 7 })).toEqual({ outcome: 'sent' })
  })

  test('a blocked bot is permanent — retrying can never help', () => {
    expect(classifySendResult(fail(403, 'Forbidden: bot was blocked by the user'))).toEqual({
      outcome: 'permanent',
      reason: 'blocked_by_user',
    })
  })

  test('a deactivated user and a missing chat are permanent', () => {
    expect(classifySendResult(fail(403, 'Forbidden: user is deactivated')).outcome).toBe('permanent')
    expect(classifySendResult(fail(400, 'Bad Request: chat not found')).outcome).toBe('permanent')
  })

  test('any unrecognised 403 is still permanent', () => {
    expect(classifySendResult(fail(403, 'Forbidden: something new')).outcome).toBe('permanent')
  })

  test('an unrecognised 400 is permanent — a retry would be byte-identical', () => {
    expect(classifySendResult(fail(400, 'Bad Request: message text is empty'))).toEqual({
      outcome: 'permanent',
      reason: 'bad_request',
    })
  })

  test('a 429 is a retry and carries retry_after through', () => {
    expect(classifySendResult(fail(429, 'Too Many Requests: retry after 30', 30))).toEqual({
      outcome: 'retry',
      reason: 'rate_limited',
      retryAfterSeconds: 30,
    })
  })

  test('a 429 without retry_after is still a retry', () => {
    expect(classifySendResult(fail(429, 'Too Many Requests'))).toEqual({
      outcome: 'retry',
      reason: 'rate_limited',
    })
  })

  test('server errors are transient', () => {
    expect(classifySendResult(fail(500)).outcome).toBe('retry')
    expect(classifySendResult(fail(502)).outcome).toBe('retry')
    expect(classifySendResult(fail(503, 'Service Unavailable'))).toEqual({
      outcome: 'retry',
      reason: 'http_503',
    })
  })

  test('a permanent description wins over the status code', () => {
    // Telegram has been known to return 400 for a blocked bot.
    expect(classifySendResult(fail(400, 'Forbidden: bot was blocked by the user')).outcome).toBe('permanent')
  })
})
