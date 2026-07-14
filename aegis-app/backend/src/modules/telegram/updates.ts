import type { IngestService } from '../archive/application/ingest-service'
import type {
  IncomingBusinessConnection,
  IncomingDeletion,
  IncomingMessage,
  MediaItem,
  MediaType,
} from '../archive/domain/types'

/** Minimal raw Telegram shapes (permissive — we only read what we map). */
interface RawUser {
  id: number
  [k: string]: unknown
}
interface RawChat {
  id: number
  type?: string
  title?: string
  first_name?: string
  username?: string
  [k: string]: unknown
}
interface RawFile {
  file_id: string
  file_unique_id?: string
  mime_type?: string
  file_size?: number
  [k: string]: unknown
}
interface RawMessage {
  message_id: number
  business_connection_id?: string
  from?: RawUser
  chat?: RawChat
  date?: number
  edit_date?: number
  text?: string
  caption?: string
  sender_business_bot?: RawUser
  photo?: RawFile[]
  voice?: RawFile
  video?: RawFile
  video_note?: RawFile
  audio?: RawFile
  document?: RawFile
  animation?: RawFile
  sticker?: RawFile
  [k: string]: unknown
}
interface RawBusinessConnection {
  id: string
  user?: RawUser
  user_chat_id?: number
  date?: number
  rights?: Record<string, boolean>
  is_enabled?: boolean
  [k: string]: unknown
}
interface RawDeleted {
  business_connection_id: string
  chat: RawChat
  message_ids: number[]
}
export interface RawUpdate {
  update_id: number
  business_connection?: RawBusinessConnection
  business_message?: RawMessage
  edited_business_message?: RawMessage
  deleted_business_messages?: RawDeleted
  [k: string]: unknown
}

const SIMPLE_MEDIA: MediaType[] = [
  'voice',
  'video',
  'video_note',
  'audio',
  'document',
  'animation',
  'sticker',
]

function extractMedia(m: RawMessage): MediaItem[] {
  const items: MediaItem[] = []
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!
    items.push({
      type: 'photo',
      tgFileId: largest.file_id,
      tgFileUniqueId: largest.file_unique_id,
      sizeBytes: largest.file_size,
    })
  }
  for (const type of SIMPLE_MEDIA) {
    const f = m[type] as RawFile | undefined
    if (f?.file_id) {
      items.push({
        type,
        tgFileId: f.file_id,
        tgFileUniqueId: f.file_unique_id,
        mimeType: f.mime_type,
        sizeBytes: f.file_size,
      })
    }
  }
  return items
}

function peerLabels(chat?: RawChat): { peerTitle?: string | null; peerUsername?: string | null } {
  return {
    peerTitle: chat?.title ?? chat?.first_name ?? null,
    peerUsername: chat?.username ?? null,
  }
}

/**
 * Direction heuristic for a private business chat: chat.id equals the partner's
 * user id, so a message whose sender is the partner is incoming; anything sent
 * on behalf of the owner (owner's own id, or via sender_business_bot) is outgoing.
 */
function directionOf(m: RawMessage): 'incoming' | 'outgoing' {
  if (m.sender_business_bot) return 'outgoing'
  if (m.from && m.chat && m.from.id !== m.chat.id) return 'outgoing'
  return 'incoming'
}

export function toIncomingMessage(m: RawMessage): IncomingMessage | null {
  if (!m.business_connection_id || !m.chat) return null
  const media = extractMedia(m)
  return {
    connectionId: m.business_connection_id,
    tgChatId: m.chat.id,
    tgMessageId: m.message_id,
    direction: directionOf(m),
    fromTgId: m.from?.id,
    sentAt: m.date ? new Date(m.date * 1000) : new Date(),
    editDate: m.edit_date ? new Date(m.edit_date * 1000) : undefined,
    text: m.text ?? m.caption ?? null,
    media,
    ...peerLabels(m.chat),
    raw: m,
  }
}

export function toIncomingConnection(bc: RawBusinessConnection): IncomingBusinessConnection | null {
  if (!bc.id || !bc.user || bc.user_chat_id == null) return null
  return {
    connectionId: bc.id,
    ownerTgUserId: bc.user.id,
    tgUserChatId: bc.user_chat_id,
    rights: bc.rights ?? {},
    isEnabled: bc.is_enabled ?? false,
    connectedAt: bc.date ? new Date(bc.date * 1000) : new Date(),
  }
}

export function toIncomingDeletion(d: RawDeleted): IncomingDeletion {
  return {
    connectionId: d.business_connection_id,
    tgChatId: d.chat.id,
    tgMessageIds: d.message_ids ?? [],
  }
}

/**
 * Routes a raw Update to the ingest service. Applies update-level idempotency
 * (claimUpdate) so replayed updates are ignored. Returns the handled type or null.
 */
export async function dispatchUpdate(
  update: RawUpdate,
  ingest: IngestService,
): Promise<string | null> {
  if (typeof update.update_id !== 'number') return null
  const claimed = await ingest.claim(update.update_id)
  if (!claimed) {
    console.log(`[ingest] update_id=${update.update_id} type=duplicate (skipped)`)
    return 'duplicate'
  }

  // Safe diagnostics only: type, update_id, message id(s). Never text/PII/tokens.
  if (update.business_connection) {
    console.log(`[ingest] update_id=${update.update_id} type=business_connection`)
    const parsed = toIncomingConnection(update.business_connection)
    if (parsed) await ingest.onBusinessConnection(parsed)
    return 'business_connection'
  }
  if (update.business_message) {
    console.log(`[ingest] update_id=${update.update_id} type=business_message message_id=${update.business_message.message_id}`)
    const parsed = toIncomingMessage(update.business_message)
    if (parsed) await ingest.onBusinessMessage(parsed)
    return 'business_message'
  }
  if (update.edited_business_message) {
    console.log(`[ingest] update_id=${update.update_id} type=edited_business_message message_id=${update.edited_business_message.message_id}`)
    const parsed = toIncomingMessage(update.edited_business_message)
    if (parsed) await ingest.onEditedBusinessMessage(parsed)
    return 'edited_business_message'
  }
  if (update.deleted_business_messages) {
    const ids = update.deleted_business_messages.message_ids ?? []
    console.log(`[ingest] update_id=${update.update_id} type=deleted_business_messages count=${ids.length} message_ids=[${ids.join(',')}]`)
    await ingest.onDeletedBusinessMessages(toIncomingDeletion(update.deleted_business_messages))
    return 'deleted_business_messages'
  }
  console.log(`[ingest] update_id=${update.update_id} type=ignored`)
  return 'ignored'
}
