import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'bun:test'

import { IngestService } from '../application/ingest-service'
import type { Notifier } from '../application/ports'
import { InMemoryArchiveRepository } from '../infrastructure/in-memory-repository'
import type { TelegramFileClient } from '../../telegram/file-client'
import { MediaDownloadService } from './download-service'
import type { MediaStorage } from './storage'
import type { IncomingBusinessConnection, IncomingMessage } from '../domain/types'

const noopNotifier: Notifier = {
  async notifyDeletion() {},
  async notifyEdit() {},
  async notifyBatchDeletion() {},
}
const CONN = 'conn-1'
const CHAT = 5001
const now = new Date('2026-07-15T12:00:00Z')

class FakeStorage implements MediaStorage {
  readonly kind = 'local' as const
  readonly objects = new Map<string, Buffer>()
  async put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, bytes)
  }
  async get(key: string): Promise<Buffer> {
    const b = this.objects.get(key)
    if (!b) throw new Error('not found')
    return b
  }
}

function fakeFileClient(opts: {
  fileSize?: number
  bytes?: Buffer
  getFileNull?: boolean
}): TelegramFileClient {
  return {
    async getFile(fileId: string) {
      if (opts.getFileNull) return null
      return { filePath: `photos/${fileId}.jpg`, fileSize: opts.fileSize }
    },
    async downloadToBuffer() {
      return opts.bytes ?? Buffer.from([1, 2, 3, 4])
    },
  } as unknown as TelegramFileClient
}

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: 700,
  tgUserChatId: 700,
  rights: {},
  isEnabled: true,
  connectedAt: now,
}

function mediaMsg(id: number): IncomingMessage {
  return {
    connectionId: CONN,
    tgChatId: CHAT,
    tgMessageId: id,
    direction: 'incoming',
    fromTgId: CHAT,
    sentAt: now,
    text: null,
    media: [{ type: 'photo', tgFileId: `file${id}`, tgFileUniqueId: `u${id}`, sizeBytes: 4 }],
    peerTitle: 'Partner',
    raw: {},
  }
}

let repo: InMemoryArchiveRepository
let ingest: IngestService

beforeEach(async () => {
  repo = new InMemoryArchiveRepository(() => now)
  ingest = new IngestService({ repository: repo, notifier: noopNotifier, clock: { now: () => now } })
  await ingest.onBusinessConnection(connection)
})

describe('MediaDownloadService', () => {
  test('downloads, checksums and stores pending media', async () => {
    await ingest.onBusinessMessage(mediaMsg(1))
    const bytes = Buffer.from('hello media')
    const storage = new FakeStorage()
    const svc = new MediaDownloadService(repo, fakeFileClient({ bytes }), storage)

    const res = await svc.processPending()
    expect(res.stored).toBe(1)

    const stored = await repo.getStoredMediaForMessage(CONN, CHAT, 1)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.type).toBe('photo')
    // stored bytes match, checksum recorded
    const key = stored[0]!.storageKey
    expect(storage.objects.get(key)?.equals(bytes)).toBe(true)
    const media = [...repo.mediaItems.values()][0]
    expect(media?.checksum).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(media?.state).toBe('stored')
  })

  test('idempotent: second sweep does not re-store already-stored media', async () => {
    await ingest.onBusinessMessage(mediaMsg(1))
    const storage = new FakeStorage()
    const svc = new MediaDownloadService(repo, fakeFileClient({ bytes: Buffer.from('x') }), storage)
    expect((await svc.processPending()).stored).toBe(1)
    expect((await svc.processPending()).processed).toBe(0) // nothing pending now
  })

  test('too-large media is failed permanently (not retried)', async () => {
    await ingest.onBusinessMessage(mediaMsg(1))
    const svc = new MediaDownloadService(
      repo,
      fakeFileClient({ fileSize: 999_999_999 }),
      new FakeStorage(),
      { maxBytes: 1000 },
    )
    expect((await svc.processPending()).failed).toBe(1)
    const media = [...repo.mediaItems.values()][0]
    expect(media?.state).toBe('failed')
    // not retryable -> excluded from future sweeps
    expect((await svc.processPending()).processed).toBe(0)
  })

  test('getFile failure is retryable', async () => {
    await ingest.onBusinessMessage(mediaMsg(1))
    const svc = new MediaDownloadService(repo, fakeFileClient({ getFileNull: true }), new FakeStorage())
    expect((await svc.processPending()).failed).toBe(1)
    // still retryable -> appears again
    expect((await svc.processPending()).processed).toBe(1)
  })
})
