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

/**
 * A parsed callback_query from an inline button press in the owner's chat with
 * the bot. `chatId`/`messageId` identify the message the button lives on (the
 * owner's own chat), and `fromTgId` is the presser — checked against the owner.
 */
export interface IncomingCallback {
  /** callback_query.id — echoed back to answerCallbackQuery. */
  id: string
  /** callback_query.from.id — the Telegram user who pressed the button. */
  fromTgId: number
  /** Chat the button message lives in (the owner's chat with the bot). */
  chatId: number
  /** message_id of the button message. */
  messageId: number
  /** callback_data payload (action:parts…). */
  data: string
}

/** A message as currently stored (returned by the repository). */
export interface StoredMessage {
  /** Internal storage id (uuid) — used to reference the message from callbacks. */
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
