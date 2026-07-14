import { readTelegramContext } from './telegram'

const baseUrl = (import.meta.env?.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')

export interface Overview {
  connections: number
  chats: number
  messages: number
  deleted: number
  edited: number
}

export interface DeletedItem {
  tgChatId: number
  tgMessageId: number
  peerLabel?: string | null
  savedText?: string | null
  hasMedia: boolean
  archived: boolean
  sentAt?: string | null
  detectedAt: string
}

export interface ChatItem {
  tgChatId: number
  peerTitle?: string | null
  peerUsername?: string | null
  lastMessageAt?: string | null
  messageCount: number
  deletedCount: number
}

export class AegisApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function get<T>(path: string): Promise<T> {
  const tg = readTelegramContext()
  const headers: Record<string, string> = {}
  if (tg.initData) headers['Authorization'] = `tma ${tg.initData}`

  const res = await fetch(`${baseUrl}/api/archive${path}`, { headers })
  if (!res.ok) {
    throw new AegisApiError(res.status, `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export const aegisApi = {
  overview: () => get<Overview>('/overview'),
  deleted: (limit = 50) => get<{ items: DeletedItem[] }>(`/deleted?limit=${limit}`),
  chats: () => get<{ items: ChatItem[] }>('/chats'),
}

/** True when running inside Telegram with initData available (API calls will authenticate). */
export function canQuery(): boolean {
  return readTelegramContext().initData.length > 0
}
