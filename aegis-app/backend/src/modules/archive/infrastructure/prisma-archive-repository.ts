import type { DbClient } from '../../../db'
import type {
  ConnectionState,
  IncomingBusinessConnection,
  MediaItem,
  StoredConnection,
  StoredMessage,
} from '../domain/types'
import type {
  ArchiveRepository,
  CallbackEventRef,
  CallbackMessageRef,
  SaveMessageVersionInput,
  VersionRow,
} from '../application/ports'
import type {
  ChatDto,
  DeletedItemDto,
  MessageDetailDto,
  OverviewDto,
  QueryRepository,
} from '../application/query-ports'
import {
  PERMANENT_FAILURE_ATTEMPTS,
  type MediaRepository,
  type MediaStoredMeta,
  type PendingMediaJob,
  type StoredMediaRef,
} from '../application/media-ports'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type NotificationSettingsRepository,
} from '../application/settings-ports'
import type { MediaType } from '../domain/types'

/**
 * Prisma-backed Archive + Query repository (production path).
 *
 * NOTE: typechecked against the generated Prisma client, but NOT integration-
 * tested in this environment (no local Postgres / Docker). Before relying on it,
 * run it against a Postgres instance and add integration tests (see roadmap).
 * The InMemoryArchiveRepository is the unit-tested reference implementation.
 */
const big = (n: number) => BigInt(n)
const num = (b: bigint | number) => Number(b)
const sigOf = (text: string | null | undefined, editDate: Date | null | undefined) =>
  `${text ?? ''}|${editDate ? editDate.getTime() : ''}`

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002'
}

export class PrismaArchiveRepository
  implements ArchiveRepository, QueryRepository, MediaRepository, NotificationSettingsRepository
{
  constructor(private readonly db: DbClient) {}

  async claimUpdate(updateId: number): Promise<boolean> {
    try {
      await this.db.processedUpdate.create({ data: { updateId: big(updateId) } })
      return true
    } catch (err) {
      if (isUniqueViolation(err)) return false
      throw err
    }
  }

  async upsertConnection(input: IncomingBusinessConnection): Promise<void> {
    const state: ConnectionState = input.isEnabled ? 'active' : 'disabled'
    await this.db.businessConnection.upsert({
      where: { connectionId: input.connectionId },
      create: {
        connectionId: input.connectionId,
        ownerTgUserId: big(input.ownerTgUserId),
        tgUserChatId: big(input.tgUserChatId),
        state,
        rights: input.rights,
        connectedAt: input.connectedAt,
      },
      update: {
        ownerTgUserId: big(input.ownerTgUserId),
        tgUserChatId: big(input.tgUserChatId),
        state,
        rights: input.rights,
      },
    })
  }

  async setConnectionState(connectionId: string, state: ConnectionState, at: Date): Promise<void> {
    await this.db.businessConnection.updateMany({
      where: { connectionId },
      data: { state, disconnectedAt: state === 'active' ? null : at },
    })
  }

  async getConnection(connectionId: string): Promise<StoredConnection | null> {
    const c = await this.db.businessConnection.findUnique({ where: { connectionId } })
    if (!c) return null
    return {
      connectionId: c.connectionId,
      ownerTgUserId: num(c.ownerTgUserId),
      tgUserChatId: num(c.tgUserChatId),
      state: c.state as ConnectionState,
      rights: (c.rights ?? {}) as Record<string, boolean>,
    }
  }

  private async connRow(connectionId: string) {
    return this.db.businessConnection.findUnique({ where: { connectionId } })
  }

  async upsertChat(input: {
    connectionId: string
    tgChatId: number
    peerTitle?: string | null
    peerUsername?: string | null
    lastMessageAt?: Date | null
  }): Promise<void> {
    const conn = await this.connRow(input.connectionId)
    if (!conn) return
    await this.db.chat.upsert({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(input.tgChatId) } },
      create: {
        connectionId: conn.id,
        tgChatId: big(input.tgChatId),
        peerTitle: input.peerTitle ?? null,
        peerUsername: input.peerUsername ?? null,
        lastMessageAt: input.lastMessageAt ?? null,
      },
      update: {
        ...(input.peerTitle !== undefined ? { peerTitle: input.peerTitle } : {}),
        ...(input.peerUsername !== undefined ? { peerUsername: input.peerUsername } : {}),
        ...(input.lastMessageAt ? { lastMessageAt: input.lastMessageAt } : {}),
      },
    })
  }

  async findMessage(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<StoredMessage | null> {
    const conn = await this.connRow(connectionId)
    if (!conn) return null
    const chat = await this.db.chat.findUnique({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
    })
    if (!chat) return null
    const m = await this.db.archivedMessage.findUnique({
      where: { connectionId_chatId_tgMessageId: { connectionId: conn.id, chatId: chat.id, tgMessageId } },
      include: { _count: { select: { versions: true } } },
    })
    if (!m) return null
    return {
      id: m.id,
      connectionId,
      tgChatId,
      tgMessageId,
      direction: m.direction as StoredMessage['direction'],
      fromTgId: m.fromTgId != null ? num(m.fromTgId) : undefined,
      sentAt: m.sentAt,
      currentText: m.currentText,
      hasMedia: m.hasMedia,
      isEdited: m.isEdited,
      isDeleted: m.isDeleted,
      versionCount: m._count.versions,
    }
  }

  async saveMessageVersion(input: SaveMessageVersionInput): Promise<StoredMessage> {
    return this.db.$transaction(async (tx) => {
      const conn = await tx.businessConnection.findUnique({ where: { connectionId: input.connectionId } })
      if (!conn) throw new Error(`saveMessageVersion: unknown connection ${input.connectionId}`)
      const chat = await tx.chat.upsert({
        where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(input.tgChatId) } },
        create: {
          connectionId: conn.id,
          tgChatId: big(input.tgChatId),
          peerTitle: input.peerTitle ?? null,
          peerUsername: input.peerUsername ?? null,
          lastMessageAt: input.sentAt,
        },
        update: { lastMessageAt: input.sentAt },
      })

      const existing = await tx.archivedMessage.findUnique({
        where: { connectionId_chatId_tgMessageId: { connectionId: conn.id, chatId: chat.id, tgMessageId: input.tgMessageId } },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 }, _count: { select: { versions: true } } },
      })
      const sig = sigOf(input.text, input.editDate)

      if (!existing) {
        const created = await tx.archivedMessage.create({
          data: {
            connectionId: conn.id,
            chatId: chat.id,
            tgMessageId: input.tgMessageId,
            direction: input.direction,
            fromTgId: input.fromTgId != null ? big(input.fromTgId) : null,
            sentAt: input.sentAt,
            currentText: input.text ?? null,
            hasMedia: input.hasMedia,
            isEdited: Boolean(input.editDate),
            raw: input.raw as object,
          },
        })
        await tx.messageVersion.create({
          data: { messageId: created.id, versionNo: 1, text: input.text ?? null, editDate: input.editDate ?? null, raw: input.raw as object },
        })
        await this.insertMedia(tx, created.id, input.media)
        return this.toStored(created.id, input, 1, false)
      }

      const last = existing.versions[0]
      const lastSig = sigOf(last?.text, last?.editDate)
      if (last && lastSig === sig) {
        await this.insertMedia(tx, existing.id, input.media)
        if (input.hasMedia && !existing.hasMedia)
          await tx.archivedMessage.update({ where: { id: existing.id }, data: { hasMedia: true } })
        return this.toStored(existing.id, input, existing._count.versions, existing.isDeleted)
      }

      await tx.messageVersion.create({
        data: { messageId: existing.id, versionNo: existing._count.versions + 1, text: input.text ?? null, editDate: input.editDate ?? null, raw: input.raw as object },
      })
      await tx.archivedMessage.update({
        where: { id: existing.id },
        data: { currentText: input.text ?? null, isEdited: true, hasMedia: existing.hasMedia || input.hasMedia },
      })
      await this.insertMedia(tx, existing.id, input.media)
      return this.toStored(existing.id, input, existing._count.versions + 1, existing.isDeleted)
    })
  }

  private toStored(
    id: string,
    input: SaveMessageVersionInput,
    versionCount: number,
    isDeleted: boolean,
  ): StoredMessage {
    return {
      id,
      connectionId: input.connectionId,
      tgChatId: input.tgChatId,
      tgMessageId: input.tgMessageId,
      direction: input.direction,
      fromTgId: input.fromTgId,
      sentAt: input.sentAt,
      currentText: input.text ?? null,
      hasMedia: input.hasMedia,
      isEdited: versionCount > 1 || Boolean(input.editDate),
      isDeleted,
      versionCount,
    }
  }

  private async insertMedia(
    tx: Pick<DbClient, 'media'>,
    messageId: string,
    media: MediaItem[],
  ): Promise<void> {
    for (const item of media) {
      const exists = await tx.media.findFirst({ where: { messageId, tgFileId: item.tgFileId }, select: { id: true } })
      if (exists) continue
      await tx.media.create({
        data: {
          messageId,
          type: item.type,
          tgFileId: item.tgFileId,
          tgFileUniqueId: item.tgFileUniqueId ?? null,
          mimeType: item.mimeType ?? null,
          sizeBytes: item.sizeBytes ?? null,
        },
      })
    }
  }

  async markMessageDeleted(connectionId: string, tgChatId: number, tgMessageId: number): Promise<void> {
    const conn = await this.connRow(connectionId)
    if (!conn) return
    const chat = await this.db.chat.findUnique({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
    })
    if (!chat) return
    await this.db.archivedMessage.updateMany({
      where: { connectionId: conn.id, chatId: chat.id, tgMessageId },
      data: { isDeleted: true },
    })
  }

  async hasDeletion(connectionId: string, tgChatId: number, tgMessageId: number): Promise<boolean> {
    const conn = await this.connRow(connectionId)
    if (!conn) return false
    const chat = await this.db.chat.findUnique({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
    })
    if (!chat) return false
    const d = await this.db.deletedEvent.findUnique({
      where: { connectionId_chatId_tgMessageId: { connectionId: conn.id, chatId: chat.id, tgMessageId } },
    })
    return d != null
  }

  async recordDeletion(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    detectedAt: Date,
  ): Promise<{ created: boolean; message: StoredMessage | null; eventId: string | null }> {
    const conn = await this.connRow(connectionId)
    if (!conn) return { created: false, message: null, eventId: null }
    // Ensure chat row exists (a deletion can precede any message for pre-connection history).
    const chat = await this.db.chat.upsert({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
      create: { connectionId: conn.id, tgChatId: big(tgChatId) },
      update: {},
    })
    const msgRow = await this.db.archivedMessage.findUnique({
      where: { connectionId_chatId_tgMessageId: { connectionId: conn.id, chatId: chat.id, tgMessageId } },
      select: { id: true },
    })
    const message = await this.findMessage(connectionId, tgChatId, tgMessageId)
    let eventId: string
    try {
      const created = await this.db.deletedEvent.create({
        data: {
          connectionId: conn.id,
          chatId: chat.id,
          tgMessageId,
          detectedAt,
          messageId: msgRow?.id ?? null,
        },
        select: { id: true },
      })
      eventId = created.id
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await this.db.deletedEvent.findUnique({
          where: { connectionId_chatId_tgMessageId: { connectionId: conn.id, chatId: chat.id, tgMessageId } },
          select: { id: true },
        })
        return { created: false, message, eventId: existing?.id ?? null }
      }
      throw err
    }
    if (message) await this.markMessageDeleted(connectionId, tgChatId, tgMessageId)
    return { created: true, message, eventId }
  }

  async markDeletionNotified(connectionId: string, tgChatId: number, tgMessageId: number, at: Date): Promise<void> {
    const conn = await this.connRow(connectionId)
    if (!conn) return
    const chat = await this.db.chat.findUnique({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
    })
    if (!chat) return
    await this.db.deletedEvent.updateMany({
      where: { connectionId: conn.id, chatId: chat.id, tgMessageId },
      data: { notifiedAt: at },
    })
  }

  async getChatPeer(
    connectionId: string,
    tgChatId: number,
  ): Promise<{ peerTitle: string | null; peerUsername: string | null } | null> {
    const conn = await this.connRow(connectionId)
    if (!conn) return null
    const chat = await this.db.chat.findUnique({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
      select: { peerTitle: true, peerUsername: true },
    })
    if (!chat) return null
    return { peerTitle: chat.peerTitle ?? null, peerUsername: chat.peerUsername ?? null }
  }

  async getEventForCallback(eventId: string): Promise<CallbackEventRef | null> {
    try {
      const e = await this.db.deletedEvent.findUnique({
        where: { id: eventId },
        include: { connection: true, chat: true },
      })
      if (!e) return null
      return {
        eventId: e.id,
        ownerTgUserId: num(e.connection.ownerTgUserId),
        connectionId: e.connection.connectionId,
        tgChatId: num(e.chat.tgChatId),
        tgMessageId: e.tgMessageId,
        messageId: e.messageId,
      }
    } catch {
      // Malformed id (e.g. not a uuid) -> treat as unknown (anti-enumeration).
      return null
    }
  }

  async getMessageForCallback(messageId: string): Promise<CallbackMessageRef | null> {
    try {
      const m = await this.db.archivedMessage.findUnique({
        where: { id: messageId },
        include: { connection: true, chat: true },
      })
      if (!m) return null
      return {
        messageId: m.id,
        ownerTgUserId: num(m.connection.ownerTgUserId),
        connectionId: m.connection.connectionId,
        tgChatId: num(m.chat.tgChatId),
        tgMessageId: m.tgMessageId,
        currentText: m.currentText,
        hasMedia: m.hasMedia,
      }
    } catch {
      return null
    }
  }

  async getMessageVersions(messageId: string, offset: number, limit: number): Promise<VersionRow[]> {
    try {
      const m = await this.db.archivedMessage.findUnique({
        where: { id: messageId },
        select: { sentAt: true },
      })
      if (!m) return []
      const vs = await this.db.messageVersion.findMany({
        where: { messageId },
        orderBy: { versionNo: 'asc' },
        skip: offset,
        take: limit,
      })
      return vs.map((v) => ({
        versionNo: v.versionNo,
        text: v.text,
        at: v.editDate ?? (v.versionNo === 1 ? m.sentAt : v.capturedAt),
      }))
    } catch {
      return []
    }
  }

  async countMessageVersions(messageId: string): Promise<number> {
    try {
      return await this.db.messageVersion.count({ where: { messageId } })
    } catch {
      return 0
    }
  }

  async getStoredMediaForMessageId(messageId: string): Promise<StoredMediaRef[]> {
    try {
      const media = await this.db.media.findMany({ where: { messageId, state: 'stored' } })
      return media
        .filter((m) => m.storageKey)
        .map((m) => ({
          mediaId: m.id,
          type: m.type as MediaType,
          storageKey: m.storageKey as string,
          fileName: m.fileName,
          mimeType: m.mimeType,
        }))
    } catch {
      return []
    }
  }

  // ── Notification settings ────────────────────────────────────────────────────

  async getSettings(connectionId: string): Promise<NotificationSettings> {
    const conn = await this.connRow(connectionId)
    if (!conn) return { ...DEFAULT_NOTIFICATION_SETTINGS }
    const s = await this.db.notificationSettings.findUnique({ where: { connectionId: conn.id } })
    if (!s) return { ...DEFAULT_NOTIFICATION_SETTINGS }
    return {
      notifyDeletions: s.notifyDeletions,
      notifyEdits: s.notifyEdits,
      notifyMedia: s.notifyMedia,
      groupBatches: s.groupBatches,
      mutedChats: s.mutedChats.map(num),
    }
  }

  async updateSettings(
    connectionId: string,
    patch: Partial<NotificationSettings>,
  ): Promise<NotificationSettings> {
    const conn = await this.connRow(connectionId)
    if (!conn) return { ...DEFAULT_NOTIFICATION_SETTINGS, ...patch }
    const data = {
      ...(patch.notifyDeletions !== undefined ? { notifyDeletions: patch.notifyDeletions } : {}),
      ...(patch.notifyEdits !== undefined ? { notifyEdits: patch.notifyEdits } : {}),
      ...(patch.notifyMedia !== undefined ? { notifyMedia: patch.notifyMedia } : {}),
      ...(patch.groupBatches !== undefined ? { groupBatches: patch.groupBatches } : {}),
      ...(patch.mutedChats !== undefined ? { mutedChats: patch.mutedChats.map(big) } : {}),
    }
    const s = await this.db.notificationSettings.upsert({
      where: { connectionId: conn.id },
      create: { connectionId: conn.id, ...data },
      update: data,
    })
    return {
      notifyDeletions: s.notifyDeletions,
      notifyEdits: s.notifyEdits,
      notifyMedia: s.notifyMedia,
      groupBatches: s.groupBatches,
      mutedChats: s.mutedChats.map(num),
    }
  }

  // ── Query side ──────────────────────────────────────────────────────────────

  private async ownerConnIds(ownerTgUserId: number): Promise<string[]> {
    const rows = await this.db.businessConnection.findMany({
      where: { ownerTgUserId: big(ownerTgUserId) },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  }

  async overview(ownerTgUserId: number): Promise<OverviewDto> {
    const ids = await this.ownerConnIds(ownerTgUserId)
    if (ids.length === 0) return { connections: 0, chats: 0, messages: 0, deleted: 0, edited: 0 }
    const [messages, deletedMsgs, edited, chats, unarchivedDeletes] = await Promise.all([
      this.db.archivedMessage.count({ where: { connectionId: { in: ids } } }),
      this.db.archivedMessage.count({ where: { connectionId: { in: ids }, isDeleted: true } }),
      this.db.archivedMessage.count({ where: { connectionId: { in: ids }, isEdited: true } }),
      this.db.chat.count({ where: { connectionId: { in: ids } } }),
      this.db.deletedEvent.count({ where: { connectionId: { in: ids }, messageId: null } }),
    ])
    return { connections: ids.length, chats, messages, deleted: deletedMsgs + unarchivedDeletes, edited }
  }

  async listChats(ownerTgUserId: number): Promise<ChatDto[]> {
    const ids = await this.ownerConnIds(ownerTgUserId)
    if (ids.length === 0) return []
    const chats = await this.db.chat.findMany({
      where: { connectionId: { in: ids } },
      orderBy: { lastMessageAt: 'desc' },
    })
    const chatIds = chats.map((c) => c.id)
    const [total, deleted] = await Promise.all([
      this.db.archivedMessage.groupBy({ by: ['chatId'], where: { chatId: { in: chatIds } }, _count: { _all: true } }),
      this.db.archivedMessage.groupBy({ by: ['chatId'], where: { chatId: { in: chatIds }, isDeleted: true }, _count: { _all: true } }),
    ])
    const totalMap = new Map(total.map((t) => [t.chatId, t._count._all]))
    const delMap = new Map(deleted.map((t) => [t.chatId, t._count._all]))
    return chats.map((c) => ({
      tgChatId: num(c.tgChatId),
      peerTitle: c.peerTitle,
      peerUsername: c.peerUsername,
      lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
      messageCount: totalMap.get(c.id) ?? 0,
      deletedCount: delMap.get(c.id) ?? 0,
    }))
  }

  async listDeleted(ownerTgUserId: number, limit: number): Promise<DeletedItemDto[]> {
    const ids = await this.ownerConnIds(ownerTgUserId)
    if (ids.length === 0) return []
    const events = await this.db.deletedEvent.findMany({
      where: { connectionId: { in: ids } },
      orderBy: { detectedAt: 'desc' },
      take: limit,
      include: { message: true, chat: true },
    })
    return events.map((e) => ({
      tgChatId: num(e.chat.tgChatId),
      tgMessageId: e.tgMessageId,
      peerLabel: e.chat.peerTitle ?? e.chat.peerUsername ?? null,
      savedText: e.message?.currentText ?? null,
      hasMedia: e.message?.hasMedia ?? false,
      archived: e.message != null,
      sentAt: e.message?.sentAt ? e.message.sentAt.toISOString() : null,
      detectedAt: e.detectedAt.toISOString(),
    }))
  }

  async getMessage(
    ownerTgUserId: number,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<MessageDetailDto | null> {
    const ids = await this.ownerConnIds(ownerTgUserId)
    if (ids.length === 0) return null
    const chats = await this.db.chat.findMany({
      where: { connectionId: { in: ids }, tgChatId: big(tgChatId) },
      select: { id: true },
    })
    if (chats.length === 0) return null
    const m = await this.db.archivedMessage.findFirst({
      where: { chatId: { in: chats.map((c) => c.id) }, tgMessageId },
      include: { versions: { orderBy: { versionNo: 'asc' } } },
    })
    if (!m) return null
    return {
      tgChatId,
      tgMessageId,
      direction: m.direction as MessageDetailDto['direction'],
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

  // ── Media repository ────────────────────────────────────────────────────────

  async listPendingMedia(limit: number, maxAttempts: number): Promise<PendingMediaJob[]> {
    const rows = await this.db.media.findMany({
      where: {
        OR: [{ state: 'pending' }, { state: 'failed', attempts: { lt: maxAttempts } }],
      },
      take: limit,
      include: { message: { include: { chat: true, connection: true } } },
    })
    return rows.map((r) => ({
      mediaId: r.id,
      connectionId: r.message.connection.connectionId,
      tgChatId: num(r.message.chat.tgChatId),
      tgMessageId: r.message.tgMessageId,
      type: r.type as MediaType,
      tgFileId: r.tgFileId,
      attempts: r.attempts,
    }))
  }

  async claimMediaDownload(mediaId: string): Promise<boolean> {
    const res = await this.db.media.updateMany({
      where: { id: mediaId, state: { in: ['pending', 'failed'] } },
      data: { state: 'downloading', attempts: { increment: 1 } },
    })
    return res.count === 1
  }

  async markMediaStored(mediaId: string, meta: MediaStoredMeta): Promise<void> {
    await this.db.media.update({
      where: { id: mediaId },
      data: {
        state: 'stored',
        storageKey: meta.storageKey,
        checksum: meta.checksum,
        sizeBytes: meta.sizeBytes ?? undefined,
        mimeType: meta.mimeType ?? undefined,
        fileName: meta.fileName ?? undefined,
        failedReason: null,
        storedAt: new Date(),
      },
    })
  }

  async markMediaFailed(mediaId: string, reason: string, retryable: boolean): Promise<void> {
    await this.db.media.update({
      where: { id: mediaId },
      data: {
        state: 'failed',
        failedReason: reason.slice(0, 300),
        ...(retryable ? {} : { attempts: PERMANENT_FAILURE_ATTEMPTS }),
      },
    })
  }

  async getStoredMediaForMessage(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<StoredMediaRef[]> {
    const conn = await this.connRow(connectionId)
    if (!conn) return []
    const chat = await this.db.chat.findUnique({
      where: { connectionId_tgChatId: { connectionId: conn.id, tgChatId: big(tgChatId) } },
    })
    if (!chat) return []
    const msg = await this.db.archivedMessage.findUnique({
      where: { connectionId_chatId_tgMessageId: { connectionId: conn.id, chatId: chat.id, tgMessageId } },
      select: { id: true },
    })
    if (!msg) return []
    const media = await this.db.media.findMany({ where: { messageId: msg.id, state: 'stored' } })
    return media
      .filter((m) => m.storageKey)
      .map((m) => ({
        mediaId: m.id,
        type: m.type as MediaType,
        storageKey: m.storageKey as string,
        fileName: m.fileName,
        mimeType: m.mimeType,
      }))
  }
}
