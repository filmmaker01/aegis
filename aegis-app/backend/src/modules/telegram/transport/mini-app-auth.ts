import { createMiddleware } from 'hono/factory'

import { verifyTelegramInitData } from '../init-data'

export interface MiniAppPrincipal {
  tgUserId: number
}

export type MiniAppHttpEnv = {
  Variables: {
    principal: MiniAppPrincipal
  }
}

function extractInitData(authorization: string | undefined, headerInitData: string | undefined): string | undefined {
  // Telegram convention: Authorization: "tma <initData>"
  if (authorization?.startsWith('tma ')) return authorization.slice(4)
  return headerInitData
}

/**
 * Guards Mini App API routes. Validates Telegram `initData` server-side (HMAC +
 * auth_date freshness) and exposes the verified Telegram user id as the principal.
 * Client-sent identity is never trusted — only the HMAC-verified `user` is used.
 */
export function createMiniAppAuth(botToken: string | undefined, maxAgeSeconds: number) {
  return createMiddleware<MiniAppHttpEnv>(async (c, next) => {
    if (!botToken) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Telegram bot token not configured' } }, 503)
    }
    const initData = extractInitData(c.req.header('authorization'), c.req.header('x-telegram-init-data'))
    if (!initData) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing Telegram initData' } }, 401)
    }
    const result = verifyTelegramInitData(initData, botToken, { maxAgeSeconds })
    if (!result.ok) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: `initData invalid: ${result.reason}` } }, 401)
    }
    const userId = typeof result.user?.['id'] === 'number' ? (result.user['id'] as number) : undefined
    if (userId === undefined) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'initData has no user id' } }, 401)
    }
    c.set('principal', { tgUserId: userId })
    await next()
  })
}
