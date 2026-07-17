/**
 * A parsed callback_query from an inline button press. `chatId`/`messageId`
 * identify the message the button lives on, and `fromTgId` is the presser —
 * which consumers check against the owner of whatever the button acts on.
 */
export interface IncomingCallback {
  /** callback_query.id — echoed back to answerCallbackQuery. */
  id: string
  fromTgId: number
  chatId: number
  messageId: number
  /** callback_data payload (action:parts…). */
  data: string
}

/** A parsed private text message (a command or free-text input). */
export interface IncomingMessage {
  fromTgId: number
  chatId: number
  messageId: number
  text: string
}

/** Handles parsed updates (implemented by the tasks BotService). */
export interface UpdateHandler {
  /** Atomically claim an update_id; false means it was already processed. */
  claim(updateId: number): Promise<boolean>
  onMessage(message: IncomingMessage): Promise<void>
  onCallback(callback: IncomingCallback): Promise<void>
}

/** Minimal raw Telegram shapes (permissive — we only read what we map). */
interface RawUser {
  id: number
  is_bot?: boolean
  [k: string]: unknown
}
interface RawChat {
  id: number
  type?: string
  [k: string]: unknown
}
interface RawMessage {
  message_id: number
  from?: RawUser
  chat?: RawChat
  date?: number
  text?: string
  [k: string]: unknown
}
interface RawCallbackQuery {
  id: string
  from?: RawUser
  message?: { message_id: number; chat?: RawChat }
  data?: string
  [k: string]: unknown
}
export interface RawUpdate {
  update_id: number
  message?: RawMessage
  callback_query?: RawCallbackQuery
  [k: string]: unknown
}

/**
 * Map a raw Message to the planner's input.
 *
 * Private chats only: the planner is a personal tool, and a group message would
 * otherwise let one member drive another's task list. Bots and non-text messages
 * are ignored.
 */
export function toIncomingMessage(m: RawMessage): IncomingMessage | null {
  if (!m.from || m.from.is_bot) return null
  if (!m.chat || m.chat.type !== 'private') return null
  if (typeof m.text !== 'string' || m.text.trim().length === 0) return null
  return {
    fromTgId: m.from.id,
    chatId: m.chat.id,
    messageId: m.message_id,
    text: m.text,
  }
}

export function toIncomingCallback(cq: RawCallbackQuery): IncomingCallback | null {
  if (!cq.id || !cq.from || !cq.data || !cq.message?.chat) return null
  return {
    id: cq.id,
    fromTgId: cq.from.id,
    chatId: cq.message.chat.id,
    messageId: cq.message.message_id,
    data: cq.data,
  }
}

/**
 * Routes a raw Update to the bot service. Applies update-level idempotency
 * (claim) so replayed updates are ignored. Returns the handled type or null.
 */
export async function dispatchUpdate(
  update: RawUpdate,
  handler: UpdateHandler,
): Promise<string | null> {
  if (typeof update.update_id !== 'number') return null
  const claimed = await handler.claim(update.update_id)
  if (!claimed) {
    console.log(`[update] update_id=${update.update_id} type=duplicate (skipped)`)
    return 'duplicate'
  }

  // Safe diagnostics only: type and update_id. Never message text or user ids.
  if (update.message) {
    console.log(`[update] update_id=${update.update_id} type=message`)
    const parsed = toIncomingMessage(update.message)
    if (parsed) await handler.onMessage(parsed)
    return 'message'
  }
  if (update.callback_query) {
    // Never log callback_data (it carries a task id) — only the type.
    console.log(`[update] update_id=${update.update_id} type=callback_query`)
    const parsed = toIncomingCallback(update.callback_query)
    if (parsed) await handler.onCallback(parsed)
    return 'callback_query'
  }
  console.log(`[update] update_id=${update.update_id} type=ignored`)
  return 'ignored'
}
