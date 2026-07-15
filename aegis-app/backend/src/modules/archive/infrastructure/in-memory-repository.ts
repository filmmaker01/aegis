import type {
  ConnectionState,
  IncomingBusinessConnection,
  MediaItem,
  MessageDirection,
  StoredConnection,
  StoredMessage,
} from '../domain/types'
import { randomUUID } from 'node:crypto'

import type {
  ArchiveContext,
  ArchiveRepository,
  CallbackEventRef,
  CallbackMessageRef,
  SaveMessageVersionInput,
  VersionRow,
} from '../application/ports'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type NotificationSettingsRepository,
} from '../application/settings-ports'
import type {
  ChatDto,
  DeletedItemDto,
  MessageDetailDto,
  OverviewDto,
  QueryRepository,
} from '../application/query-ports'
import {
  PERMANENT_FAILURE_ATTEMPTS,
  type MediaDownloadStatus,
  type MediaRepository,
  type MediaStoredMeta,
  type PendingMediaJob,
  type StoredMediaRef,
} from '../application/media-ports'
import type { MediaType } from '../domain/types'

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
  id: string
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
}

interface MediaRec {
  id: string
  connectionId: string
  tgChatId: number
  tgMessageId: number
  type: MediaType
  tgFileId: string
  tgFileUniqueId?: string
  mimeType?: string
  sizeBytes?: number
  fileName?: string
  storageKey?: string
  checksum?: string
  state: MediaDownloadStatus
  attempts: number
  failedReason?: string
}

interface DelRecord {
  id: string
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
export class InMemoryArchiveRepository
  implements ArchiveRepository, QueryRepository, MediaRepository, NotificationSettingsRepository
{
  readonly processed = new Set<number>()
  readonly connections = new Map<string, ConnRecord>()
  readonly chats = new Map<string, ChatRecord>()
  readonly messages = new Map<string, MsgRecord>()
  readonly messagesById = new Map<string, MsgRecord>()
  readonly deletions = new Map<string, DelRecord>()
  readonly deletionsById = new Map<string, DelRecord>()
  readonly mediaItems = new Map<string, MediaRec>()
  readonly settings = new Map<string, NotificationSettings>()

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
        id: randomUUID(),
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
      }
      this.messages.set(k, rec)
      this.messagesById.set(rec.id, rec)
      this.mergeMedia(rec, input.media)
      return toStored(rec)
    }

    const last = existing.versions[existing.versions.length - 1]
    if (last && last.sig === sig) {
      // idempotent re-delivery — merge media only
      existing.hasMedia = existing.hasMedia || input.hasMedia
      this.mergeMedia(existing, input.media)
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
    this.mergeMedia(existing, input.media)
    return toStored(existing)
  }

  private mergeMedia(rec: MsgRecord, items: MediaItem[]): void {
    if (items.length > 0) rec.hasMedia = true
    for (const item of items) {
      const dup = [...this.mediaItems.values()].some(
        (m) =>
          m.connectionId === rec.connectionId &&
          m.tgChatId === rec.tgChatId &&
          m.tgMessageId === rec.tgMessageId &&
          m.tgFileId === item.tgFileId,
      )
      if (dup) continue
      const id = randomUUID()
      this.mediaItems.set(id, {
        id,
        connectionId: rec.connectionId,
        tgChatId: rec.tgChatId,
        tgMessageId: rec.tgMessageId,
        type: item.type,
        tgFileId: item.tgFileId,
        tgFileUniqueId: item.tgFileUniqueId,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        state: 'pending',
        attempts: 0,
      })
    }
  }

  // ── Media repository ────────────────────────────────────────────────────────

  async listPendingMedia(limit: number, maxAttempts: number): Promise<PendingMediaJob[]> {
    const jobs: PendingMediaJob[] = []
    for (const m of this.mediaItems.values()) {
      const retryable = m.state === 'pending' || (m.state === 'failed' && m.attempts < maxAttempts)
      if (!retryable) continue
      jobs.push({
        mediaId: m.id,
        connectionId: m.connectionId,
        tgChatId: m.tgChatId,
        tgMessageId: m.tgMessageId,
        type: m.type,
        tgFileId: m.tgFileId,
        attempts: m.attempts,
      })
      if (jobs.length >= limit) break
    }
    return jobs
  }

  async claimMediaDownload(mediaId: string): Promise<boolean> {
    const m = this.mediaItems.get(mediaId)
    if (!m || (m.state !== 'pending' && m.state !== 'failed')) return false
    m.state = 'downloading'
    m.attempts += 1
    return true
  }

  async markMediaStored(mediaId: string, meta: MediaStoredMeta): Promise<void> {
    const m = this.mediaItems.get(mediaId)
    if (!m) return
    m.state = 'stored'
    m.storageKey = meta.storageKey
    m.checksum = meta.checksum
    if (meta.sizeBytes !== undefined) m.sizeBytes = meta.sizeBytes
    if (meta.mimeType !== undefined) m.mimeType = meta.mimeType
    if (meta.fileName !== undefined) m.fileName = meta.fileName
    m.failedReason = undefined
  }

  async markMediaFailed(mediaId: string, reason: string, retryable: boolean): Promise<void> {
    const m = this.mediaItems.get(mediaId)
    if (!m) return
    m.state = 'failed'
    m.failedReason = reason
    if (!retryable) m.attempts = PERMANENT_FAILURE_ATTEMPTS
  }

  async getStoredMediaForMessage(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<StoredMediaRef[]> {
    const refs: StoredMediaRef[] = []
    for (const m of this.mediaItems.values()) {
      if (
        m.connectionId === connectionId &&
        m.tgChatId === tgChatId &&
        m.tgMessageId === tgMessageId &&
        m.state === 'stored' &&
        m.storageKey
      ) {
        refs.push({
          mediaId: m.id,
          type: m.type,
          storageKey: m.storageKey,
          fileName: m.fileName ?? null,
          mimeType: m.mimeType ?? null,
        })
      }
    }
    return refs
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
  ): Promise<{ created: boolean; message: StoredMessage | null; eventId: string | null }> {
    const k = key(connectionId, tgChatId, tgMessageId)
    const message = this.messages.get(k)
    const existingDel = this.deletions.get(k)
    if (existingDel) {
      if (message) message.isDeleted = true
      return {
        created: false,
        message: message ? toStored(message) : null,
        eventId: existingDel.id,
      }
    }
    const rec: DelRecord = { id: randomUUID(), connectionId, tgChatId, tgMessageId, detectedAt }
    this.deletions.set(k, rec)
    this.deletionsById.set(rec.id, rec)
    if (message) message.isDeleted = true
    return { created: true, message: message ? toStored(message) : null, eventId: rec.id }
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

  async getChatPeer(
    connectionId: string,
    tgChatId: number,
  ): Promise<{ peerTitle: string | null; peerUsername: string | null } | null> {
    const chat = this.chats.get(chatKey(connectionId, tgChatId))
    if (!chat) return null
    return { peerTitle: chat.peerTitle ?? null, peerUsername: chat.peerUsername ?? null }
  }

  async getArchiveContext(eventId: string): Promise<ArchiveContext | null> {
    const d = this.deletionsById.get(eventId)
    if (!d) return null
    const conn = [...this.connections.values()].find((c) => c.connectionId === d.connectionId)
    if (!conn) return null
    const chat = this.chats.get(chatKey(d.connectionId, d.tgChatId))
    const siblings = [...this.deletionsById.values()]
      .filter(
        (x) =>
          x.connectionId === d.connectionId &&
          x.tgChatId === d.tgChatId &&
          x.detectedAt.getTime() === d.detectedAt.getTime(),
      )
      .sort((a, b) => a.tgMessageId - b.tgMessageId)
    const items = siblings.map((s) => {
      const msg = this.messages.get(key(s.connectionId, s.tgChatId, s.tgMessageId))
      const media = [...this.mediaItems.values()].filter(
        (m) => m.connectionId === s.connectionId && m.tgChatId === s.tgChatId && m.tgMessageId === s.tgMessageId,
      )
      return {
        eventId: s.id,
        messageId: msg?.id ?? null,
        tgMessageId: s.tgMessageId,
        savedText: msg?.currentText ?? null,
        mediaTypes: media.map((m) => m.type),
        versionCount: msg?.versions.length ?? 0,
      }
    })
    return {
      ownerTgUserId: conn.ownerTgUserId,
      peerTitle: chat?.peerTitle ?? null,
      peerUsername: chat?.peerUsername ?? null,
      detectedAt: d.detectedAt,
      items,
    }
  }

  async getEventForCallback(eventId: string): Promise<CallbackEventRef | null> {
    const d = this.deletionsById.get(eventId)
    if (!d) return null
    const conn = [...this.connections.values()].find((c) => c.connectionId === d.connectionId)
    if (!conn) return null
    const msg = this.messages.get(key(d.connectionId, d.tgChatId, d.tgMessageId))
    return {
      eventId: d.id,
      ownerTgUserId: conn.ownerTgUserId,
      connectionId: d.connectionId,
      tgChatId: d.tgChatId,
      tgMessageId: d.tgMessageId,
      messageId: msg?.id ?? null,
    }
  }

  async getMessageForCallback(messageId: string): Promise<CallbackMessageRef | null> {
    const m = this.messagesById.get(messageId)
    if (!m) return null
    const conn = [...this.connections.values()].find((c) => c.connectionId === m.connectionId)
    if (!conn) return null
    return {
      messageId: m.id,
      ownerTgUserId: conn.ownerTgUserId,
      connectionId: m.connectionId,
      tgChatId: m.tgChatId,
      tgMessageId: m.tgMessageId,
      currentText: m.currentText ?? null,
      hasMedia: m.hasMedia,
    }
  }

  async getMessageVersions(messageId: string, offset: number, limit: number): Promise<VersionRow[]> {
    const m = this.messagesById.get(messageId)
    if (!m) return []
    return m.versions.slice(offset, offset + limit).map((v) => ({
      versionNo: v.versionNo,
      text: v.text ?? null,
      at: v.editDate ?? (v.versionNo === 1 ? m.sentAt : null),
    }))
  }

  async countMessageVersions(messageId: string): Promise<number> {
    return this.messagesById.get(messageId)?.versions.length ?? 0
  }

  async getStoredMediaForMessageId(messageId: string): Promise<StoredMediaRef[]> {
    const m = this.messagesById.get(messageId)
    if (!m) return []
    return this.getStoredMediaForMessage(m.connectionId, m.tgChatId, m.tgMessageId)
  }

  // ── Notification settings ────────────────────────────────────────────────────

  async getSettings(connectionId: string): Promise<NotificationSettings> {
    const s = this.settings.get(connectionId)
    return s ? { ...s, mutedChats: [...s.mutedChats] } : { ...DEFAULT_NOTIFICATION_SETTINGS }
  }

  async updateSettings(
    connectionId: string,
    patch: Partial<NotificationSettings>,
  ): Promise<NotificationSettings> {
    const current = this.settings.get(connectionId) ?? { ...DEFAULT_NOTIFICATION_SETTINGS }
    const next: NotificationSettings = {
      ...current,
      ...patch,
      mutedChats: patch.mutedChats ? [...patch.mutedChats] : [...current.mutedChats],
    }
    this.settings.set(connectionId, next)
    return { ...next, mutedChats: [...next.mutedChats] }
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
    id: m.id,
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

