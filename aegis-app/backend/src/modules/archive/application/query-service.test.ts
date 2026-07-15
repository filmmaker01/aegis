import { beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryArchiveRepository } from '../infrastructure/in-memory-repository'
import { IngestService } from './ingest-service'
import { QueryService } from './query-service'
import type { Notifier } from './ports'
import type { IncomingBusinessConnection, IncomingMessage } from '../domain/types'

const noopNotifier: Notifier = {
  async notifyDeletion() {},
  async notifyEdit() {},
  async notifyBatchDeletion() {},
}
const OWNER = 700
const CONN = 'conn-1'
const CHAT = 5001
const now = new Date('2026-07-14T12:00:00Z')

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: OWNER,
  tgUserChatId: OWNER,
  rights: {},
  isEnabled: true,
  connectedAt: now,
}

function msg(id: number, text: string, media = false): IncomingMessage {
  return {
    connectionId: CONN,
    tgChatId: CHAT,
    tgMessageId: id,
    direction: 'incoming',
    fromTgId: 999,
    sentAt: new Date('2026-07-14T10:00:00Z'),
    text,
    media: media ? [{ type: 'photo', tgFileId: `f${id}` }] : [],
    peerTitle: 'Partner',
    raw: {},
  }
}

let repo: InMemoryArchiveRepository
let ingest: IngestService
let query: QueryService

beforeEach(async () => {
  repo = new InMemoryArchiveRepository(() => now)
  ingest = new IngestService({ repository: repo, notifier: noopNotifier, clock: { now: () => now } })
  query = new QueryService(repo)
  await ingest.onBusinessConnection(connection)
  await ingest.onBusinessMessage(msg(1, 'hello'))
  await ingest.onBusinessMessage(msg(2, 'pic', true))
  await ingest.onEditedBusinessMessage({ ...msg(1, 'hello edited'), editDate: now })
  await ingest.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [2] })
})

describe('QueryService', () => {
  test('overview counts messages, deleted, edited, chats', async () => {
    const o = await query.overview(OWNER)
    expect(o.connections).toBe(1)
    expect(o.chats).toBe(1)
    expect(o.messages).toBe(2)
    expect(o.deleted).toBe(1)
    expect(o.edited).toBe(1)
  })

  test('deleted list returns saved content of the deleted message', async () => {
    const d = await query.deleted(OWNER)
    expect(d).toHaveLength(1)
    expect(d[0]?.tgMessageId).toBe(2)
    expect(d[0]?.savedText).toBe('pic')
    expect(d[0]?.hasMedia).toBe(true)
    expect(d[0]?.archived).toBe(true)
    expect(d[0]?.peerLabel).toBe('Partner')
  })

  test('message detail returns version history', async () => {
    const m = await query.message(OWNER, CHAT, 1)
    expect(m?.currentText).toBe('hello edited')
    expect(m?.isEdited).toBe(true)
    expect(m?.versions).toHaveLength(2)
    expect(m?.versions[0]?.text).toBe('hello')
    expect(m?.versions[1]?.text).toBe('hello edited')
  })

  test('queries are owner-scoped (other owner sees nothing)', async () => {
    expect((await query.overview(999)).messages).toBe(0)
    expect(await query.deleted(999)).toHaveLength(0)
    expect(await query.message(999, CHAT, 1)).toBeNull()
  })
})
