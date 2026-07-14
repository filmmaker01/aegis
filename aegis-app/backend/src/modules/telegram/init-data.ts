import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Telegram Mini App `initData` verification.
 *
 * Self-contained module: no DB, no routes, no framework coupling. It implements
 * the official algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   secret_key    = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   data_check    = join("\n", sorted("key=value" for each field except `hash`))
 *   expected_hash = hex(HMAC_SHA256(key=secret_key, msg=data_check))
 *   valid         = timingSafeEqual(expected_hash, received_hash) && fresh(auth_date)
 *
 * The bot token is a secret — it is only ever used here on the server and never
 * returned to the caller.
 */

export interface VerifyInitDataOptions {
  /** Reject if auth_date is older than this many seconds. Default 3600 (1h). Set 0 to skip. */
  maxAgeSeconds?: number
  /** Injectable clock (unix ms) for tests. */
  now?: () => number
}

export interface VerifiedInitData {
  ok: true
  /** Decoded fields (without `hash`). */
  fields: Record<string, string>
  /** Parsed `user` field if present and valid JSON. */
  user?: Record<string, unknown>
  authDate: Date
}

export interface FailedInitData {
  ok: false
  reason:
    | 'empty'
    | 'missing_hash'
    | 'bad_hash'
    | 'missing_auth_date'
    | 'invalid_auth_date'
    | 'expired'
}

export type VerifyInitDataResult = VerifiedInitData | FailedInitData

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  options: VerifyInitDataOptions = {},
): VerifyInitDataResult {
  const { maxAgeSeconds = 3600, now = Date.now } = options

  if (!initData || initData.trim() === '') return { ok: false, reason: 'empty' }

  const params = new URLSearchParams(initData)
  const receivedHash = params.get('hash')
  if (!receivedHash) return { ok: false, reason: 'missing_hash' }

  const pairs: string[] = []
  const fields: Record<string, string> = {}
  for (const [key, value] of params) {
    if (key === 'hash') continue
    fields[key] = value
    pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  const dataCheckString = pairs.join('\n')

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')

  if (!hexEqual(expectedHash, receivedHash)) return { ok: false, reason: 'bad_hash' }

  const authDateRaw = fields['auth_date']
  if (!authDateRaw) return { ok: false, reason: 'missing_auth_date' }
  const authDateSec = Number(authDateRaw)
  if (!Number.isFinite(authDateSec) || authDateSec <= 0)
    return { ok: false, reason: 'invalid_auth_date' }

  if (maxAgeSeconds > 0) {
    const ageSeconds = now() / 1000 - authDateSec
    if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'expired' }
  }

  let user: Record<string, unknown> | undefined
  if (fields['user']) {
    try {
      user = JSON.parse(fields['user']) as Record<string, unknown>
    } catch {
      // Non-fatal: hash already proved integrity; leave user undefined if unparseable.
    }
  }

  return { ok: true, fields, user, authDate: new Date(authDateSec * 1000) }
}
