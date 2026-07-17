import type { InlineKeyboardMarkup, SendResult, TelegramBotClient } from '../../telegram'
import type { DeliveryResult, TaskNotifier } from '../application/ports'
import type { Task } from '../domain/types'
import { reminderCard, reminderKeyboard } from '../notification/format'

/**
 * Telegram descriptions that mean "retrying will never help": the user is gone or
 * has cut the bot off. Matched on the description because the Bot API reuses 400
 * and 403 for both permanent and transient conditions.
 */
const PERMANENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /bot was blocked by the user/i, reason: 'blocked_by_user' },
  { pattern: /user is deactivated/i, reason: 'user_deactivated' },
  { pattern: /chat not found/i, reason: 'chat_not_found' },
  { pattern: /bot can't initiate conversation/i, reason: 'no_conversation' },
  { pattern: /bot was kicked/i, reason: 'bot_kicked' },
  { pattern: /have no rights to send a message/i, reason: 'no_rights' },
]

/** Classify a Bot API response into a delivery outcome. */
export function classifySendResult(res: SendResult): DeliveryResult {
  if (res.ok) return { outcome: 'sent' }

  const description = res.description ?? ''

  for (const { pattern, reason } of PERMANENT_PATTERNS) {
    if (pattern.test(description)) return { outcome: 'permanent', reason }
  }

  // Rate limited: Telegram tells us exactly how long to wait.
  if (res.status === 429) {
    return {
      outcome: 'retry',
      reason: 'rate_limited',
      ...(res.retryAfterSeconds !== undefined ? { retryAfterSeconds: res.retryAfterSeconds } : {}),
    }
  }

  // 403 that did not match a known description: still treat as permanent — 403
  // always means the bot may not talk to this chat.
  if (res.status === 403) return { outcome: 'permanent', reason: 'forbidden' }

  // A 400 we do not recognise is a malformed request, which a retry cannot fix.
  // Fail it rather than burn the attempt budget on a guaranteed-identical result.
  if (res.status === 400) return { outcome: 'permanent', reason: 'bad_request' }

  // 5xx, 502 from a proxy, anything else: transient.
  return { outcome: 'retry', reason: `http_${res.status}` }
}

/** Sends fired reminders to the owner's private chat with the bot. */
export class TelegramTaskNotifier implements TaskNotifier {
  constructor(private readonly client: TelegramBotClient) {}

  async sendReminder(chatId: number, task: Task): Promise<DeliveryResult> {
    const res = await this.client.sendMessage(chatId, reminderCard(task), {
      parseMode: 'HTML',
      replyMarkup: reminderKeyboard(task.id) as InlineKeyboardMarkup,
    })
    const result = classifySendResult(res)
    if (result.outcome !== 'sent') {
      // Safe diagnostics: status + classified reason only, never the title or chat id.
      console.error(`[reminders] delivery ${result.outcome} status=${res.status} reason=${result.reason}`)
    }
    return result
  }
}

/** Used when no bot token is configured (local dev): drops reminders silently. */
export const noopNotifier: TaskNotifier = {
  async sendReminder() {
    return { outcome: 'sent' }
  },
}
