export interface SendResult {
  ok: boolean
  status: number
  description?: string
  /** message_id of the sent message, when the API returned one. */
  messageId?: number
  /** Bot API `parameters.retry_after` (seconds), sent with a 429. */
  retryAfterSeconds?: number
}

/** Structural inline-keyboard shape (matches the notification format module). */
export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>
}

export interface SendMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2'
  replyMarkup?: InlineKeyboardMarkup
  disablePreview?: boolean
}

export interface BotCommand {
  command: string
  description: string
}

/**
 * Bot API client for the planner's outbound calls: sending cards, editing them
 * in place, acknowledging button presses, and publishing the command list.
 *
 * Never logs message text, tokens, or user ids.
 */
export class TelegramBotClient {
  constructor(
    private readonly botToken: string,
    private readonly apiRoot = 'https://api.telegram.org',
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return toSendResult(res)
  }

  /** Text message. Supports HTML/MarkdownV2 parse mode and an inline keyboard. */
  async sendMessage(chatId: number, text: string, options: SendMessageOptions = {}): Promise<SendResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: options.disablePreview ?? true,
    }
    if (options.parseMode) body.parse_mode = options.parseMode
    if (options.replyMarkup) body.reply_markup = options.replyMarkup
    return this.call('sendMessage', body)
  }

  /**
   * Replace an existing message's text and keyboard — the planner edits its cards
   * in place instead of stacking new ones in the chat.
   */
  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<SendResult> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: options.disablePreview ?? true,
    }
    if (options.parseMode) body.parse_mode = options.parseMode
    // An absent reply_markup clears the keyboard, which is what callers want when
    // they omit it (e.g. a completed reminder keeps no buttons).
    if (options.replyMarkup) body.reply_markup = options.replyMarkup
    return this.call('editMessageText', body)
  }

  /** Acknowledge a callback query (stops the client spinner; optional toast/alert). */
  async answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ): Promise<SendResult> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
    if (options.text) body.text = options.text
    if (options.showAlert) body.show_alert = true
    return this.call('answerCallbackQuery', body)
  }

  /** Replace (or clear) the inline keyboard on an existing message. */
  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<SendResult> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId }
    if (replyMarkup) body.reply_markup = replyMarkup
    return this.call('editMessageReplyMarkup', body)
  }

  /** Publishes the command list shown in Telegram's UI menu. */
  async setMyCommands(commands: BotCommand[]): Promise<SendResult> {
    return this.call('setMyCommands', { commands })
  }
}

async function toSendResult(res: Response): Promise<SendResult> {
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    description?: string
    result?: { message_id?: number }
    parameters?: { retry_after?: number }
  }
  const retryAfter = json.parameters?.retry_after
  return {
    ok: res.ok && json.ok === true,
    status: res.status,
    description: json.description,
    ...(typeof json.result?.message_id === 'number' ? { messageId: json.result.message_id } : {}),
    ...(typeof retryAfter === 'number' ? { retryAfterSeconds: retryAfter } : {}),
  }
}
