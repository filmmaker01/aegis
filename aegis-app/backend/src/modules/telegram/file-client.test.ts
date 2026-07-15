import { afterEach, describe, expect, test } from 'bun:test'

import { TelegramFileClient } from './file-client'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

interface Captured {
  url: string
  method?: string
  field?: string
  hasCaption: boolean
  chatId?: string
}

function mockFetch(): { calls: Captured[] } {
  const calls: Captured[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const cap: Captured = { url, hasCaption: false }
    const method = url.split('/').pop()
    cap.method = method
    if (init?.body instanceof FormData) {
      for (const [k, v] of (init.body as FormData).entries()) {
        if (k === 'chat_id') cap.chatId = String(v)
        else if (k === 'caption') cap.hasCaption = true
        else cap.field = k
      }
    }
    calls.push(cap)
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
  }) as typeof fetch
  return { calls }
}

describe('TelegramFileClient.sendMedia', () => {
  const client = new TelegramFileClient('123:TOKEN')
  const bytes = Buffer.from([1, 2, 3])

  test('routes each media type to the correct method + field', async () => {
    const { calls } = mockFetch()
    await client.sendMedia('photo', 700, bytes, { caption: 'c' })
    await client.sendMedia('video', 700, bytes, { caption: 'c' })
    await client.sendMedia('voice', 700, bytes, { caption: 'c' })
    await client.sendMedia('video_note', 700, bytes, { caption: 'c' })
    await client.sendMedia('document', 700, bytes, { caption: 'c' })

    expect(calls.map((c) => c.method)).toEqual([
      'sendPhoto',
      'sendVideo',
      'sendVoice',
      'sendVideoNote',
      'sendDocument',
    ])
    expect(calls.map((c) => c.field)).toEqual(['photo', 'video', 'voice', 'video_note', 'document'])
    // video_note does not carry a caption; the others do
    expect(calls.map((c) => c.hasCaption)).toEqual([true, true, true, false, true])
    expect(calls.every((c) => c.chatId === '700')).toBe(true)
  })

  test('reports failure status', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'nope' }), {
        status: 400,
      })) as unknown as typeof fetch
    const res = await client.sendMedia('photo', 700, bytes)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })
})
