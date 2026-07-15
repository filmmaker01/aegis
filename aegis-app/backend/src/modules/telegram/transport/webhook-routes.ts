import { Hono } from 'hono'

import type { IngestService } from '../../archive/application/ingest-service'
import { recordWebhookError } from '../../../monitoring'
import { dispatchUpdate, type CallbackHandler, type RawUpdate } from '../updates'

const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

export interface WebhookRoutesOptions {
  ingest: IngestService
  webhookSecret: string | undefined
  /** Handles inline-button presses (callback_query). Optional (no bot token = no client). */
  callback?: CallbackHandler
}

/**
 * Telegram webhook ingress. Verifies the secret token, then dispatches the
 * update to the ingest service. Returns 200 on success; 500 on processing error
 * so Telegram retries (idempotency via update_id makes retries safe). Returns
 * 401 on a bad/missing secret so forged requests can't reach ingestion.
 */
export function createWebhookRoutes({ ingest, webhookSecret, callback }: WebhookRoutesOptions) {
  const app = new Hono()

  app.post('/', async (c) => {
    if (!webhookSecret) {
      return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Webhook secret not configured' } }, 503)
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
      const handled = await dispatchUpdate(update, ingest, callback)
      return c.json({ ok: true, handled }, 200)
    } catch (err) {
      recordWebhookError()
      console.error('[webhook] processing failed for update', update.update_id, (err as Error).name)
      return c.json({ error: { code: 'INTERNAL', message: 'Processing failed' } }, 500)
    }
  })

  return app
}
