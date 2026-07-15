import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { createPrisma, type DbClient } from '../../../db'
import { IngestService } from '../application/ingest-service'
import type {
  BatchDeletionNotification,
  DeletionNotification,
  EditNotification,
  Notifier,
} from '../application/ports'
import { QueryService } from '../application/query-service'
import type { IncomingBusinessConnection, IncomingMessage } from '../domain/types'
import { PrismaArchiveRepository } from './prisma-archive-repository'

/**
 * Integration tests for the Prisma repository against a REAL Postgres.
 * Opt-in: run with PG_INTEGRATION=1 and DATABASE_URL set. Skipped otherwise
 * (so the no-DB unit suite is unaffected).
 *
 *   PG_INTEGRATION=1 DATABASE_URL=postgres://... bun test <thisfile>
 */
const shouldRun = Boolean(Bun.env.PG_INTEGRATION) && Boolean(Bun.env.DATABASE_URL)
const d = shouldRun ? describe : describe.skip

class RecordingNotifier implements Notifier {
  readonly calls: DeletionNotification[] = []
  readonly edits: EditNotification[] = []
  readonly batches: BatchDeletionNotification[] = []
  async notifyDeletion(n: DeletionNotification): Promise<void> {
    this.calls.push(n)
  }
  async notifyEdit(n: EditNotification): Promise<void> {
    this.edits.push(n)
  }
  async notifyBatchDeletion(n: BatchDeletionNotification): Promise<void> {
    this.batches.push(n)
  }
}

// Unique per run so repeated runs don't collide and stay isolated for scoping.
const SUFFIX = Math.floor(Math.random() * 1e9)
const CONN = `it-conn-${SUFFIX}`
const OWNER = 900_000_000 + (SUFFIX % 1_000_000)
const CHAT = 800_000_000 + (SUFFIX % 1_000_000)
const now = new Date('2026-07-15T12:00:00Z')

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: OWNER,
  tgUserChatId: OWNER,
  rights: { can_read_messages: true },
  isEnabled: true,
  connectedAt: now,
}

function msg(id: number, text: string, media = false): IncomingMessage {
  return {
    connectionId: CONN,
    tgChatId: CHAT,
    tgMessageId: id,
    direction: 'incoming',
    fromTgId: CHAT,
    sentAt: new Date('2026-07-15T10:00:00Z'),
    text,
    media: media ? [{ type: 'photo', tgFileId: `f${id}`, tgFileUniqueId: `u${id}`, sizeBytes: 100 }] : [],
    peerTitle: 'Partner',
    raw: { message_id: id, text },
  }
}

let prisma: DbClient
let repo: PrismaArchiveRepository
let notifier: RecordingNotifier
let ingest: IngestService
let query: QueryService

d('PrismaArchiveRepository (integration)', () => {
  beforeAll(async () => {
    prisma = createPrisma(Bun.env.DATABASE_URL as string)
    repo = new PrismaArchiveRepository(prisma)
    notifier = new RecordingNotifier()
    ingest = new IngestService({ repository: repo, notifier, clock: { now: () => now } })
    query = new QueryService(repo)
    await ingest.onBusinessConnection(connection)
  })

  afterAll(async () => {
    // Cascade cleanup by connection.
    await prisma.businessConnection.deleteMany({ where: { connectionId: CONN } }).catch(() => {})
    await prisma.$disconnect()
  })

  test('claimUpdate is idempotent', async () => {
    const id = 700_000_000 + (SUFFIX % 1_000_000)
    expect(await repo.claimUpdate(id)).toBe(true)
    expect(await repo.claimUpdate(id)).toBe(false)
    await prisma.processedUpdate.delete({ where: { updateId: BigInt(id) } }).catch(() => {})
  })

  test('connection stored with user_chat_id', async () => {
    const c = await repo.getConnection(CONN)
    expect(c?.tgUserChatId).toBe(OWNER)
    expect(c?.rights['can_read_messages']).toBe(true)
  })

  test('archives message, edit adds a version, current text updates', async () => {
    await ingest.onBusinessMessage(msg(1, 'hello'))
    await ingest.onEditedBusinessMessage({ ...msg(1, 'hello edited'), editDate: new Date('2026-07-15T10:01:00Z') })
    const stored = await repo.findMessage(CONN, CHAT, 1)
    expect(stored?.currentText).toBe('hello edited')
    expect(stored?.isEdited).toBe(true)
    expect(stored?.versionCount).toBe(2)
  })

  test('deletion marks message, notifies owner user_chat_id with saved content; duplicate does not re-notify', async () => {
    await ingest.onBusinessMessage(msg(2, 'to be deleted', true))
    const before = notifier.calls.length
    await ingest.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [2] })
    await ingest.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [2] }) // duplicate

    const stored = await repo.findMessage(CONN, CHAT, 2)
    expect(stored?.isDeleted).toBe(true)
    expect(notifier.calls.length).toBe(before + 1) // exactly one new notification
    const call = notifier.calls[notifier.calls.length - 1]
    expect(call?.ownerTgChatId).toBe(OWNER)
    expect(call?.ownerTgChatId).not.toBe(CHAT)
    expect(call?.savedText).toBe('to be deleted')
    expect(call?.hasMedia).toBe(true)
  })

  test('query overview + deleted + message detail (owner-scoped)', async () => {
    const o = await query.overview(OWNER)
    expect(o.messages).toBeGreaterThanOrEqual(2)
    expect(o.deleted).toBeGreaterThanOrEqual(1)
    expect(o.edited).toBeGreaterThanOrEqual(1)

    const deleted = await query.deleted(OWNER)
    expect(deleted.some((x) => x.tgMessageId === 2 && x.savedText === 'to be deleted')).toBe(true)

    const detail = await query.message(OWNER, CHAT, 1)
    expect(detail?.versions).toHaveLength(2)

    // scoping: a different owner sees nothing
    expect((await query.overview(OWNER + 12345)).messages).toBe(0)
  })
})
