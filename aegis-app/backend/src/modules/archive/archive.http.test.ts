import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'bun:test'

import type { AppEnv } from '../../env'
import { createArchiveModule } from './index'

const BOT_TOKEN = '123456:TEST_TOKEN'
const SECRET = 'webhook-secret'
const OWNER = 700
const PARTNER = 5001
const CONN = 'conn-http-1'

const env = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_INITDATA_MAX_AGE_SECONDS: undefined,
} as unknown as AppEnv

function signedInitData(userId: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Owner' }),
  })
  const pairs = [...params].map(([k, v]) => `${k}=${v}`).sort()
  const secretKey = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

function webhookPost(mod: ReturnType<typeof createArchiveModule>, body: unknown, secret = SECRET) {
  return mod.webhookRoutes.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(body),
  })
}

describe('archive HTTP wiring (in-memory)', () => {
  test('webhook ingests, read API returns archived + deleted with saved content', async () => {
    const mod = createArchiveModule({ env, notifier: { async notifyDeletion() {}, async notifyEdit() {}, async notifyBatchDeletion() {} } }) // no db -> in-memory

    // 1. connection
    let res = await webhookPost(mod, {
      update_id: 1,
      business_connection: { id: CONN, user: { id: OWNER }, user_chat_id: OWNER, date: 1784066388, is_enabled: true, rights: {} },
    })
    expect(res.status).toBe(200)

    // 2. incoming message
    res = await webhookPost(mod, {
      update_id: 2,
      business_message: { message_id: 935359, business_connection_id: CONN, from: { id: PARTNER }, chat: { id: PARTNER, type: 'private', first_name: 'Partner' }, date: 1784067576, text: 'secret text' },
    })
    expect(res.status).toBe(200)

    // 3. deletion
    res = await webhookPost(mod, {
      update_id: 3,
      deleted_business_messages: { business_connection_id: CONN, chat: { id: PARTNER }, message_ids: [935359] },
    })
    expect(res.status).toBe(200)

    // read API (with initData)
    const auth = { headers: { Authorization: `tma ${signedInitData(OWNER)}` } }
    const overview = await (await mod.readRoutes.request('/overview', auth)).json()
    expect(overview).toMatchObject({ messages: 1, deleted: 1, chats: 1 })

    const deleted = (await (await mod.readRoutes.request('/deleted', auth)).json()) as {
      items: Array<{ savedText: string; tgMessageId: number; archived: boolean }>
    }
    expect(deleted.items).toHaveLength(1)
    expect(deleted.items[0]?.savedText).toBe('secret text')
    expect(deleted.items[0]?.archived).toBe(true)
  })

  test('webhook rejects a bad secret token', async () => {
    const mod = createArchiveModule({ env, notifier: { async notifyDeletion() {}, async notifyEdit() {}, async notifyBatchDeletion() {} } })
    const res = await webhookPost(mod, { update_id: 9, business_connection: { id: CONN, user: { id: OWNER }, user_chat_id: OWNER, is_enabled: true } }, 'wrong')
    expect(res.status).toBe(401)
  })

  test('read API rejects missing initData', async () => {
    const mod = createArchiveModule({ env, notifier: { async notifyDeletion() {}, async notifyEdit() {}, async notifyBatchDeletion() {} } })
    const res = await mod.readRoutes.request('/overview')
    expect(res.status).toBe(401)
  })
})
