import type {
  ChatDto,
  DeletedItemDto,
  MessageDetailDto,
  OverviewDto,
  QueryRepository,
} from './query-ports'

const DEFAULT_DELETED_LIMIT = 50
const MAX_DELETED_LIMIT = 200

/** Read-side application service for the Mini App. All calls are owner-scoped. */
export class QueryService {
  constructor(private readonly repo: QueryRepository) {}

  overview(ownerTgUserId: number): Promise<OverviewDto> {
    return this.repo.overview(ownerTgUserId)
  }

  chats(ownerTgUserId: number): Promise<ChatDto[]> {
    return this.repo.listChats(ownerTgUserId)
  }

  deleted(ownerTgUserId: number, limit?: number): Promise<DeletedItemDto[]> {
    const clamped = Math.min(Math.max(1, limit ?? DEFAULT_DELETED_LIMIT), MAX_DELETED_LIMIT)
    return this.repo.listDeleted(ownerTgUserId, clamped)
  }

  message(
    ownerTgUserId: number,
    tgChatId: number,
    tgMessageId: number,
  ): Promise<MessageDetailDto | null> {
    return this.repo.getMessage(ownerTgUserId, tgChatId, tgMessageId)
  }
}
