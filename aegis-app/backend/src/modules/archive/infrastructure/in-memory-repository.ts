import type {
  ConnectionState,
  IncomingBusinessConnection,
  MediaItem,
  MessageDirection,
  StoredConnection,
  StoredMessage,
} from '../domain/types'
import type { ArchiveRepository, SaveMessageVersionInput } from '../application/ports'

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

/** In-memory ArchiveRepository — used for tests and for local dev without Postgres. */
export class InMemoryArchiveRepository implements ArchiveRepository {
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
