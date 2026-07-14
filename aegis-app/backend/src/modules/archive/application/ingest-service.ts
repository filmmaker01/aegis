import type {
  IncomingBusinessConnection,
  IncomingDeletion,
  IncomingMessage,
} from '../domain/types'
import type { ArchiveRepository, Clock, ConnectionFetcher, Notifier } from './ports'

export interface IngestServiceDeps {
  repository: ArchiveRepository
  notifier: Notifier
  clock: Clock
  /** Optional: resolves a connection on demand (Bot API getBusinessConnection) if not stored. */
  connectionFetcher?: ConnectionFetcher
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
  private readonly notifyUnarchived: boolean

  constructor(deps: IngestServiceDeps) {
    this.repo = deps.repository
    this.notifier = deps.notifier
    this.clock = deps.clock
    this.connectionFetcher = deps.connectionFetcher
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

  async onBusinessMessage(input: IncomingMessage): Promise<void> {
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

    // Tombstone reconciliation: a deletion may have arrived before this message.
    if (await this.repo.hasDeletion(input.connectionId, input.tgChatId, input.tgMessageId)) {
      await this.repo.markMessageDeleted(input.connectionId, input.tgChatId, input.tgMessageId)
      await this.notifyDeletion(input.connectionId, input.tgChatId, input.tgMessageId)
    }
  }

  async onEditedBusinessMessage(input: IncomingMessage): Promise<void> {
    await this.repo.saveMessageVersion({
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
  }

  async onDeletedBusinessMessages(input: IncomingDeletion): Promise<void> {
    const now = this.clock.now()
    for (const tgMessageId of input.tgMessageIds) {
      const { created } = await this.repo.recordDeletion(
        input.connectionId,
        input.tgChatId,
        tgMessageId,
        now,
      )
      if (created) {
        await this.notifyDeletion(input.connectionId, input.tgChatId, tgMessageId)
      }
    }
  }

  private async notifyDeletion(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<void> {
    let connection = await this.repo.getConnection(connectionId)
    if (!connection && this.connectionFetcher) {
      // Self-heal: fetch the connection (user_chat_id) via the Bot API if we missed the event.
      const fetched = await this.connectionFetcher.fetchConnection(connectionId)
      if (fetched) {
        await this.repo.upsertConnection(fetched)
        connection = await this.repo.getConnection(connectionId)
      }
    }
    if (!connection) {
      console.error(`[notify] message_id=${tgMessageId} skipped=no_connection (user_chat_id unknown)`)
      return
    }
    const message = await this.repo.findMessage(connectionId, tgChatId, tgMessageId)
    const archived = message !== null
    if (!archived && !this.notifyUnarchived) return

    await this.notifier.notifyDeletion({
      connectionId,
      ownerTgChatId: connection.tgUserChatId,
      tgChatId,
      tgMessageId,
      savedText: message?.currentText ?? null,
      hasMedia: message?.hasMedia ?? false,
      archived,
    })
    await this.repo.markDeletionNotified(connectionId, tgChatId, tgMessageId, this.clock.now())
  }
}
