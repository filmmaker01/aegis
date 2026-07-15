import { describe, expect, test } from 'bun:test'

import type { SendResult, TelegramFileClient } from '../../telegram/file-client'
import type { DeletionNotification } from '../application/ports'
import type { MediaStorage } from '../media/storage'
import { TelegramNotifier } from './telegram-notifier'

class FakeStorage implements MediaStorage {
  readonly kind = 'local' as const
  constructor(private readonly present = true) {}
  async put(): Promise<void> {}
  async get(key: string): Promise<Buffer> {
    if (!this.present) throw new Error('missing')
    return Buffer.from(`bytes:${key}`)
  }
}

interface Call {
  method: 'sendMessage' | 'sendMedia'
  type?: string
  text?: string
}

function fakeFileClient(mediaOk = true): { client: TelegramFileClient; calls: Call[] } {
  const calls: Call[] = []
  const ok: SendResult = { ok: true, status: 200 }
  const client = {
    async sendMessage(_chatId: number, text: string) {
      calls.push({ method: 'sendMessage', text })
      return ok
    },
    async sendMedia(type: string) {
      calls.push({ method: 'sendMedia', type })
      return mediaOk ? ok : { ok: false, status: 400 }
    },
  } as unknown as TelegramFileClient
  return { client, calls }
}

const OWNER = 700
const CHAT = 5001

function notification(overrides: Partial<DeletionNotification> = {}): DeletionNotification {
  return {
    connectionId: 'c1',
    ownerTgChatId: OWNER,
    tgChatId: CHAT,
    tgMessageId: 42,
    savedText: 'caption text',
    hasMedia: true,
    media: [{ mediaId: 'm1', type: 'photo', storageKey: 'media/c1/42/m1.jpg', fileName: 'p.jpg', mimeType: 'image/jpeg' }],
    archived: true,
    ...overrides,
  }
}

describe('TelegramNotifier (media-aware)', () => {
  test('sends text header + the stored media via type-specific method, to owner chat', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    await notifier.notifyDeletion(notification())
    expect(calls[0]?.method).toBe('sendMessage')
    expect(calls.some((c) => c.method === 'sendMedia' && c.type === 'photo')).toBe(true)
    // no failure -> no extra error text
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
  })

  test('honest text fallback when media send fails', async () => {
    const { client, calls } = fakeFileClient(false) // sendMedia returns not-ok
    const notifier = new TelegramNotifier(client, new FakeStorage(true), 1)
    await notifier.notifyDeletion(notification())
    const texts = calls.filter((c) => c.method === 'sendMessage').map((c) => c.text ?? '')
    expect(texts.some((t) => t.includes("Couldn't re-send"))).toBe(true)
  })

  test('fallback when the stored blob is missing', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(false), 1)
    await notifier.notifyDeletion(notification())
    // media never sent (blob missing) -> error text present
    expect(calls.some((c) => c.method === 'sendMedia')).toBe(false)
    expect(calls.some((c) => c.method === 'sendMessage' && (c.text ?? '').includes("Couldn't re-send"))).toBe(true)
  })

  test('text-only deletion (no media) sends a single message', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    await notifier.notifyDeletion(notification({ hasMedia: false, media: [] }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('sendMessage')
  })
})
