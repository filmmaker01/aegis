import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import { verifyTelegramInitData } from './init-data'

const BOT_TOKEN = '123456:TEST_TOKEN_do_not_use_in_prod'

/** Sign fields the same way Telegram does, to produce valid test initData. */
function signInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const params = new URLSearchParams(fields)
  const pairs = [...params]
    .filter(([k]) => k !== 'hash')
    .map(([k, v]) => `${k}=${v}`)
    .sort()
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

describe('verifyTelegramInitData', () => {
  const nowSec = 1_800_000_000
  const now = () => nowSec * 1000

  test('accepts correctly signed initData and parses user', () => {
    const initData = signInitData({
      auth_date: String(nowSec - 10),
      query_id: 'AAA',
      user: JSON.stringify({ id: 42, first_name: 'Ada', username: 'ada' }),
    })
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.user?.id).toBe(42)
      expect(result.authDate.getTime()).toBe((nowSec - 10) * 1000)
    }
  })

  test('rejects tampered data (hash no longer matches)', () => {
    const initData = signInitData({
      auth_date: String(nowSec - 10),
      user: JSON.stringify({ id: 42, first_name: 'Ada' }),
    })
    const tampered = initData.replace('%22id%22%3A42', '%22id%22%3A999')
    const result = verifyTelegramInitData(tampered, BOT_TOKEN, { now })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hash')
  })

  test('rejects a hash signed with a different bot token', () => {
    const initData = signInitData({ auth_date: String(nowSec - 10) }, 'other:WRONG_TOKEN')
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad_hash')
  })

  test('rejects stale initData past maxAgeSeconds', () => {
    const initData = signInitData({ auth_date: String(nowSec - 7200) })
    const result = verifyTelegramInitData(initData, BOT_TOKEN, { now, maxAgeSeconds: 3600 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('expired')
  })

  test('rejects missing hash and empty input', () => {
    expect(verifyTelegramInitData('auth_date=1', BOT_TOKEN, { now }).ok).toBe(false)
    expect(verifyTelegramInitData('', BOT_TOKEN, { now }).ok).toBe(false)
  })
})
