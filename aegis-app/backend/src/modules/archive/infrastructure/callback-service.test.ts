import { beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryArchiveRepository } from './in-memory-repository'
import { CallbackService } from './callback-service'
import type { SendResult, TelegramFileClient } from '../../telegram/file-client'
import type { MediaStorage } from '../media/storage'
import type { IncomingBusinessConnection, IncomingCallback } from '../domain/types'
import type { SaveMessageVersionInput } from '../application/ports'

const OWNER = 700
const OWNER_CHAT = 700
const CHAT = 5001
const CONN = 'conn-cb'

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: OWNER,
  tgUserChatId: OWNER_CHAT,
  rights: {},
  isEnabled: true,
  connectedAt: new Date('2026-07-14T00:00:00Z'),
}

function save(id: number, text: string | null, extra: Partial<SaveMessageVersionInput> = {}): SaveMessageVersionInput {
  return {
    connectionId: CONN,
    tgChatId: CHAT,
    tgMessageId: id,
    direction: 'incoming',
    sentAt: new Date('2026-07-14T10:00:00Z'),
    text,
    hasMedia: false,
    media: [],
    peerTitle: 'Partner',
    raw: {},
    ...extra,
  }
}

interface Call {
  method: 'sendMessage' | 'sendMedia' | 'answer'
  chatId?: number
  text?: string
  type?: string
  showAlert?: boolean
}

class FakeStorage implements MediaStorage {
  readonly kind = 'local' as const
  constructor(private readonly present = true) {}
  async put(): Promise<void> {}
  async get(key: string): Promise<Buffer> {
    if (!this.present) throw new Error('missing')
    return Buffer.from(`bytes:${key}`)
  }
}

function fakeClient(): { client: TelegramFileClient; calls: Call[] } {
  const calls: Call[] = []
  const ok: SendResult = { ok: true, status: 200 }
  const client = {
    async sendMessage(chatId: number, text: string) {
      calls.push({ method: 'sendMessage', chatId, text })
      return ok
    },
    async sendMedia(type: string, chatId: number) {
      calls.push({ method: 'sendMedia', chatId, type })
      return ok
    },
    async answerCallbackQuery(_id: string, opts?: { text?: string; showAlert?: boolean }) {
      calls.push({ method: 'answer', text: opts?.text, showAlert: opts?.showAlert })
      return ok
    },
  } as unknown as TelegramFileClient
  return { client, calls }
}

function cb(data: string, fromTgId = OWNER): IncomingCallback {
  return { id: 'cbid', fromTgId, chatId: OWNER_CHAT, messageId: 111, data }
}

const answersOf = (calls: Call[]) => calls.filter((c) => c.method === 'answer').map((c) => c.text)

let repo: InMemoryArchiveRepository

beforeEach(async () => {
  repo = new InMemoryArchiveRepository(() => new Date('2026-07-14T12:00:00Z'))
  await repo.upsertConnection(connection)
  await repo.upsertChat({ connectionId: CONN, tgChatId: CHAT, peerTitle: 'Partner', peerUsername: 'partner' })
})

describe('CallbackService — restore', () => {
  test('owner restores a deleted text message: re-sends copy to owner chat + answers', async () => {
    await repo.saveMessageVersion(save(1, 'secret text'))
    const { eventId } = await repo.recordDeletion(CONN, CHAT, 1, new Date())
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())

    await svc.handle(cb(`restore:${eventId}`))

    const msgs = calls.filter((c) => c.method === 'sendMessage')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.chatId).toBe(OWNER_CHAT)
    expect(msgs[0]?.text).toBe('secret text') // re-sent as plain text (not escaped/marked up)
    expect(answersOf(calls)).toContain('Восстановлено')
  })

  test('repeat Restore press is safe and says "Уже восстановлено" (no second re-send)', async () => {
    await repo.saveMessageVersion(save(1, 'secret text'))
    const { eventId } = await repo.recordDeletion(CONN, CHAT, 1, new Date())
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())

    await svc.handle(cb(`restore:${eventId}`))
    await svc.handle(cb(`restore:${eventId}`))

    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
    expect(answersOf(calls)).toEqual(['Восстановлено', 'Уже восстановлено'])
  })

  test('foreign user gets a neutral "Недоступно" and nothing is re-sent (anti-enumeration)', async () => {
    await repo.saveMessageVersion(save(1, 'secret text'))
    const { eventId } = await repo.recordDeletion(CONN, CHAT, 1, new Date())
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())

    await svc.handle(cb(`restore:${eventId}`, 999_999)) // not the owner

    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(answersOf(calls)).toEqual(['Недоступно'])
  })

  test('unknown/invalid event id -> "Недоступно"', async () => {
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())
    await svc.handle(cb('restore:not-a-real-id'))
    expect(answersOf(calls)).toEqual(['Недоступно'])
  })

  test('unarchived deletion -> "Копия не была сохранена"', async () => {
    const { eventId } = await repo.recordDeletion(CONN, CHAT, 9, new Date()) // no message saved
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())
    await svc.handle(cb(`restore:${eventId}`))
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(answersOf(calls)).toContain('Копия не была сохранена')
  })

  test('restores stored media (photo) with the caption on the file', async () => {
    const stored = await repo.saveMessageVersion(
      save(1, 'a caption', { hasMedia: true, media: [{ type: 'photo', tgFileId: 'f1' }] }),
    )
    const [job] = await repo.listPendingMedia(10, 3)
    await repo.claimMediaDownload(job!.mediaId)
    await repo.markMediaStored(job!.mediaId, { storageKey: 'k/1', checksum: 'c', mimeType: 'image/jpeg' })
    const { eventId } = await repo.recordDeletion(CONN, CHAT, 1, new Date())
    expect(stored.hasMedia).toBe(true)

    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage(true))
    await svc.handle(cb(`restore:${eventId}`))

    expect(calls.some((c) => c.method === 'sendMedia' && c.type === 'photo')).toBe(true)
    expect(answersOf(calls)).toContain('Восстановлено')
  })

  test('restore of an edited message re-sends the previous version', async () => {
    const stored = await repo.saveMessageVersion(save(1, 'v1'))
    await repo.saveMessageVersion(save(1, 'v2', { editDate: new Date('2026-07-14T10:05:00Z') }))
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())

    await svc.handle(cb(`restore:${stored.id}`)) // edit buttons carry the messageId

    const msgs = calls.filter((c) => c.method === 'sendMessage')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.text).toBe('v1') // previous version
    expect(answersOf(calls)).toContain('Восстановлено')
  })
})

describe('CallbackService — history', () => {
  test('owner sees a paginated history view with a keyboard', async () => {
    const stored = await repo.saveMessageVersion(save(1, 'v1'))
    await repo.saveMessageVersion(save(1, 'v2', { editDate: new Date('2026-07-14T10:05:00Z') }))
    await repo.recordDeletion(CONN, CHAT, 1, new Date())
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())

    await svc.handle(cb(`history:${stored.id}`))

    const msgs = calls.filter((c) => c.method === 'sendMessage')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.text).toContain('История сообщения')
    // answered (spinner stopped)
    expect(calls.some((c) => c.method === 'answer')).toBe(true)
  })

  test('history for a foreign user -> "Недоступно", no history sent', async () => {
    const stored = await repo.saveMessageVersion(save(1, 'v1'))
    await repo.saveMessageVersion(save(1, 'v2', { editDate: new Date('2026-07-14T10:05:00Z') }))
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())

    await svc.handle(cb(`history:${stored.id}`, 12345))

    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(answersOf(calls)).toEqual(['Недоступно'])
  })
})

describe('CallbackService — archive', () => {
  test('archive action points to the Mini App (no data revealed)', async () => {
    const { client, calls } = fakeClient()
    const svc = new CallbackService(repo, client, new FakeStorage())
    await svc.handle(cb('archive:whatever'))
    const answer = calls.find((c) => c.method === 'answer')
    expect(answer?.text).toContain('мини-приложении')
    expect(answer?.showAlert).toBe(true)
  })
})
