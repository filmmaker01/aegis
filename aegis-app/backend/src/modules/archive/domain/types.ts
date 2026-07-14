/**
 * Archive domain types.
 *
 * These are the CLEAN, already-parsed inputs the ingest service works with —
 * intentionally decoupled from raw Telegram payloads (mapping raw Update ->
 * these lives in the telegram transport layer) and from Prisma (persistence
 * lives behind the repository port). This keeps the core logic unit-testable
 * without a database or a Telegram connection.
 */

export type MediaType =
  | 'photo'
  | 'voice'
  | 'video'
  | 'video_note'
  | 'audio'
  | 'document'
  | 'animation'
  | 'sticker'

export type MessageDirection = 'incoming' | 'outgoing'

export type ConnectionState = 'active' | 'disabled' | 'revoked'

export interface MediaItem {
  type: MediaType
  tgFileId: string
  tgFileUniqueId?: string
  mimeType?: string
  sizeBytes?: number
}

export interface IncomingBusinessConnection {
  connectionId: string
  ownerTgUserId: number
  tgUserChatId: number
  rights: Record<string, boolean>
  isEnabled: boolean
  connectedAt: Date
}

export interface IncomingMessage {
  connectionId: string
  tgChatId: number
  tgMessageId: number
  direction: MessageDirection
  fromTgId?: number
  sentAt: Date
  /** Present only for edits. */
  editDate?: Date
  text?: string | null
  media: MediaItem[]
  peerTitle?: string | null
  peerUsername?: string | null
  /** Full raw Message payload, stored for audit / later re-parsing. */
  raw: unknown
}

export interface IncomingDeletion {
  connectionId: string
  tgChatId: number
  tgMessageIds: number[]
}

/** A message as currently stored (returned by the repository). */
export interface StoredMessage {
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
  versionCount: number
}

/** A stored connection (returned by the repository), used to route notifications. */
export interface StoredConnection {
  connectionId: string
  ownerTgUserId: number
  tgUserChatId: number
  state: ConnectionState
  rights: Record<string, boolean>
}
