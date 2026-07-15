import type {
  ConnectionState,
  IncomingBusinessConnection,
  IncomingMessage,
  MediaItem,
  MessageDirection,
  StoredConnection,
  StoredMessage,
} from '../domain/types'
import type { StoredMediaRef } from './media-ports'

export interface Clock {
  now(): Date
}

export interface SaveMessageVersionInput {
  connectionId: string
  tgChatId: number
  tgMessageId: number
  direction: MessageDirection
  fromTgId?: number
  sentAt: Date
  editDate?: Date
  text?: string | null
  hasMedia: boolean
  media: MediaItem[]
  peerTitle?: string | null
  peerUsername?: string | null
  raw: unknown
}

/**
 * Persistence port for ingestion. All methods are keyed by Telegram natural
 * keys (connectionId + tgChatId + tgMessageId); the implementation resolves
 * internal ids. Implementations MUST be idempotent where noted.
 */
export interface ArchiveRepository {
  /** Atomically claim an update_id. Returns true if newly claimed, false if already processed. */
  claimUpdate(updateId: number): Promise<boolean>

  upsertConnection(input: IncomingBusinessConnection): Promise<void>
  setConnectionState(connectionId: string, state: ConnectionState, at: Date): Promise<void>
  getConnection(connectionId: string): Promise<StoredConnection | null>

  /** Create the chat if absent; update peer labels + lastMessageAt when provided. */
  upsertChat(input: {
    connectionId: string
    tgChatId: number
    peerTitle?: string | null
    peerUsername?: string | null
    lastMessageAt?: Date | null
  }): Promise<void>

  findMessage(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<StoredMessage | null>

  /**
   * Upsert the message row (create if missing) and append a new version.
   * Sets currentText/hasMedia; sets isEdited when editDate is present.
   * De-duplicates identical re-deliveries (same text + same version content).
   * Returns the stored message after the write.
   */
  saveMessageVersion(input: SaveMessageVersionInput): Promise<StoredMessage>

  markMessageDeleted(connectionId: string, tgChatId: number, tgMessageId: number): Promise<void>

  /** Has a deletion already been recorded for this message id? (tombstone check) */
  hasDeletion(connectionId: string, tgChatId: number, tgMessageId: number): Promise<boolean>

  /**
   * Idempotently record a deletion event. Returns whether it was newly created
   * and whether an archived message existed for it.
   */
  recordDeletion(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    detectedAt: Date,
  ): Promise<{ created: boolean; message: StoredMessage | null }>

  markDeletionNotified(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    at: Date,
  ): Promise<void>
}

export interface DeletionNotification {
  connectionId: string
  /** Telegram chat id to send the notification to (the owner's chat with the bot). */
  ownerTgChatId: number
  tgChatId: number
  tgMessageId: number
  /** Saved text of the deleted message, if we had archived it. */
  savedText?: string | null
  hasMedia: boolean
  /** Stored media (state=stored) to send back; empty if none stored yet. */
  media: StoredMediaRef[]
  /** False when the deleted message was never in our archive (e.g. pre-connection history). */
  archived: boolean
  peerLabel?: string | null
}

export interface Notifier {
  notifyDeletion(notification: DeletionNotification): Promise<void>
}

/**
 * Resolves a business connection we haven't stored yet (e.g. the connection
 * event was missed, or the store was reset). Backed by the Bot API
 * getBusinessConnection method, which returns user_chat_id.
 */
export interface ConnectionFetcher {
  fetchConnection(connectionId: string): Promise<IncomingBusinessConnection | null>
}
