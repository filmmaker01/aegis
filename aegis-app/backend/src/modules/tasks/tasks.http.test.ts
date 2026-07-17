import { describe, expect, test } from 'bun:test'

import { createWebhookRoutes, type UpdateHandler } from '../telegram'

const SECRET = 'whsec-test'
const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

function handlerSpy() {
  const seen: string[] = []
  const handler: UpdateHandler = {
    async claim() {
      return true
    },
    async onMessage(m) {
      seen.push(`message:${m.text}`)
    },
    async onCallback(c) {
      seen.push(`callback:${c.data}`)
    },
  }
  return { handler, seen }
}

const update = {
  update_id: 1,
  message: { message_id: 7, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/start' },
}

function post(app: ReturnType<typeof createWebhookRoutes>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('telegram webhook', () => {
  test('accepts an update carrying the right secret token', async () => {
    const { handler, seen } = handlerSpy()
    const app = createWebhookRoutes({ handler, webhookSecret: SECRET })

    const res = await post(app, update, { [SECRET_HEADER]: SECRET })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, handled: 'message' })
    expect(seen).toEqual(['message:/start'])
  })

  test('rejects a wrong or missing secret token without reaching the bot', async () => {
    const { handler, seen } = handlerSpy()
    const app = createWebhookRoutes({ handler, webhookSecret: SECRET })

    expect((await post(app, update, { [SECRET_HEADER]: 'wrong' })).status).toBe(401)
    expect((await post(app, update)).status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  test('returns 503 when the bot is not configured', async () => {
    const { handler } = handlerSpy()
    expect((await post(createWebhookRoutes({ handler, webhookSecret: undefined }), update)).status).toBe(503)
    expect(
      (await post(createWebhookRoutes({ handler: undefined, webhookSecret: SECRET }), update, {
        [SECRET_HEADER]: SECRET,
      })).status,
    ).toBe(503)
  })

  test('rejects malformed bodies', async () => {
    const { handler } = handlerSpy()
    const app = createWebhookRoutes({ handler, webhookSecret: SECRET })

    expect((await post(app, 'not json', { [SECRET_HEADER]: SECRET })).status).toBe(400)
    expect((await post(app, { hello: 'world' }, { [SECRET_HEADER]: SECRET })).status).toBe(400)
  })

  test('returns 500 so Telegram retries when processing throws', async () => {
    const handler: UpdateHandler = {
      async claim() {
        return true
      },
      async onMessage() {
        throw new Error('db down')
      },
      async onCallback() {},
    }
    const app = createWebhookRoutes({ handler, webhookSecret: SECRET })

    const res = await post(app, update, { [SECRET_HEADER]: SECRET })
    expect(res.status).toBe(500)
  })
})
