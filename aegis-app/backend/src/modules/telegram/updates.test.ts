import { beforeEach, describe, expect, test } from 'bun:test'

import { IngestService } from '../archive/application/ingest-service'
import type { Notifier } from '../archive/application/ports'
import { InMemoryArchiveRepository } from '../archive/infrastructure/in-memory-repository'
import { dispatchUpdate, toIncomingMessage, type RawUpdate } from './updates'

const noopNotifier: Notifier = { async notifyDeletion() {} }
const CONN = 'gPOdZrconn0000000000000000'
const OWNER = 700
const PARTNER = 5001

let repo: InMemoryArchiveRepository
let ingest: IngestService

beforeEach(() => {
  repo = new InMemoryArchiveRepository()
  ingest = new IngestService({ repository: repo, notifier: noopNotifier, clock: { now: () => new Date() } })
})

const connUpdate: RawUpdate = {
  update_id: 1,
  business_connection: {
    id: CONN,
    user: { id: OWNER },
    user_chat_id: OWNER,
    date: 1784066388,
    is_enabled: true,
    rights: { can_read_messages: true },
  },
}

function msgUpdate(update_id: number, message_id: number, text: string): RawUpdate {
  return {
    update_id,
    business_message: {
      message_id,
      business_connection_id: CONN,
      from: { id: PARTNER },
      chat: { id: PARTNER, type: 'private', first_name: 'Partner' },
      date: 1784067576,
      text,
    },
  }
}

describe('dispatchUpdate', () => {
  test('maps and ingests a business_connection', async () => {
    expect(await dispatchUpdate(connUpdate, ingest)).toBe('business_connection')
    expect((await repo.getConnection(CONN))?.tgUserChatId).toBe(OWNER)
  })

  test('maps and archives a business_message', async () => {
    await dispatchUpdate(connUpdate, ingest)
    expect(await dispatchUpdate(msgUpdate(2, 935359, 'hello'), ingest)).toBe('business_message')
    const stored = await repo.findMessage(CONN, PARTNER, 935359)
    expect(stored?.currentText).toBe('hello')
    expect(stored?.direction).toBe('incoming')
  })

  test('deleted_business_messages marks archived message deleted', async () => {
    await dispatchUpdate(connUpdate, ingest)
    await dispatchUpdate(msgUpdate(2, 935359, 'bye'), ingest)
    const del: RawUpdate = {
      update_id: 3,
      deleted_business_messages: { business_connection_id: CONN, chat: { id: PARTNER }, message_ids: [935359] },
    }
    expect(await dispatchUpdate(del, ingest)).toBe('deleted_business_messages')
    expect((await repo.findMessage(CONN, PARTNER, 935359))?.isDeleted).toBe(true)
  })

  test('duplicate update_id is ignored', async () => {
    await dispatchUpdate(connUpdate, ingest)
    await dispatchUpdate(msgUpdate(2, 1, 'a'), ingest)
    expect(await dispatchUpdate(msgUpdate(2, 1, 'DIFFERENT'), ingest)).toBe('duplicate')
    // text unchanged because the duplicate update_id short-circuits
    expect((await repo.findMessage(CONN, PARTNER, 1))?.currentText).toBe('a')
  })

  test('media message maps a photo item and sets hasMedia', () => {
    const parsed = toIncomingMessage({
      message_id: 935363,
      business_connection_id: CONN,
      chat: { id: PARTNER, type: 'private' },
      date: 1784067576,
      photo: [
        { file_id: 'small', file_unique_id: 'u1', file_size: 100 },
        { file_id: 'large', file_unique_id: 'u2', file_size: 215365 },
      ],
    })
    expect(parsed?.media).toHaveLength(1)
    expect(parsed?.media[0]?.tgFileId).toBe('large') // largest variant
    expect(parsed?.media[0]?.type).toBe('photo')
  })

  test('outgoing detection via sender_business_bot', () => {
    const parsed = toIncomingMessage({
      message_id: 1,
      business_connection_id: CONN,
      from: { id: OWNER },
      chat: { id: PARTNER, type: 'private' },
      sender_business_bot: { id: 42 },
      date: 1784067576,
      text: 'reply',
    })
    expect(parsed?.direction).toBe('outgoing')
  })
})
