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
   * Idempotently record a deletion event. Returns whether it was newly created,
   * whether an archived message existed for it, and the deletion event id (used
   * to reference the event from callback buttons). eventId is null only when the
   * connection is unknown and nothing could be recorded.
   */
  recordDeletion(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    detectedAt: Date,
  ): Promise<{ created: boolean; message: StoredMessage | null; eventId: string | null }>

  markDeletionNotified(
    connectionId: string,
    tgChatId: number,
    tgMessageId: number,
    at: Date,
  ): Promise<void>

  /** Peer labels for a chat (title / @username), used to render notification cards. */
  getChatPeer(
    connectionId: string,
    tgChatId: number,
  ): Promise<{ peerTitle: string | null; peerUsername: string | null } | null>

  // ── Callback-flow reads (ownership + restore/history) ──────────────────────
  //
  // These resolve an opaque id from a callback_data payload back to its owner so
  // the callback service can enforce that callback_query.from.id is the owner
  // before doing anything. Unknown/invalid ids resolve to null (anti-enumeration:
  // the caller answers with a neutral "unavailable" and never reveals existence).

  /** Resolve a deletion event id -> owner + natural keys + archived message id. */
  getEventForCallback(eventId: string): Promise<CallbackEventRef | null>

  /** Resolve an internal message id -> owner + natural keys + current content. */
  getMessageForCallback(messageId: string): Promise<CallbackMessageRef | null>

  /** A page of stored versions (ascending by versionNo) for the history view. */
  getMessageVersions(messageId: string, offset: number, limit: number): Promise<VersionRow[]>

  /** Total stored versions for a message (for history pagination). */
  countMessageVersions(messageId: string): Promise<number>

  /** Stored media for a message by its internal id (used when re-sending on restore). */
  getStoredMediaForMessageId(messageId: string): Promise<StoredMediaRef[]>
}

/** Owner + natural keys resolved from a deletion event id. */
export interface CallbackEventRef {
  eventId: string
  ownerTgUserId: number
  connectionId: string
  tgChatId: number
  tgMessageId: number
  /** Internal id of the archived message, or null for an unarchived deletion. */
  messageId: string | null
}

/** Owner + natural keys + current content resolved from an internal message id. */
export interface CallbackMessageRef {
  messageId: string
  ownerTgUserId: number
  connectionId: string
  tgChatId: number
  tgMessageId: number
  currentText: string | null
  hasMedia: boolean
}

/** One stored version, for the history view. */
export interface VersionRow {
  versionNo: number
  text: string | null
  /** Original send time for v1, edit time for later versions (best-effort). */
  at: Date | null
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
