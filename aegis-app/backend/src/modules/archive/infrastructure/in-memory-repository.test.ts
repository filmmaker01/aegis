import { beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryArchiveRepository } from './in-memory-repository'
import type { IncomingBusinessConnection } from '../domain/types'
import type { SaveMessageVersionInput as SaveInput } from '../application/ports'

const CONN = 'conn-cb'
const CHAT = 5001
const OWNER = 700

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: OWNER,
  tgUserChatId: OWNER,
  rights: {},
  isEnabled: true,
  connectedAt: new Date('2026-07-14T00:00:00Z'),
}

function save(id: number, text: string | null, extra: Partial<SaveInput> = {}): SaveInput {
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
    peerUsername: 'partner',
    raw: {},
    ...extra,
  }
}

let repo: InMemoryArchiveRepository
const now = new Date('2026-07-14T12:00:00Z')

beforeEach(async () => {
  repo = new InMemoryArchiveRepository(() => now)
  await repo.upsertConnection(connection)
  // Real ingest always upserts the chat (with peer labels) before saving messages.
  await repo.upsertChat({ connectionId: CONN, tgChatId: CHAT, peerTitle: 'Partner', peerUsername: 'partner' })
})

describe('InMemoryArchiveRepository callback reads', () => {
  test('recordDeletion returns a stable event id; getEventForCallback resolves owner + messageId', async () => {
    const stored = await repo.saveMessageVersion(save(1, 'hello'))
    const res = await repo.recordDeletion(CONN, CHAT, 1, now)
    expect(res.created).toBe(true)
    expect(res.eventId).toBeTruthy()

    const ev = await repo.getEventForCallback(res.eventId as string)
    expect(ev?.ownerTgUserId).toBe(OWNER)
    expect(ev?.tgChatId).toBe(CHAT)
    expect(ev?.tgMessageId).toBe(1)
    expect(ev?.messageId).toBe(stored.id)
  })

  test('duplicate recordDeletion returns the same event id', async () => {
    await repo.saveMessageVersion(save(1, 'hi'))
    const a = await repo.recordDeletion(CONN, CHAT, 1, now)
    const b = await repo.recordDeletion(CONN, CHAT, 1, now)
    expect(b.created).toBe(false)
    expect(b.eventId).toBe(a.eventId)
  })

  test('unarchived deletion has a null messageId', async () => {
    const res = await repo.recordDeletion(CONN, CHAT, 9, now)
    const ev = await repo.getEventForCallback(res.eventId as string)
    expect(ev?.messageId).toBeNull()
  })

  test('getMessageForCallback resolves owner + current text', async () => {
    const stored = await repo.saveMessageVersion(save(1, 'hello'))
    const m = await repo.getMessageForCallback(stored.id)
    expect(m?.ownerTgUserId).toBe(OWNER)
    expect(m?.currentText).toBe('hello')
    expect(m?.tgMessageId).toBe(1)
  })

  test('versions: count + paginated slice with timestamps', async () => {
    const stored = await repo.saveMessageVersion(save(1, 'v1'))
    await repo.saveMessageVersion(save(1, 'v2', { editDate: new Date('2026-07-14T10:05:00Z') }))
    await repo.saveMessageVersion(save(1, 'v3', { editDate: new Date('2026-07-14T10:06:00Z') }))

    expect(await repo.countMessageVersions(stored.id)).toBe(3)
    const page = await repo.getMessageVersions(stored.id, 0, 2)
    expect(page.map((v) => v.versionNo)).toEqual([1, 2])
    expect(page[0]?.text).toBe('v1')
    expect(page[0]?.at).toEqual(new Date('2026-07-14T10:00:00Z')) // v1 -> sentAt
    expect(page[1]?.at).toEqual(new Date('2026-07-14T10:05:00Z')) // v2 -> editDate
  })

  test('getStoredMediaForMessageId returns only stored media', async () => {
    const stored = await repo.saveMessageVersion(
      save(1, null, { hasMedia: true, media: [{ type: 'photo', tgFileId: 'f1' }] }),
    )
    // not stored yet
    expect(await repo.getStoredMediaForMessageId(stored.id)).toHaveLength(0)
    const [job] = await repo.listPendingMedia(10, 3)
    await repo.claimMediaDownload(job!.mediaId)
    await repo.markMediaStored(job!.mediaId, { storageKey: 'k/1', checksum: 'c', mimeType: 'image/jpeg' })
    const media = await repo.getStoredMediaForMessageId(stored.id)
    expect(media).toHaveLength(1)
    expect(media[0]?.type).toBe('photo')
  })

  test('getChatPeer returns stored labels', async () => {
    await repo.saveMessageVersion(save(1, 'hi'))
    const peer = await repo.getChatPeer(CONN, CHAT)
    expect(peer?.peerTitle).toBe('Partner')
    expect(peer?.peerUsername).toBe('partner')
  })

  test('unknown ids resolve to null / empty (anti-enumeration)', async () => {
    expect(await repo.getEventForCallback('nope')).toBeNull()
    expect(await repo.getMessageForCallback('nope')).toBeNull()
    expect(await repo.getMessageVersions('nope', 0, 5)).toHaveLength(0)
    expect(await repo.countMessageVersions('nope')).toBe(0)
    expect(await repo.getStoredMediaForMessageId('nope')).toHaveLength(0)
    expect(await repo.getChatPeer(CONN, 999)).toBeNull()
  })
})
