import type { BotUser, DeliveryOutcome, Draft, DraftStep, Task } from '../domain/types'

export interface Clock {
  now(): Date
}

export interface CreateTaskInput {
  telegramUserId: number
  title: string
  /** UTC, or null for a task without a reminder. */
  remindAt: Date | null
}

export interface SaveDraftInput {
  telegramUserId: number
  step: DraftStep
  title?: string | null
  taskId?: string | null
  cardChatId?: number | null
  cardMessageId?: number | null
  remindAt?: Date | null
}

/**
 * Persistence port for the planner. Implementations MUST scope every read and
 * write by telegramUserId where the signature takes one — the service layer
 * relies on that to keep users off each other's tasks.
 */
export interface TaskRepository {
  /** Atomically claim an update_id. True if newly claimed, false if already processed. */
  claimUpdate(updateId: number): Promise<boolean>

  /** Create the user row if absent. Returns the user (timezone null until chosen). */
  ensureUser(telegramUserId: number): Promise<BotUser>
  getUser(telegramUserId: number): Promise<BotUser | null>
  setTimezone(telegramUserId: number, timeZone: string): Promise<void>

  createTask(input: CreateTaskInput): Promise<Task>

  /**
   * Resolve a task id, scoped to its owner. Returns null when the id is unknown
   * OR belongs to someone else — the caller cannot tell the two apart, which is
   * what keeps ids non-enumerable.
   */
  getTaskForUser(taskId: string, telegramUserId: number): Promise<Task | null>

  listTasks(telegramUserId: number, limit: number): Promise<Task[]>

  /** Active tasks whose reminder falls inside [from, to). Used by /today. */
  listTasksInWindow(telegramUserId: number, from: Date, to: Date): Promise<Task[]>

  /** Owner-scoped. Returns the updated task, or null if not the owner's. */
  completeTask(taskId: string, telegramUserId: number, at: Date): Promise<Task | null>
  updateTitle(taskId: string, telegramUserId: number, title: string): Promise<Task | null>
  /** Owner-scoped. Clears reminder_sent_at so the new time fires again. */
  reschedule(taskId: string, telegramUserId: number, remindAt: Date | null): Promise<Task | null>
  /** Owner-scoped. Returns whether a row was actually deleted. */
  deleteTask(taskId: string, telegramUserId: number): Promise<boolean>

  // ── Reminder dispatch ──────────────────────────────────────────────────────

  /**
   * Atomically claim due reminders: moves active tasks whose remind_at has passed
   * from `pending`/`retry` to `processing`, increments the attempt counter, and
   * returns them.
   *
   * The select and the state change are ONE statement, so two concurrent sweeps
   * (or the cron job racing the web process) can never claim the same task.
   */
  claimDueReminders(now: Date, limit: number): Promise<Task[]>

  /** `processing` -> `sent`. Stamps reminder_sent_at. */
  markReminderSent(taskId: string, at: Date): Promise<void>

  /** `processing` -> `retry`, with the backoff instant for the next attempt. */
  scheduleReminderRetry(taskId: string, nextAttemptAt: Date, reason: string): Promise<void>

  /** `processing` -> `failed`. Terminal: no further attempts. */
  markReminderFailed(taskId: string, reason: string): Promise<void>

  /**
   * Recover reminders stranded in `processing` by a crashed/killed sweep: moves
   * them back to `retry` once they have been stuck longer than `stalledBefore`.
   *
   * This is what stops a crash from losing a reminder. The timeout must exceed
   * the longest plausible send, so a slow-but-alive attempt is not duplicated.
   * Returns how many were reclaimed.
   */
  reclaimStalledReminders(stalledBefore: Date, now: Date, limit: number): Promise<number>

  // ── Conversation drafts ────────────────────────────────────────────────────

  getDraft(telegramUserId: number): Promise<Draft | null>
  /** Upsert: one draft per user, so a new flow replaces an abandoned one. */
  saveDraft(input: SaveDraftInput): Promise<void>
  clearDraft(telegramUserId: number): Promise<void>
}

/** The result of one delivery attempt. */
export interface DeliveryResult {
  outcome: DeliveryOutcome
  /** Safe label for logs/diagnostics (e.g. 'http_403', 'blocked'). Never a payload. */
  reason?: string
  /** Telegram's `retry_after` (seconds) on a 429, when it supplied one. */
  retryAfterSeconds?: number
}

/** Outbound Telegram port, so the service layer stays free of HTTP concerns. */
export interface TaskNotifier {
  sendReminder(chatId: number, task: Task): Promise<DeliveryResult>
}
