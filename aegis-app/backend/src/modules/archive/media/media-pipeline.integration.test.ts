import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { createPrisma, type DbClient } from '../../../db'
import { IngestService } from '../application/ingest-service'
import { PrismaArchiveRepository } from '../infrastructure/prisma-archive-repository'
import { TelegramNotifier } from '../infrastructure/telegram-notifier'
import type { SendResult, TelegramFileClient } from '../../telegram/file-client'
import type { IncomingBusinessConnection, IncomingMessage } from '../domain/types'
import { MediaDownloadService } from './download-service'
import { LocalDiskMediaStorage } from './storage'

/** Full media pipeline against REAL Postgres + local disk. Opt-in via PG_INTEGRATION. */
const shouldRun = Boolean(Bun.env.PG_INTEGRATION) && Boolean(Bun.env.DATABASE_URL)
const d = shouldRun ? describe : describe.skip

const SUFFIX = Math.floor(Math.random() * 1e9)
const CONN = `it-media-${SUFFIX}`
const OWNER = 910_000_000 + (SUFFIX % 1_000_000)
const CHAT = 820_000_000 + (SUFFIX % 1_000_000)
const now = new Date('2026-07-15T12:00:00Z')

interface SendCall {
  method: 'sendMessage' | 'sendMedia'
  type?: string
  chatId: number
}

const PHOTO_BYTES = Buffer.from('fake-jpeg-bytes-0123456789')

function fakeFileClient(sent: SendCall[]): TelegramFileClient {
  const ok: SendResult = { ok: true, status: 200 }
  return {
    async getFile(fileId: string) {
      return { filePath: `photos/${fileId}.jpg`, fileSize: PHOTO_BYTES.length }
    },
    async downloadToBuffer() {
      return PHOTO_BYTES
    },
    async sendMessage(chatId: number) {
      sent.push({ method: 'sendMessage', chatId })
      return ok
    },
    async sendMedia(type: string, chatId: number) {
      sent.push({ method: 'sendMedia', type, chatId })
      return ok
    },
  } as unknown as TelegramFileClient
}

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: OWNER,
  tgUserChatId: OWNER,
  rights: {},
  isEnabled: true,
  connectedAt: now,
}

const photoMsg: IncomingMessage = {
  connectionId: CONN,
  tgChatId: CHAT,
  tgMessageId: 1,
  direction: 'incoming',
  fromTgId: CHAT,
  sentAt: now,
  text: 'look at this',
  media: [{ type: 'photo', tgFileId: `pf-${SUFFIX}`, tgFileUniqueId: `pu-${SUFFIX}`, sizeBytes: PHOTO_BYTES.length }],
  peerTitle: 'Partner',
  raw: {},
}

let prisma: DbClient
let repo: PrismaArchiveRepository
let dir: string

d('media pipeline (integration: Postgres + local disk)', () => {
  beforeAll(() => {
    prisma = createPrisma(Bun.env.DATABASE_URL as string)
    repo = new PrismaArchiveRepository(prisma)
    dir = mkdtempSync(join(tmpdir(), 'aegis-media-it-'))
  })
  afterAll(async () => {
    await prisma.businessConnection.deleteMany({ where: { connectionId: CONN } }).catch(() => {})
    await prisma.$disconnect()
    rmSync(dir, { recursive: true, force: true })
  })

  test('download-on-arrival stores media; deletion re-sends it to owner user_chat_id', async () => {
    const sent: SendCall[] = []
    const fileClient = fakeFileClient(sent)
    const storage = new LocalDiskMediaStorage(dir)
    const notifier = new TelegramNotifier(fileClient, storage, 1)
    const worker = new MediaDownloadService(repo, fileClient, storage)
    const ingest = new IngestService({
      repository: repo,
      notifier,
      clock: { now: () => now },
      mediaReader: repo,
    })

    await ingest.onBusinessConnection(connection)
    await ingest.onBusinessMessage(photoMsg)

    // worker downloads + stores
    const res = await worker.processPending()
    expect(res.stored).toBeGreaterThanOrEqual(1)

    const stored = await repo.getStoredMediaForMessage(CONN, CHAT, 1)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.type).toBe('photo')
    // bytes really on disk
    expect((await storage.get(stored[0]!.storageKey)).equals(PHOTO_BYTES)).toBe(true)

    // deletion re-sends the media to the owner's user_chat_id
    await ingest.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1] })
    const mediaSends = sent.filter((s) => s.method === 'sendMedia')
    expect(mediaSends).toHaveLength(1)
    expect(mediaSends[0]?.type).toBe('photo')
    expect(mediaSends[0]?.chatId).toBe(OWNER) // user_chat_id, not CHAT
    expect(mediaSends.every((s) => s.chatId !== CHAT)).toBe(true)
  })
})
