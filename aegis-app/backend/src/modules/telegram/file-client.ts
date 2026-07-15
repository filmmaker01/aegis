import type { MediaType } from '../archive/domain/types'

export interface TgFileInfo {
  filePath: string
  fileSize?: number
}

export interface SendResult {
  ok: boolean
  status: number
  description?: string
  /** message_id of the sent message, when the API returned one. */
  messageId?: number
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

export interface SendMediaOptions {
  filename?: string
  contentType?: string
  caption?: string
  parseMode?: 'HTML' | 'MarkdownV2'
  replyMarkup?: InlineKeyboardMarkup
}

/** Maps a media type to the Bot API send method + multipart field name. */
const SEND_SPEC: Record<MediaType, { method: string; field: string; caption: boolean }> = {
  photo: { method: 'sendPhoto', field: 'photo', caption: true },
  video: { method: 'sendVideo', field: 'video', caption: true },
  voice: { method: 'sendVoice', field: 'voice', caption: true },
  video_note: { method: 'sendVideoNote', field: 'video_note', caption: false }, // video_note has no caption
  audio: { method: 'sendAudio', field: 'audio', caption: true },
  document: { method: 'sendDocument', field: 'document', caption: true },
  animation: { method: 'sendAnimation', field: 'animation', caption: true },
  sticker: { method: 'sendSticker', field: 'sticker', caption: false },
}

/**
 * Bot API client for file operations: getFile, downloading bytes, and sending
 * archived media back to the owner via the type-appropriate method. Never logs
 * file contents, tokens, or download URLs.
 */
export class TelegramFileClient {
  constructor(
    private readonly botToken: string,
    private readonly apiRoot = 'https://api.telegram.org',
  ) {}

  async getFile(fileId: string): Promise<TgFileInfo | null> {
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    })
    const json = (await res.json()) as {
      ok: boolean
      result?: { file_path?: string; file_size?: number }
      description?: string
    }
    if (!json.ok || !json.result?.file_path) return null
    return { filePath: json.result.file_path, fileSize: json.result.file_size }
  }

  async downloadToBuffer(filePath: string): Promise<Buffer> {
    const res = await fetch(`${this.apiRoot}/file/bot${this.botToken}/${filePath}`)
    if (!res.ok) throw new Error(`file download failed: status ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Sends archived media to a chat via the method matching the media type. */
  async sendMedia(
    type: MediaType,
    chatId: number,
    bytes: Buffer,
    options: SendMediaOptions = {},
  ): Promise<SendResult> {
    const spec = SEND_SPEC[type]
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (spec.caption && options.caption) form.append('caption', options.caption)
    if (spec.caption && options.caption && options.parseMode) form.append('parse_mode', options.parseMode)
    if (options.replyMarkup) form.append('reply_markup', JSON.stringify(options.replyMarkup))
    const blob = new Blob([new Uint8Array(bytes)], {
      type: options.contentType ?? 'application/octet-stream',
    })
    form.append(spec.field, blob, options.filename ?? defaultFilename(type))

    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/${spec.method}`, {
      method: 'POST',
      body: form,
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
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return toSendResult(res)
  }

  /** Acknowledge a callback query (stops the client spinner; optional toast/alert). */
  async answerCallbackQuery(
    callbackQueryId: string,
    options: { text?: string; showAlert?: boolean } = {},
  ): Promise<SendResult> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
    if (options.text) body.text = options.text
    if (options.showAlert) body.show_alert = true
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return toSendResult(res)
  }

  /** Replace (or clear) the inline keyboard on an existing message. */
  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup | null,
  ): Promise<SendResult> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId }
    if (replyMarkup) body.reply_markup = replyMarkup
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return toSendResult(res)
  }

  /** Whether this media type supports a caption on send. */
  static supportsCaption(type: MediaType): boolean {
    return SEND_SPEC[type].caption
  }
}

async function toSendResult(res: Response): Promise<SendResult> {
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    description?: string
    result?: { message_id?: number }
  }
  return {
    ok: res.ok && json.ok === true,
    status: res.status,
    description: json.description,
    ...(typeof json.result?.message_id === 'number' ? { messageId: json.result.message_id } : {}),
  }
}

function defaultFilename(type: MediaType): string {
  switch (type) {
    case 'photo':
      return 'photo.jpg'
    case 'video':
      return 'video.mp4'
    case 'video_note':
      return 'video_note.mp4'
    case 'voice':
      return 'voice.ogg'
    case 'audio':
      return 'audio.mp3'
    case 'animation':
      return 'animation.mp4'
    case 'sticker':
      return 'sticker.webp'
    case 'document':
    default:
      return 'document.bin'
  }
}
