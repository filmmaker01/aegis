import type {
  ConnectionState,
  IncomingBusinessConnection,
  MediaItem,
  MessageDirection,
  StoredConnection,
  StoredMessage,
} from '../domain/types'
import type { ArchiveRepository, SaveMessageVersionInput } from '../application/ports'
import type {
  ChatDto,
  DeletedItemDto,
  MessageDetailDto,
  OverviewDto,
  QueryRepository,
} from '../application/query-ports'

interface ConnRecord {
  connectionId: string
  ownerTgUserId: number
  tgUserChatId: number
  state: ConnectionState
  rights: Record<string, boolean>
  connectedAt: Date
  disconnectedAt?: Date
}

interface ChatRecord {
  connectionId: string
  tgChatId: number
  peerTitle?: string | null
  peerUsername?: string | null
  firstSeenAt: Date
  lastMessageAt?: Date | null
}

interface VersionRecord {
  versionNo: number
  text?: string | null
  editDate?: Date
  sig: string
}

interface MsgRecord {
  connectionId: string
  tgChatId: number
  tgMessageId: number
  direction: MessageDirection
  fromTgId?: number
  sentAt: Date
  currentText?: string | null
  hasMedia: boolean
  isEdited: boolean
  isDeleted: boolean
  receivedAt: Date
  versions: VersionRecord[]
  media: MediaItem[]
}

interface DelRecord {
  connectionId: string
  tgChatId: number
  tgMessageId: number
  detectedAt: Date
  notifiedAt?: Date
}

const key = (c: string, chat: number, msg: number) => `${c}:${chat}:${msg}`
const chatKey = (c: string, chat: number) => `${c}:${chat}`
const sigOf = (text?: string | null, editDate?: Date) =>
  `${text ?? ''}|${editDate ? editDate.getTime() : ''}`

/** In-memory Archive + Query repository — for tests and local dev without Postgres. */
export class InMemoryArchiveRepository implements ArchiveRepository, QueryRepository {
  readonly processed = new Set<number>()
  readonly connections = new Map<string, ConnRecord>()
  readonly chats = new Map<string, ChatRecord>()
  readonly messages = new Map<string, MsgRecord>()
  readonly deletions = new Map<string, DelRecord>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  async claimUpdate(updateId: number): Promise<boolean> {
    if (this.processed.has(updateId)) return false
    this.processed.add(updateId)
    return true
  }

  async upsertConnection(input: IncomingBusinessConnection): Promise<void> {
    const existing = this.connections.get(input.connectionId)
    this.connections.set(input.connectionId, {
      connectionId: input.connectionId,
      ownerTgUserId: input.ownerTgUserId,
      tgUserChatId: input.tgUserChatId,
      state: input.isEnabled ? 'active' : 'disabled',
      rights: input.rights,
      connectedAt: existing?.connectedAt ?? input.connectedAt,
      disconnectedAt: existing?.disconnectedAt,
    })
  }

  async setConnectionState(connectionId: string, state: ConnectionState, at: Date): Promise<void> {
    const c = this.connections.get(connectionId)
    if (!c) return
    c.state = state
    if (state !== 'active') c.disconnectedAt = at
  }

  async getConnection(connectionId: string): Promise<StoredConnection | null> {
    const c = this.connections.get(connectionId)
    if (!c) return null
    return {
      connectionId: c.connectionId,
      ownerTgUserId: c.ownerTgUserId,
      tgUserChatId: c.tgUserChatId,
      state: c.state,
      rights: c.rights,
    }
  }

  async upsertChat(input: {
    connectionId: string
    tgChatId: number
    peerTitle?: string | null
    peerUsername?: string | null
    lastMessageAt?: Date | null
  }): Promise<void> {
    const k = chatKey(input.connectionId, input.tgChatId)
    const existing = this.chats.get(k)
    if (!existing) {
      this.chats.set(k, {
        connectionId: input.connectionId,
        tgChatId: input.tgChatId,
        peerTitle: input.peerTitle,
        peerUsername: input.peerUsername,
        firstSeenAt: this.now(),
        lastMessageAt: input.lastMessageAt ?? null,
      })
      return
    }
    if (input.peerTitle !== undefined) existing.peerTitle = input.peerTitle
    if (input.peerUsername !== undefined) existing.peerUsername = input.peerUsername
    if (input.lastMessageAt && (!existing.lastMessageAt || input.lastMessageAt > existing.lastMessageAt))
      existing.lastMessageAt = input.lastMessageAt
  }

  async findMessage(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<StoredMessage | null> {
    const m = this.messages.get(key(connectionId, tgChatId, tgMessageId))
    return m ? toStored(m) : null
  }

  async saveMessageVersion(input: SaveMessageVersionInput): Promise<StoredMessage> {
    const k = key(input.connectionId, input.tgChatId, input.tgMessageId)
    const sig = sigOf(input.text, input.editDate)
    const existing = this.messages.get(k)

    if (!existing) {
      const rec: MsgRecord = {
        connectionId: input.connectionId,
        tgChatId: input.tgChatId,
        tgMessageId: input.tgMessageId,
        direction: input.direction,
        fromTgId: input.fromTgId,
        sentAt: input.sentAt,
        currentText: input.text ?? null,
        hasMedia: input.hasMedia,
        isEdited: Boolean(input.editDate),
        isDeleted: false,
        receivedAt: this.now(),
        versions: [{ versionNo: 1, text: input.text ?? null, editDate: input.editDate, sig }],
        media: [],
      }
      mergeMedia(rec, input.media)
      this.messages.set(k, rec)
      return toStored(rec)
    }

    const last = existing.versions[existing.versions.length - 1]
    if (last && last.sig === sig) {
      // idempotent re-delivery — merge media only
      mergeMedia(existing, input.media)
      existing.hasMedia = existing.hasMedia || input.hasMedia
      return toStored(existing)
    }

    existing.versions.push({
      versionNo: existing.versions.length + 1,
      text: input.text ?? null,
      editDate: input.editDate,
      sig,
    })
    existing.currentText = input.text ?? null
    if (input.editDate || existing.versions.length > 1) existing.isEdited = true
    existing.hasMedia = existing.hasMedia || input.hasMedia
    mergeMedia(existing, input.media)
    return toStored(existing)
  }

  async markMessageDeleted(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<void> {
    const m = this.messages.get(key(connectionId, tgChatId, tgMessageId))
    if (m) m.isDeleted = true
  }

  async hasDeletion(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<boolean> {
    return this.deletions.has(key(connectionId, tgChatId, tgMessageId))
  }

  async recordDeletion(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    detectedAt: Date,
  ): Promise<{ created: boolean; message: StoredMessage | null }> {
    const k = key(connectionId, tgChatId, tgMessageId)
    const message = this.messages.get(k)
    if (this.deletions.has(k)) {
      return { created: false, message: message ? toStored(message) : null }
    }
    this.deletions.set(k, { connectionId, tgChatId, tgMessageId, detectedAt })
    if (message) message.isDeleted = true
    return { created: true, message: message ? toStored(message) : null }
  }

  async markDeletionNotified(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    at: Date,
  ): Promise<void> {
    const d = this.deletions.get(key(connectionId, tgChatId, tgMessageId))
    if (d) d.notifiedAt = at
  }

  // ── Query side ──────────────────────────────────────────────────────────────

  private connectionIdsOf(ownerTgUserId: number): Set<string> {
    const ids = new Set<string>()
    for (const c of this.connections.values())
      if (c.ownerTgUserId === ownerTgUserId) ids.add(c.connectionId)
    return ids
  }

  async overview(ownerTgUserId: number): Promise<OverviewDto> {
    const conns = this.connectionIdsOf(ownerTgUserId)
    let messages = 0
    let deleted = 0
    let edited = 0
    for (const m of this.messages.values()) {
      if (!conns.has(m.connectionId)) continue
      messages++
      if (m.isDeleted) deleted++
      if (m.isEdited) edited++
    }
    // Count deletion events too (includes un-archived deletions).
    for (const d of this.deletions.values()) {
      if (conns.has(d.connectionId) && !this.messages.get(key(d.connectionId, d.tgChatId, d.tgMessageId))?.isDeleted)
        deleted++
    }
    let chats = 0
    for (const c of this.chats.values()) if (conns.has(c.connectionId)) chats++
    return { connections: conns.size, chats, messages, deleted, edited }
  }

  async listChats(ownerTgUserId: number): Promise<ChatDto[]> {
    const conns = this.connectionIdsOf(ownerTgUserId)
    const rows: ChatDto[] = []
    for (const chat of this.chats.values()) {
      if (!conns.has(chat.connectionId)) continue
      let messageCount = 0
      let deletedCount = 0
      for (const m of this.messages.values()) {
        if (m.connectionId === chat.connectionId && m.tgChatId === chat.tgChatId) {
          messageCount++
          if (m.isDeleted) deletedCount++
        }
      }
      rows.push({
        tgChatId: chat.tgChatId,
        peerTitle: chat.peerTitle,
        peerUsername: chat.peerUsername,
        lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
        messageCount,
        deletedCount,
      })
    }
    rows.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
    return rows
  }

  async listDeleted(ownerTgUserId: number, limit: number): Promise<DeletedItemDto[]> {
    const conns = this.connectionIdsOf(ownerTgUserId)
    const rows: DeletedItemDto[] = []
    for (const d of this.deletions.values()) {
      if (!conns.has(d.connectionId)) continue
      const m = this.messages.get(key(d.connectionId, d.tgChatId, d.tgMessageId))
      const chat = this.chats.get(chatKey(d.connectionId, d.tgChatId))
      rows.push({
        tgChatId: d.tgChatId,
        tgMessageId: d.tgMessageId,
        peerLabel: chat?.peerTitle ?? chat?.peerUsername ?? null,
        savedText: m?.currentText ?? null,
        hasMedia: m?.hasMedia ?? false,
        archived: m != null,
        sentAt: m ? m.sentAt.toISOString() : null,
        detectedAt: d.detectedAt.toISOString(),
      })
    }
    rows.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
    return rows.slice(0, limit)
  }

  async getMessage(
    ownerTgUserId: number,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<MessageDetailDto | null> {
    const conns = this.connectionIdsOf(ownerTgUserId)
    for (const connectionId of conns) {
      const m = this.messages.get(key(connectionId, tgChatId, tgMessageId))
      if (!m) continue
      return {
        tgChatId: m.tgChatId,
        tgMessageId: m.tgMessageId,
        direction: m.direction,
        sentAt: m.sentAt.toISOString(),
        currentText: m.currentText,
        isEdited: m.isEdited,
        isDeleted: m.isDeleted,
        hasMedia: m.hasMedia,
        versions: m.versions.map((v) => ({
          versionNo: v.versionNo,
          text: v.text,
          editDate: v.editDate ? v.editDate.toISOString() : null,
        })),
      }
    }
    return null
  }
}

function toStored(m: MsgRecord): StoredMessage {
  return {
    connectionId: m.connectionId,
    tgChatId: m.tgChatId,
    tgMessageId: m.tgMessageId,
    direction: m.direction,
    fromTgId: m.fromTgId,
    sentAt: m.sentAt,
    currentText: m.currentText,
    hasMedia: m.hasMedia,
    isEdited: m.isEdited,
    isDeleted: m.isDeleted,
    versionCount: m.versions.length,
  }
}

function mergeMedia(rec: MsgRecord, media: MediaItem[]): void {
  for (const item of media) {
    const dup = rec.media.some(
      (m) => (item.tgFileUniqueId && m.tgFileUniqueId === item.tgFileUniqueId) || m.tgFileId === item.tgFileId,
    )
    if (!dup) rec.media.push(item)
  }
  if (media.length > 0) rec.hasMedia = true
}
