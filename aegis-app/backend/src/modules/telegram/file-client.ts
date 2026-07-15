import type { MediaType } from '../archive/domain/types'

export interface TgFileInfo {
  filePath: string
  fileSize?: number
}

export interface SendResult {
  ok: boolean
  status: number
  description?: string
}

export interface SendMediaOptions {
  filename?: string
  contentType?: string
  caption?: string
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
    const blob = new Blob([new Uint8Array(bytes)], {
      type: options.contentType ?? 'application/octet-stream',
    })
    form.append(spec.field, blob, options.filename ?? defaultFilename(type))

    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/${spec.method}`, {
      method: 'POST',
      body: form,
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
    return { ok: res.ok && json.ok === true, status: res.status, description: json.description }
  }

  /** Plain text message (used for fallback notifications). */
  async sendMessage(chatId: number, text: string): Promise<SendResult> {
    const res = await fetch(`${this.apiRoot}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string }
    return { ok: res.ok && json.ok === true, status: res.status, description: json.description }
  }

  /** Whether this media type supports a caption on send. */
  static supportsCaption(type: MediaType): boolean {
    return SEND_SPEC[type].caption
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
