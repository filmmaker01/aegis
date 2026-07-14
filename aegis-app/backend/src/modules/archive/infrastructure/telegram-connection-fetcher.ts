import type { IncomingBusinessConnection } from '../domain/types'
import type { ConnectionFetcher } from '../application/ports'
import { toIncomingConnection } from '../../telegram/updates'

/**
 * Fetches a business connection via the Bot API `getBusinessConnection` method
 * (returns user_chat_id). Used to recover when the `business_connection` webhook
 * event was missed or the store was reset — so deletions can still be routed to
 * the owner's chat.
 */
export class TelegramConnectionFetcher implements ConnectionFetcher {
  constructor(
    private readonly botToken: string,
    private readonly apiRoot = 'https://api.telegram.org',
  ) {}

  async fetchConnection(connectionId: string): Promise<IncomingBusinessConnection | null> {
    try {
      const res = await fetch(`${this.apiRoot}/bot${this.botToken}/getBusinessConnection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_connection_id: connectionId }),
      })
      const json = (await res.json()) as { ok: boolean; result?: unknown; error_code?: number }
      if (!json.ok || !json.result) {
        console.error(`[fetch-conn] ${connectionId.slice(0, 4)}… failed status=${res.status} code=${json.error_code ?? '?'}`)
        return null
      }
      const parsed = toIncomingConnection(json.result as Parameters<typeof toIncomingConnection>[0])
      console.log(`[fetch-conn] ${connectionId.slice(0, 4)}… resolved=${parsed != null}`)
      return parsed
    } catch (err) {
      console.error(`[fetch-conn] ${connectionId.slice(0, 4)}… error=${(err as Error).message}`)
      return null
    }
  }
}
