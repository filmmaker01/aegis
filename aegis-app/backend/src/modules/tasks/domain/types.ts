/**
 * Task planner domain types.
 *
 * These are the CLEAN, already-parsed inputs the task service works with —
 * decoupled from raw Telegram payloads (mapping lives in the telegram transport
 * layer) and from Prisma (persistence lives behind the repository port). Every
 * instant here is UTC; a timezone is applied only at the edges (slot resolution
 * and rendering).
 */

export type TaskStatus = 'active' | 'done'

/**
 * Reminder delivery state.
 *
 *   pending ──claim──> processing ──ok──────> sent
 *                          │ ├──transient──> retry ──(next_attempt_at)──> processing
 *                          │ └──permanent──> failed        (blocked bot, chat gone)
 *                          └──crash──> (reaper, after a timeout) ──> retry
 *
 * `retry` also becomes `failed` once attempts are exhausted, so a permanently
 * undeliverable reminder cannot loop forever.
 */
export type ReminderState = 'pending' | 'processing' | 'sent' | 'retry' | 'failed'

/** What a delivery attempt concluded — decides the next state. */
export type DeliveryOutcome =
  /** Telegram accepted the message. */
  | 'sent'
  /** Worth retrying later (5xx, timeout, 429 rate limit, network). */
  | 'retry'
  /** Retrying can never help (bot blocked, chat not found, user deactivated). */
  | 'permanent'

/** Steps of the create/edit wizard. One draft per user at a time. */
export type DraftStep =
  | 'awaiting_title'
  /** The "when?" step: presets, calendar, or a typed natural-language phrase. */
  | 'awaiting_time'
  | 'awaiting_confirm'
  /** Typed HH:MM for a date already chosen in the calendar. */
  | 'awaiting_manual_time'
  | 'awaiting_edit_title'

/** The reminder presets offered when creating a task. */
export type ReminderSlot = '30m' | '1h' | 'evening' | 'morning' | 'none' | 'custom'

/** The snooze presets offered on a fired reminder. */
export type SnoozeSlot = '15m' | '1h' | 'custom'

export interface Task {
  id: string
  telegramUserId: number
  title: string
  status: TaskStatus
  /** UTC. Null = task without a reminder. */
  remindAt: Date | null
  reminderState: ReminderState
  /** Delivery attempts made so far. */
  reminderAttempts: number
  /** UTC. Earliest instant the next attempt may be claimed. Null = immediately. */
  reminderNextAttemptAt: Date | null
  /** UTC. Non-null only once Telegram has ACCEPTED the reminder. */
  reminderSentAt: Date | null
  /** Safe label for the last failure (never a payload). */
  reminderFailedReason: string | null
  completedAt: Date | null
  createdAt: Date
}

export interface BotUser {
  telegramUserId: number
  /** IANA name. Null until picked at /start. */
  timezone: string | null
}

export interface Draft {
  telegramUserId: number
  step: DraftStep
  title: string | null
  taskId: string | null
  cardChatId: number | null
  cardMessageId: number | null
  /** UTC, pending confirmation. */
  remindAt: Date | null
}

