import type { DeletionNotification, Notifier } from '../application/ports'

/** No-op notifier (used when no bot token is configured, e.g. local dev). */
export const noopNotifier: Notifier = {
  async notifyDeletion() {},
}

/**
 * Sends the owner a Telegram DM when a message is deleted, including the saved
 * content we archived on arrival. Uses the official Bot API sendMessage.
 */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly apiRoot = 'https://api.telegram.org',
  ) {}

  async notifyDeletion(n: DeletionNotification): Promise<void> {
    const text = this.format(n)
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: n.ownerTgChatId, text, disable_web_page_preview: true }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[notifier] sendMessage failed', res.status, body.slice(0, 200))
    }
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
