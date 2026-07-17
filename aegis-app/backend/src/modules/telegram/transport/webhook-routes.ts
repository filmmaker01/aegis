import { Hono } from 'hono'

import { recordWebhookError } from '../../../monitoring'
import { dispatchUpdate, type RawUpdate, type UpdateHandler } from '../updates'

const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

export interface WebhookRoutesOptions {
  /** Handles parsed updates. Absent when no bot token is configured. */
  handler: UpdateHandler | undefined
  webhookSecret: string | undefined
}

/**
 * Telegram webhook ingress. Verifies the secret token, then dispatches the
 * update to the bot service. Returns 200 on success; 500 on processing error
 * so Telegram retries (idempotency via update_id makes retries safe). Returns
 * 401 on a bad/missing secret so forged requests can't reach the bot.
 */
export function createWebhookRoutes({ handler, webhookSecret }: WebhookRoutesOptions) {
  const app = new Hono()

  app.post('/', async (c) => {
    if (!webhookSecret || !handler) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Webhook not configured' } }, 503)
    }
    if (c.req.header(SECRET_HEADER) !== webhookSecret) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Bad secret token' } }, 401)
    }

    let update: RawUpdate
    try {
      update = (await c.req.json()) as RawUpdate
    } catch {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON' } }, 400)
    }
    if (typeof update?.update_id !== 'number') {
      return c.json({ error: { code: 'BAD_REQUEST', message: 'Not a Telegram Update' } }, 400)
    }

    try {
      const handled = await dispatchUpdate(update, handler)
      return c.json({ ok: true, handled }, 200)
    } catch (err) {
      recordWebhookError()
      console.error('[webhook] processing failed for update', update.update_id, (err as Error).name)
      return c.json({ error: { code: 'INTERNAL', message: 'Processing failed' } }, 500)
    }
  })

  return app
}
