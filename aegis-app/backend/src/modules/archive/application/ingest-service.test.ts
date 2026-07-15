import { beforeEach, describe, expect, test } from 'bun:test'

import { InMemoryArchiveRepository } from '../infrastructure/in-memory-repository'
import { IngestService } from './ingest-service'
import type {
  BatchDeletionNotification,
  DeletionNotification,
  EditNotification,
  Notifier,
} from './ports'
import type { IncomingBusinessConnection, IncomingMessage } from '../domain/types'

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

const CONN = 'conn-1'
const CHAT = 5001
const OWNER_CHAT = 700

const connection: IncomingBusinessConnection = {
  connectionId: CONN,
  ownerTgUserId: 700,
  tgUserChatId: OWNER_CHAT,
  rights: {},
  isEnabled: true,
  connectedAt: new Date('2026-07-14T00:00:00Z'),
}

function msg(id: number, text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    connectionId: CONN,
    tgChatId: CHAT,
    tgMessageId: id,
    direction: 'incoming',
    fromTgId: 999,
    sentAt: new Date('2026-07-14T10:00:00Z'),
    text,
    media: [],
    peerTitle: 'Partner',
    raw: { message_id: id, text },
    ...extra,
  }
}

let repo: InMemoryArchiveRepository
let notifier: RecordingNotifier
let svc: IngestService
const fixedNow = new Date('2026-07-14T12:00:00Z')

beforeEach(async () => {
  repo = new InMemoryArchiveRepository(() => fixedNow)
  notifier = new RecordingNotifier()
  svc = new IngestService({ repository: repo, notifier, clock: { now: () => fixedNow } })
  await svc.onBusinessConnection(connection)
})

describe('IngestService', () => {
  test('archives a new message with version 1 and creates the chat', async () => {
    await svc.onBusinessMessage(msg(1, 'hello'))
    const stored = await repo.findMessage(CONN, CHAT, 1)
    expect(stored?.currentText).toBe('hello')
    expect(stored?.versionCount).toBe(1)
    expect(stored?.isEdited).toBe(false)
    expect(repo.chats.get(`${CONN}:${CHAT}`)?.peerTitle).toBe('Partner')
  })

  test('edit appends a version and updates current text', async () => {
    await svc.onBusinessMessage(msg(1, 'hi'))
    await svc.onEditedBusinessMessage(msg(1, 'hi there', { editDate: new Date('2026-07-14T10:01:00Z') }))
    const stored = await repo.findMessage(CONN, CHAT, 1)
    expect(stored?.currentText).toBe('hi there')
    expect(stored?.versionCount).toBe(2)
    expect(stored?.isEdited).toBe(true)
  })

  test('duplicate re-delivery of the same message does not add a version', async () => {
    await svc.onBusinessMessage(msg(1, 'hi'))
    await svc.onBusinessMessage(msg(1, 'hi'))
    const stored = await repo.findMessage(CONN, CHAT, 1)
    expect(stored?.versionCount).toBe(1)
  })

  test('deletion of an archived message notifies the owner with saved content', async () => {
    await svc.onBusinessMessage(msg(1, 'secret text'))
    await svc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1] })

    const stored = await repo.findMessage(CONN, CHAT, 1)
    expect(stored?.isDeleted).toBe(true)
    expect(notifier.calls).toHaveLength(1)
    expect(notifier.calls[0]?.archived).toBe(true)
    expect(notifier.calls[0]?.savedText).toBe('secret text')
    // Notification MUST target the owner's user_chat_id, NOT the monitored chat.id.
    expect(notifier.calls[0]?.ownerTgChatId).toBe(OWNER_CHAT)
    expect(notifier.calls[0]?.ownerTgChatId).not.toBe(CHAT)
  })

  test('self-heals via connection fetcher when connection was never stored, routing to user_chat_id', async () => {
    const freshRepo = new InMemoryArchiveRepository(() => fixedNow)
    const freshNotifier = new RecordingNotifier()
    const fetcher = {
      fetchConnection: async (connectionId: string) => ({
        connectionId,
        ownerTgUserId: 700,
        tgUserChatId: OWNER_CHAT, // 700, distinct from CHAT (5001)
        rights: {},
        isEnabled: true,
        connectedAt: fixedNow,
      }),
    }
    const freshSvc = new IngestService({
      repository: freshRepo,
      notifier: freshNotifier,
      clock: { now: () => fixedNow },
      connectionFetcher: fetcher,
    })

    // NOTE: onBusinessConnection is intentionally NOT called (connection unknown).
    await freshSvc.onBusinessMessage(msg(1, 'recovered text'))
    await freshSvc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1] })

    expect(freshNotifier.calls).toHaveLength(1)
    expect(freshNotifier.calls[0]?.savedText).toBe('recovered text')
    expect(freshNotifier.calls[0]?.ownerTgChatId).toBe(OWNER_CHAT)
    expect(freshNotifier.calls[0]?.ownerTgChatId).not.toBe(CHAT)
    // connection was persisted for subsequent use
    expect((await freshRepo.getConnection(CONN))?.tgUserChatId).toBe(OWNER_CHAT)
  })

  test('duplicate deletion event notifies only once', async () => {
    await svc.onBusinessMessage(msg(1, 'x'))
    await svc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1] })
    await svc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1] })
    expect(notifier.calls).toHaveLength(1)
  })

  test('bulk deletion is grouped into ONE batch card (not N messages)', async () => {
    await svc.onBusinessMessage(msg(1, 'a'))
    await svc.onBusinessMessage(msg(2, 'b'))
    await svc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1, 2, 3] })
    // 3 newly-created events -> one grouped card, no per-message deletion cards.
    expect(notifier.calls).toHaveLength(0)
    expect(notifier.batches).toHaveLength(1)
    expect(notifier.batches[0]?.count).toBe(3)
    expect(notifier.batches[0]?.ownerTgChatId).toBe(OWNER_CHAT)
    // previews include the archived saved texts (first ≤5)
    const texts = notifier.batches[0]?.previews.map((p) => p.savedText)
    expect(texts).toContain('a')
    expect(texts).toContain('b')
  })

  test('single deletion keeps a single full card (not batched)', async () => {
    await svc.onBusinessMessage(msg(1, 'only one'))
    await svc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [1] })
    expect(notifier.calls).toHaveLength(1)
    expect(notifier.batches).toHaveLength(0)
    expect(notifier.calls[0]?.savedText).toBe('only one')
    expect(notifier.calls[0]?.eventId).toBeTruthy()
  })

  test('edit emits an edit notification with before/after', async () => {
    await svc.onBusinessMessage(msg(1, 'before text'))
    await svc.onEditedBusinessMessage(msg(1, 'after text', { editDate: new Date('2026-07-14T10:01:00Z') }))
    expect(notifier.edits).toHaveLength(1)
    expect(notifier.edits[0]?.before).toBe('before text')
    expect(notifier.edits[0]?.after).toBe('after text')
    expect(notifier.edits[0]?.messageId).toBeTruthy()
    expect(notifier.edits[0]?.ownerTgChatId).toBe(OWNER_CHAT)
  })

  test('idempotent edit re-delivery does not emit a second edit notification', async () => {
    await svc.onBusinessMessage(msg(1, 'before text'))
    const edited = msg(1, 'after text', { editDate: new Date('2026-07-14T10:01:00Z') })
    await svc.onEditedBusinessMessage(edited)
    await svc.onEditedBusinessMessage(edited)
    expect(notifier.edits).toHaveLength(1)
  })

  test('tombstone: delete before message -> message marked deleted on arrival + notified', async () => {
    await svc.onDeletedBusinessMessages({ connectionId: CONN, tgChatId: CHAT, tgMessageIds: [9] })
    // first notification: unarchived (no content yet)
    expect(notifier.calls).toHaveLength(1)
    expect(notifier.calls[0]?.archived).toBe(false)

    await svc.onBusinessMessage(msg(9, 'late content'))
    const stored = await repo.findMessage(CONN, CHAT, 9)
    expect(stored?.isDeleted).toBe(true)
    // second notification once we have the content
    expect(notifier.calls).toHaveLength(2)
    expect(notifier.calls[1]?.archived).toBe(true)
    expect(notifier.calls[1]?.savedText).toBe('late content')
  })

  test('update-level idempotency via claim()', async () => {
    expect(await svc.claim(42)).toBe(true)
    expect(await svc.claim(42)).toBe(false)
  })

  test('disabled connection is marked revoked', async () => {
    await svc.onBusinessConnection({ ...connection, isEnabled: false })
    expect((await repo.getConnection(CONN))?.state).toBe('revoked')
  })
})
