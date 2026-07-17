import type { DbClient } from '../../../db'
import type { CreateTaskInput, SaveDraftInput, TaskRepository } from '../application/ports'
import type { BotUser, Draft, DraftStep, ReminderState, Task, TaskStatus } from '../domain/types'

/** The row shape returned by the raw claim statement (snake_case, as in SQL). */
interface DueRow {
  id: string
  telegram_user_id: bigint
  title: string
  status: string
  remind_at: Date | null
  reminder_state: string
  reminder_attempts: number
  reminder_next_attempt_at: Date | null
  reminder_sent_at: Date | null
  reminder_failed_reason: string | null
  completed_at: Date | null
  created_at: Date
}

/** Prisma row shape (camelCase via @map). */
interface TaskRow {
  id: string
  telegramUserId: bigint
  title: string
  status: string
  remindAt: Date | null
  reminderState: string
  reminderAttempts: number
  reminderNextAttemptAt: Date | null
  reminderSentAt: Date | null
  reminderFailedReason: string | null
  completedAt: Date | null
  createdAt: Date
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    telegramUserId: Number(row.telegramUserId),
    title: row.title,
    status: row.status as TaskStatus,
    remindAt: row.remindAt,
    reminderState: row.reminderState as ReminderState,
    reminderAttempts: row.reminderAttempts,
    reminderNextAttemptAt: row.reminderNextAttemptAt,
    reminderSentAt: row.reminderSentAt,
    reminderFailedReason: row.reminderFailedReason,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  }
}

function dueRowToTask(row: DueRow): Task {
  return {
    id: row.id,
    telegramUserId: Number(row.telegram_user_id),
    title: row.title,
    status: row.status as TaskStatus,
    remindAt: row.remind_at,
    reminderState: row.reminder_state as ReminderState,
    reminderAttempts: row.reminder_attempts,
    reminderNextAttemptAt: row.reminder_next_attempt_at,
    reminderSentAt: row.reminder_sent_at,
    reminderFailedReason: row.reminder_failed_reason,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }
}

/**
 * Postgres-backed planner repository.
 *
 * Ownership is enforced in the WHERE clause of every task read/write rather than
 * in a separate check, so a missing guard can't leak a row: an id belonging to
 * another user simply matches nothing and surfaces as null/false.
 */
export class PrismaTaskRepository implements TaskRepository {
  constructor(private readonly db: DbClient) {}

  async claimUpdate(updateId: number): Promise<boolean> {
    try {
      await this.db.processedUpdate.create({ data: { updateId: BigInt(updateId) } })
      return true
    } catch {
      // Unique violation on the primary key = already processed (a Telegram retry).
      return false
    }
  }

  async ensureUser(telegramUserId: number): Promise<BotUser> {
    const row = await this.db.botUser.upsert({
      where: { telegramUserId: BigInt(telegramUserId) },
      create: { telegramUserId: BigInt(telegramUserId) },
      update: {},
    })
    return { telegramUserId: Number(row.telegramUserId), timezone: row.timezone }
  }

  async getUser(telegramUserId: number): Promise<BotUser | null> {
    const row = await this.db.botUser.findUnique({
      where: { telegramUserId: BigInt(telegramUserId) },
    })
    return row ? { telegramUserId: Number(row.telegramUserId), timezone: row.timezone } : null
  }

  async setTimezone(telegramUserId: number, timeZone: string): Promise<void> {
    await this.db.botUser.upsert({
      where: { telegramUserId: BigInt(telegramUserId) },
      create: { telegramUserId: BigInt(telegramUserId), timezone: timeZone },
      update: { timezone: timeZone },
    })
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const row = await this.db.task.create({
      data: {
        telegramUserId: BigInt(input.telegramUserId),
        title: input.title,
        remindAt: input.remindAt,
      },
    })
    return toTask(row)
  }

  async getTaskForUser(taskId: string, telegramUserId: number): Promise<Task | null> {
    if (!isUuid(taskId)) return null
    const row = await this.db.task.findFirst({
      where: { id: taskId, telegramUserId: BigInt(telegramUserId) },
    })
    return row ? toTask(row) : null
  }

  async listTasks(telegramUserId: number, limit: number): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: { telegramUserId: BigInt(telegramUserId) },
      // Active first, then soonest reminder, then newest. Nulls (no reminder) last.
      orderBy: [{ status: 'asc' }, { remindAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: limit,
    })
    return rows.map(toTask)
  }

  async listTasksInWindow(telegramUserId: number, from: Date, to: Date): Promise<Task[]> {
    const rows = await this.db.task.findMany({
      where: {
        telegramUserId: BigInt(telegramUserId),
        status: 'active',
        remindAt: { gte: from, lt: to },
      },
      orderBy: { remindAt: 'asc' },
    })
    return rows.map(toTask)
  }

  async completeTask(taskId: string, telegramUserId: number, at: Date): Promise<Task | null> {
    if (!isUuid(taskId)) return null
    const { count } = await this.db.task.updateMany({
      where: { id: taskId, telegramUserId: BigInt(telegramUserId) },
      data: { status: 'done', completedAt: at },
    })
    if (count === 0) return null
    return this.getTaskForUser(taskId, telegramUserId)
  }

  async updateTitle(taskId: string, telegramUserId: number, title: string): Promise<Task | null> {
    if (!isUuid(taskId)) return null
    const { count } = await this.db.task.updateMany({
      where: { id: taskId, telegramUserId: BigInt(telegramUserId) },
      data: { title },
    })
    if (count === 0) return null
    return this.getTaskForUser(taskId, telegramUserId)
  }

  async reschedule(taskId: string, telegramUserId: number, remindAt: Date | null): Promise<Task | null> {
    if (!isUuid(taskId)) return null
    const { count } = await this.db.task.updateMany({
      where: { id: taskId, telegramUserId: BigInt(telegramUserId) },
      // Re-arm the whole delivery state machine: a snoozed reminder must fire
      // again, even if the previous attempt ended in `sent` or `failed`.
      data: {
        remindAt,
        status: 'active',
        completedAt: null,
        reminderState: 'pending',
        reminderAttempts: 0,
        reminderNextAttemptAt: null,
        reminderSentAt: null,
        reminderFailedReason: null,
      },
    })
    if (count === 0) return null
    return this.getTaskForUser(taskId, telegramUserId)
  }

  async deleteTask(taskId: string, telegramUserId: number): Promise<boolean> {
    if (!isUuid(taskId)) return false
    const { count } = await this.db.task.deleteMany({
      where: { id: taskId, telegramUserId: BigInt(telegramUserId) },
    })
    return count > 0
  }

  /**
   * Select + transition in ONE statement so concurrent sweeps cannot both claim a
   * row. SKIP LOCKED lets a second sweep move past rows already being claimed
   * instead of blocking on them.
   *
   * Only `pending`/`retry` rows are eligible, and a `retry` row must have reached
   * its backoff instant.
   */
  async claimDueReminders(now: Date, limit: number): Promise<Task[]> {
    const rows = await this.db.$queryRaw<DueRow[]>`
      UPDATE "tasks" SET
        "reminder_state" = 'processing',
        "reminder_attempts" = "reminder_attempts" + 1,
        "updated_at" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "tasks"
        WHERE "status" = 'active'
          AND "remind_at" IS NOT NULL
          AND "remind_at" <= ${now}
          AND "reminder_state" IN ('pending', 'retry')
          AND ("reminder_next_attempt_at" IS NULL OR "reminder_next_attempt_at" <= ${now})
        ORDER BY "remind_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "telegram_user_id", "title", "status", "remind_at",
                "reminder_state", "reminder_attempts", "reminder_next_attempt_at",
                "reminder_sent_at", "reminder_failed_reason", "completed_at", "created_at"
    `
    return rows.map(dueRowToTask)
  }

  async markReminderSent(taskId: string, at: Date): Promise<void> {
    if (!isUuid(taskId)) return
    // Scoped to `processing`: if the reaper already took this claim back, the row
    // is being handled by another sweep and must not be stamped from here.
    await this.db.task.updateMany({
      where: { id: taskId, reminderState: 'processing' },
      data: { reminderState: 'sent', reminderSentAt: at, reminderFailedReason: null },
    })
  }

  async scheduleReminderRetry(taskId: string, nextAttemptAt: Date, reason: string): Promise<void> {
    if (!isUuid(taskId)) return
    await this.db.task.updateMany({
      where: { id: taskId, reminderState: 'processing' },
      data: { reminderState: 'retry', reminderNextAttemptAt: nextAttemptAt, reminderFailedReason: reason },
    })
  }

  async markReminderFailed(taskId: string, reason: string): Promise<void> {
    if (!isUuid(taskId)) return
    await this.db.task.updateMany({
      where: { id: taskId, reminderState: 'processing' },
      data: { reminderState: 'failed', reminderNextAttemptAt: null, reminderFailedReason: reason },
    })
  }

  /**
   * Reclaim rows a crashed sweep left in `processing`. `updated_at` is stamped by
   * the claim, so it doubles as the claim's age.
   */
  async reclaimStalledReminders(stalledBefore: Date, now: Date, limit: number): Promise<number> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE "tasks" SET
        "reminder_state" = 'retry',
        "reminder_next_attempt_at" = NULL,
        "reminder_failed_reason" = 'stalled_claim_reclaimed',
        "updated_at" = ${now}
      WHERE "id" IN (
        SELECT "id" FROM "tasks"
        WHERE "reminder_state" = 'processing'
          AND "updated_at" < ${stalledBefore}
        ORDER BY "updated_at" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"
    `
    return rows.length
  }

  async getDraft(telegramUserId: number): Promise<Draft | null> {
    const row = await this.db.taskDraft.findUnique({
      where: { telegramUserId: BigInt(telegramUserId) },
    })
    if (!row) return null
    return {
      telegramUserId: Number(row.telegramUserId),
      step: row.step as DraftStep,
      title: row.title,
      taskId: row.taskId,
      cardChatId: row.cardChatId === null ? null : Number(row.cardChatId),
      cardMessageId: row.cardMessageId,
      remindAt: row.remindAt,
    }
  }

  async saveDraft(input: SaveDraftInput): Promise<void> {
    const data = {
      step: input.step,
      title: input.title ?? null,
      taskId: input.taskId ?? null,
      cardChatId: input.cardChatId === undefined || input.cardChatId === null ? null : BigInt(input.cardChatId),
      cardMessageId: input.cardMessageId ?? null,
      remindAt: input.remindAt ?? null,
    }
    await this.db.taskDraft.upsert({
      where: { telegramUserId: BigInt(input.telegramUserId) },
      create: { telegramUserId: BigInt(input.telegramUserId), ...data },
      update: data,
    })
  }

  async clearDraft(telegramUserId: number): Promise<void> {
    await this.db.taskDraft.deleteMany({ where: { telegramUserId: BigInt(telegramUserId) } })
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Guards Postgres uuid casts: a malformed id from callback_data would otherwise
 * raise a 22P02 error instead of cleanly resolving to "not found". */
function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
