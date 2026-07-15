import type {
  IncomingBusinessConnection,
  IncomingDeletion,
  IncomingMessage,
  MediaType,
  StoredConnection,
  StoredMessage,
} from '../domain/types'
import type { ArchiveRepository, Clock, ConnectionFetcher, Notifier } from './ports'
import type { MediaRepository } from './media-ports'

/** One newly-recorded deletion, collected while processing a delete update. */
interface RecordedDeletion {
  eventId: string
  message: StoredMessage | null
  tgMessageId: number
}

export interface IngestServiceDeps {
  repository: ArchiveRepository
  notifier: Notifier
  clock: Clock
  /** Optional: resolves a connection on demand (Bot API getBusinessConnection) if not stored. */
  connectionFetcher?: ConnectionFetcher
  /** Optional: fire-and-forget trigger to process pending media downloads. */
  mediaTrigger?: () => void
  /** Optional: reads stored media to attach to deletion notifications. */
  mediaReader?: Pick<MediaRepository, 'getStoredMediaForMessage'>
  /** Whether to notify the owner when a deletion has no archived content. Default true. */
  notifyUnarchivedDeletions?: boolean
}

/**
 * Core ingestion. Idempotent and order-tolerant:
 *  - update-level idempotency via claimUpdate(update_id)
 *  - natural-key upserts (duplicate/replayed updates merge, never duplicate)
 *  - tombstone-first reconciliation: a delete that arrives before its message
 *    is remembered; when the message later arrives it is marked deleted
 */
export class IngestService {
  private readonly repo: ArchiveRepository
  private readonly notifier: Notifier
  private readonly clock: Clock
  private readonly connectionFetcher?: ConnectionFetcher
  private readonly mediaTrigger?: () => void
  private readonly mediaReader?: Pick<MediaRepository, 'getStoredMediaForMessage'>
  private readonly notifyUnarchived: boolean

  constructor(deps: IngestServiceDeps) {
    this.repo = deps.repository
    this.notifier = deps.notifier
    this.clock = deps.clock
    this.connectionFetcher = deps.connectionFetcher
    this.mediaTrigger = deps.mediaTrigger
    this.mediaReader = deps.mediaReader
    this.notifyUnarchived = deps.notifyUnarchivedDeletions ?? true
  }

  /** Returns false if the update_id was already processed (duplicate). */
  async claim(updateId: number): Promise<boolean> {
    return this.repo.claimUpdate(updateId)
  }

  async onBusinessConnection(input: IncomingBusinessConnection): Promise<void> {
    await this.repo.upsertConnection(input)
    if (!input.isEnabled) {
      await this.repo.setConnectionState(input.connectionId, 'revoked', this.clock.now())
    }
  }

  /**
   * Ensures the connection is stored (fetching user_chat_id via the Bot API if
   * the connection event was missed). The Prisma repo requires the connection to
   * exist before storing messages, so this must run before any write.
   */
  private async ensureConnection(connectionId: string): Promise<boolean> {
    if (await this.repo.getConnection(connectionId)) return true
    if (!this.connectionFetcher) return false
    const fetched = await this.connectionFetcher.fetchConnection(connectionId)
    if (!fetched) return false
    await this.repo.upsertConnection(fetched)
    return true
  }

  async onBusinessMessage(input: IncomingMessage): Promise<void> {
    if (!(await this.ensureConnection(input.connectionId))) {
      console.error(`[ingest] message_id=${input.tgMessageId} skipped=no_connection`)
      return
    }
    await this.repo.upsertChat({
      connectionId: input.connectionId,
      tgChatId: input.tgChatId,
      peerTitle: input.peerTitle,
      peerUsername: input.peerUsername,
      lastMessageAt: input.sentAt,
    })

    await this.repo.saveMessageVersion({
      connectionId: input.connectionId,
      tgChatId: input.tgChatId,
      tgMessageId: input.tgMessageId,
      direction: input.direction,
      fromTgId: input.fromTgId,
      sentAt: input.sentAt,
      text: input.text,
      hasMedia: input.media.length > 0,
      media: input.media,
      peerTitle: input.peerTitle,
      peerUsername: input.peerUsername,
      raw: input.raw,
    })

    // Download media on arrival (fire-and-forget; the webhook ack is not blocked).
    if (input.media.length > 0) this.mediaTrigger?.()

    // Tombstone reconciliation: a deletion may have arrived before this message.
    // Now that content exists, re-send a single card with the saved copy.
    if (await this.repo.hasDeletion(input.connectionId, input.tgChatId, input.tgMessageId)) {
      const now = this.clock.now()
      const res = await this.repo.recordDeletion(input.connectionId, input.tgChatId, input.tgMessageId, now)
      if (!res.eventId || (!res.message && !this.notifyUnarchived)) return
      const connection = await this.repo.getConnection(input.connectionId)
      if (!connection) return
      const peer = await this.repo.getChatPeer(input.connectionId, input.tgChatId)
      await this.sendSingleDeletion(
        connection,
        input.connectionId,
        input.tgChatId,
        { eventId: res.eventId, message: res.message, tgMessageId: input.tgMessageId },
        peer,
        now,
      )
      await this.repo.markDeletionNotified(input.connectionId, input.tgChatId, input.tgMessageId, this.clock.now())
    }
  }

  async onEditedBusinessMessage(input: IncomingMessage): Promise<void> {
    if (!(await this.ensureConnection(input.connectionId))) {
      console.error(`[ingest] edited message_id=${input.tgMessageId} skipped=no_connection`)
      return
    }
    // Capture prior state so we can (a) show before/after and (b) tell a real
    // edit apart from an idempotent re-delivery (which appends no new version).
    const prior = await this.repo.findMessage(input.connectionId, input.tgChatId, input.tgMessageId)
    const stored = await this.repo.saveMessageVersion({
      connectionId: input.connectionId,
      tgChatId: input.tgChatId,
      tgMessageId: input.tgMessageId,
      direction: input.direction,
      fromTgId: input.fromTgId,
      sentAt: input.sentAt,
      editDate: input.editDate ?? this.clock.now(),
      text: input.text,
      hasMedia: input.media.length > 0,
      media: input.media,
      peerTitle: input.peerTitle,
      peerUsername: input.peerUsername,
      raw: input.raw,
    })
    if (input.media.length > 0) this.mediaTrigger?.()

    // Notify only when a genuinely new version was appended over a message we
    // already had (so we have a real "before"). First-seen or duplicate → skip.
    if (prior && stored.versionCount > prior.versionCount) {
      const connection = await this.repo.getConnection(input.connectionId)
      if (!connection) return
      await this.notifier.notifyEdit({
        connectionId: input.connectionId,
        ownerTgChatId: connection.tgUserChatId,
        tgChatId: input.tgChatId,
        tgMessageId: input.tgMessageId,
        messageId: stored.id,
        before: prior.currentText ?? null,
        after: stored.currentText ?? null,
        peerTitle: input.peerTitle ?? null,
        peerUsername: input.peerUsername ?? null,
        at: input.editDate ?? this.clock.now(),
      })
    }
  }

  async onDeletedBusinessMessages(input: IncomingDeletion): Promise<void> {
    // Ensure the connection is known so recordDeletion can attach to it and we
    // can route the notification to user_chat_id.
    if (!(await this.ensureConnection(input.connectionId))) {
      console.error(`[ingest] delete for ${input.tgMessageIds.length} msg(s) skipped=no_connection`)
      return
    }
    const now = this.clock.now()

    // Record every id first; collect only the newly-created events (idempotency:
    // re-delivered deletes create nothing and must not re-notify).
    const created: RecordedDeletion[] = []
    for (const tgMessageId of input.tgMessageIds) {
      const res = await this.repo.recordDeletion(input.connectionId, input.tgChatId, tgMessageId, now)
      if (res.created && res.eventId) {
        created.push({ eventId: res.eventId, message: res.message, tgMessageId })
      }
    }

    const toNotify = created.filter((c) => this.notifyUnarchived || c.message !== null)
    if (toNotify.length === 0) return

    const connection = await this.repo.getConnection(input.connectionId)
    if (!connection) {
      console.error(`[notify] chat=${input.tgChatId} skipped=no_connection (user_chat_id unknown)`)
      return
    }
    const peer = await this.repo.getChatPeer(input.connectionId, input.tgChatId)

    // Group a bulk delete into ONE card; a single deletion keeps its full card.
    if (toNotify.length === 1) {
      await this.sendSingleDeletion(connection, input.connectionId, input.tgChatId, toNotify[0]!, peer, now)
    } else {
      await this.sendBatchDeletion(connection, input.connectionId, input.tgChatId, toNotify, peer, now)
    }

    for (const c of toNotify) {
      await this.repo.markDeletionNotified(input.connectionId, input.tgChatId, c.tgMessageId, this.clock.now())
    }
  }

  private async sendSingleDeletion(
    connection: StoredConnection,
    connectionId: string,
    tgChatId: number,
    c: RecordedDeletion,
    peer: { peerTitle: string | null; peerUsername: string | null } | null,
    at: Date,
  ): Promise<void> {
    const message = c.message
    const archived = message !== null
    const media =
      archived && this.mediaReader
        ? await this.mediaReader.getStoredMediaForMessage(connectionId, tgChatId, c.tgMessageId)
        : []
    await this.notifier.notifyDeletion({
      connectionId,
      ownerTgChatId: connection.tgUserChatId,
      tgChatId,
      tgMessageId: c.tgMessageId,
      eventId: c.eventId,
      messageId: message?.id ?? null,
      savedText: message?.currentText ?? null,
      hasMedia: message?.hasMedia ?? false,
      hasHistory: (message?.versionCount ?? 0) > 1,
      media,
      archived,
      peerTitle: peer?.peerTitle ?? null,
      peerUsername: peer?.peerUsername ?? null,
      at,
    })
  }

  private async sendBatchDeletion(
    connection: StoredConnection,
    connectionId: string,
    tgChatId: number,
    created: RecordedDeletion[],
    peer: { peerTitle: string | null; peerUsername: string | null } | null,
    at: Date,
  ): Promise<void> {
    // The card renders only the first few previews; resolve those cheaply.
    const previews = await Promise.all(
      created.slice(0, 5).map(async (c) => {
        const message = c.message
        let mediaTypes: MediaType[] = []
        if (message && message.hasMedia && this.mediaReader) {
          const media = await this.mediaReader.getStoredMediaForMessage(connectionId, tgChatId, c.tgMessageId)
          mediaTypes = media.map((m) => m.type)
        }
        return { savedText: message?.currentText ?? null, mediaTypes }
      }),
    )
    await this.notifier.notifyBatchDeletion({
      connectionId,
      ownerTgChatId: connection.tgUserChatId,
      tgChatId,
      eventId: created[0]!.eventId,
      count: created.length,
      previews,
      peerTitle: peer?.peerTitle ?? null,
      peerUsername: peer?.peerUsername ?? null,
      at,
    })
  }
}
