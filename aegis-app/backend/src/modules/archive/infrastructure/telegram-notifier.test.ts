import { describe, expect, test } from 'bun:test'

import type { InlineKeyboardMarkup, SendResult, TelegramFileClient } from '../../telegram/file-client'
import type {
  BatchDeletionNotification,
  DeletionNotification,
  EditNotification,
} from '../application/ports'
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
  caption?: string
  replyMarkup?: InlineKeyboardMarkup
}

function fakeFileClient(mediaOk = true): { client: TelegramFileClient; calls: Call[] } {
  const calls: Call[] = []
  const ok: SendResult = { ok: true, status: 200 }
  const client = {
    async sendMessage(_chatId: number, text: string, opts?: { replyMarkup?: InlineKeyboardMarkup }) {
      calls.push({ method: 'sendMessage', text, replyMarkup: opts?.replyMarkup })
      return ok
    },
    async sendMedia(type: string, _chatId: number, _bytes: Buffer, opts?: { caption?: string }) {
      calls.push({ method: 'sendMedia', type, caption: opts?.caption })
      return mediaOk ? ok : { ok: false, status: 400 }
    },
  } as unknown as TelegramFileClient
  return { client, calls }
}

const OWNER = 700
const CHAT = 5001
const AT = new Date('2026-07-14T12:00:00Z')

function deletion(overrides: Partial<DeletionNotification> = {}): DeletionNotification {
  return {
    connectionId: 'c1',
    ownerTgChatId: OWNER,
    tgChatId: CHAT,
    tgMessageId: 42,
    eventId: 'ev-1',
    messageId: 'msg-1',
    savedText: 'caption text',
    hasMedia: true,
    hasHistory: false,
    media: [{ mediaId: 'm1', type: 'photo', storageKey: 'media/c1/42/m1.jpg', fileName: 'p.jpg', mimeType: 'image/jpeg' }],
    archived: true,
    peerTitle: 'Partner',
    peerUsername: 'partner',
    at: AT,
    ...overrides,
  }
}

const textOf = (calls: Call[]) => calls.filter((c) => c.method === 'sendMessage').map((c) => c.text ?? '')

describe('TelegramNotifier (Russian cards + buttons)', () => {
  test('media deletion: lead card (with buttons) then the stored file (HTML, to owner chat)', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    await notifier.notifyDeletion(deletion())
    expect(calls[0]?.method).toBe('sendMessage')
    // lead card carries the action keyboard
    expect(calls[0]?.replyMarkup?.inline_keyboard.length).toBeGreaterThan(0)
    expect(calls.some((c) => c.method === 'sendMedia' && c.type === 'photo')).toBe(true)
    // no failure -> only the lead card as text
    expect(textOf(calls)).toHaveLength(1)
  })

  test('text-only deletion sends one Russian card with a Restore button', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    await notifier.notifyDeletion(deletion({ hasMedia: false, media: [] }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('sendMessage')
    expect(calls[0]?.text).toContain('удалено')
    const buttons = calls[0]?.replyMarkup?.inline_keyboard.flat().map((b) => b.text) ?? []
    expect(buttons).toContain('Восстановить')
  })

  test('unarchived deletion has no Restore button and an honest note', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    await notifier.notifyDeletion(deletion({ archived: false, hasMedia: false, media: [], savedText: null }))
    expect(calls).toHaveLength(1)
    const buttons = calls[0]?.replyMarkup?.inline_keyboard.flat().map((b) => b.text) ?? []
    expect(buttons).not.toContain('Восстановить')
    expect(calls[0]?.text).toContain('не сохранена')
  })

  test('history button shown only when hasHistory', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    await notifier.notifyDeletion(deletion({ hasMedia: false, media: [], hasHistory: true }))
    const buttons = calls[0]?.replyMarkup?.inline_keyboard.flat().map((b) => b.text) ?? []
    expect(buttons).toContain('История изменений')
  })

  test('honest note when the stored blob is missing', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(false), 1)
    await notifier.notifyDeletion(deletion())
    expect(calls.some((c) => c.method === 'sendMedia')).toBe(false)
    expect(textOf(calls).some((t) => t.includes('Не удалось переслать'))).toBe(true)
  })

  test('edit notification renders before/after with a keyboard', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    const edit: EditNotification = {
      connectionId: 'c1',
      ownerTgChatId: OWNER,
      tgChatId: CHAT,
      tgMessageId: 42,
      messageId: 'msg-1',
      before: 'old <b>value</b>',
      after: 'new value',
      peerTitle: 'Partner',
      at: AT,
    }
    await notifier.notifyEdit(edit)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toContain('изменено')
    // HTML special chars in the saved text must be escaped, not interpreted.
    expect(calls[0]?.text).toContain('&lt;b&gt;')
    expect(calls[0]?.replyMarkup?.inline_keyboard.length).toBeGreaterThan(0)
  })

  test('batch notification renders one grouped card', async () => {
    const { client, calls } = fakeFileClient(true)
    const notifier = new TelegramNotifier(client, new FakeStorage(true))
    const batch: BatchDeletionNotification = {
      connectionId: 'c1',
      ownerTgChatId: OWNER,
      tgChatId: CHAT,
      eventId: 'ev-1',
      count: 3,
      previews: [{ savedText: 'a' }, { savedText: 'b' }, { mediaTypes: ['photo'] }],
      peerTitle: 'Partner',
      at: AT,
    }
    await notifier.notifyBatchDeletion(batch)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toContain('Удалено 3')
  })
})
