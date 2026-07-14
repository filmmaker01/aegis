import { Hono } from 'hono'

import { createMiniAppAuth, type MiniAppHttpEnv } from '../../telegram/transport/mini-app-auth'
import type { QueryService } from '../application/query-service'

export interface ReadRoutesOptions {
  query: QueryService
  botToken: string | undefined
  initDataMaxAgeSeconds: number
}

/**
 * Mini App read API. Every route is guarded by initData verification and scoped
 * to the verified Telegram user id (the owner).
 */
export function createReadRoutes({ query, botToken, initDataMaxAgeSeconds }: ReadRoutesOptions) {
  const app = new Hono<MiniAppHttpEnv>()
  app.use('*', createMiniAppAuth(botToken, initDataMaxAgeSeconds))

  app.get('/overview', async (c) => {
    return c.json(await query.overview(c.get('principal').tgUserId))
  })

  app.get('/chats', async (c) => {
    return c.json({ items: await query.chats(c.get('principal').tgUserId) })
  })

  app.get('/deleted', async (c) => {
    const limitRaw = c.req.query('limit')
    const limit = limitRaw ? Number(limitRaw) : undefined
    return c.json({ items: await query.deleted(c.get('principal').tgUserId, limit) })
  })

  app.get('/messages/:chatId/:messageId', async (c) => {
    const chatId = Number(c.req.param('chatId'))
    const messageId = Number(c.req.param('messageId'))
    if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid ids' } }, 400)
    }
    const message = await query.message(c.get('principal').tgUserId, chatId, messageId)
    if (!message) return c.json({ error: { code: 'NOT_FOUND', message: 'Message not found' } }, 404)
    return c.json(message)
  })

  return app
}
