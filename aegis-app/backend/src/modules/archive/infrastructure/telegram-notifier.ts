import type { DeletionNotification, Notifier } from '../application/ports'

/** No-op notifier (used when no bot token is configured, e.g. local dev). */
export const noopNotifier: Notifier = {
  async notifyDeletion() {},
}

/**
 * Sends the owner a Telegram DM when a message is deleted, including the saved
 * content we archived on arrival. Uses the official Bot API sendMessage.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly apiRoot = 'https://api.telegram.org',
    private readonly maxAttempts = 3,
  ) {}

  /**
   * Sends the deletion DM to the OWNER's chat with the bot (ownerTgChatId =
   * business_connection.user_chat_id) — NOT the monitored chat.id. Retries a
   * limited number of times on failure / 429 (honoring retry_after). Logs only
   * safe diagnostics (message id, archived flag, http status) — no text/token/PII.
   */
  async notifyDeletion(n: DeletionNotification): Promise<void> {
    const text = this.format(n)
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await fetch(`${this.apiRoot}/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: n.ownerTgChatId, text, disable_web_page_preview: true }),
        })
        if (res.ok) {
          console.log(`[notify] message_id=${n.tgMessageId} archived=${n.archived} result=ok`)
          return
        }
        let waitMs = 500 * attempt
        if (res.status === 429) {
          const body = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null
          if (body?.parameters?.retry_after) waitMs = body.parameters.retry_after * 1000
        }
        console.error(`[notify] message_id=${n.tgMessageId} archived=${n.archived} attempt=${attempt} status=${res.status}`)
        if (attempt < this.maxAttempts) await sleep(waitMs)
      } catch (err) {
        console.error(`[notify] message_id=${n.tgMessageId} attempt=${attempt} error=${(err as Error).message}`)
        if (attempt < this.maxAttempts) await sleep(500 * attempt)
      }
    }
    console.error(`[notify] message_id=${n.tgMessageId} result=FAILED after ${this.maxAttempts} attempts`)
  }

  private format(n: DeletionNotification): string {
    const peer = n.peerLabel ? ` with ${n.peerLabel}` : ''
    if (!n.archived) {
      return `🗑 A message in your chat${peer} was deleted, but its content was not in your archive (it predates monitoring).`
    }
    const parts: string[] = [`🗑 A deleted message in your chat${peer}:`]
    if (n.savedText) parts.push('', n.savedText)
    if (n.hasMedia) parts.push('', '📎 (had media — open the app to view the saved copy)')
    if (!n.savedText && !n.hasMedia) parts.push('', '(no text content)')
    return parts.join('\n')
  }
}
