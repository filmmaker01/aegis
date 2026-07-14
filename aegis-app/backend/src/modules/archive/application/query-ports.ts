import type { MessageDirection } from '../domain/types'

export interface OverviewDto {
  connections: number
  chats: number
  messages: number
  deleted: number
  edited: number
}

export interface ChatDto {
  tgChatId: number
  peerTitle?: string | null
  peerUsername?: string | null
  lastMessageAt?: string | null
  messageCount: number
  deletedCount: number
}

export interface DeletedItemDto {
  tgChatId: number
  tgMessageId: number
  peerLabel?: string | null
  savedText?: string | null
  hasMedia: boolean
  /** True when we had archived the message; false for pre-archive/pre-connection deletions. */
  archived: boolean
  sentAt?: string | null
  detectedAt: string
}

export interface MessageVersionDto {
  versionNo: number
  text?: string | null
  editDate?: string | null
}

export interface MessageDetailDto {
  tgChatId: number
  tgMessageId: number
  direction: MessageDirection
  sentAt: string
  currentText?: string | null
  isEdited: boolean
  isDeleted: boolean
  hasMedia: boolean
  versions: MessageVersionDto[]
}

/** Read-side port. All queries are scoped to the owner (Telegram user id). */
export interface QueryRepository {
  overview(ownerTgUserId: number): Promise<OverviewDto>
  listChats(ownerTgUserId: number): Promise<ChatDto[]>
  listDeleted(ownerTgUserId: number, limit: number): Promise<DeletedItemDto[]>
  getMessage(
    ownerTgUserId: number,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<MessageDetailDto | null>
}
