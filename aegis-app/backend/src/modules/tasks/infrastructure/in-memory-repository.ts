import type { CreateTaskInput, SaveDraftInput, TaskRepository } from '../application/ports'
import type { BotUser, Draft, Task } from '../domain/types'

/**
 * In-memory planner repository.
 *
 * Used by unit tests (and as a local-dev fallback without Postgres) so the bot's
 * conversation logic can be exercised without a database. It mirrors the Prisma
 * implementation's contract, including owner-scoped lookups returning null for
 * foreign ids and the atomic claim semantics of claimDueReminders — single
 * threaded here, so a plain filter-then-stamp is equivalent.
 *
 * Data is lost on restart; production always uses PrismaTaskRepository.
 */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly updates = new Set<number>()
  private readonly users = new Map<number, BotUser>()
  private readonly tasks = new Map<string, Task>()
  private readonly drafts = new Map<number, Draft>()
  /** When each `processing` claim was taken — mirrors Postgres's updated_at. */
  private readonly claimedAt = new Map<string, Date>()
  private sequence = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  async claimUpdate(updateId: number): Promise<boolean> {
    if (this.updates.has(updateId)) return false
    this.updates.add(updateId)
    return true
  }

  async ensureUser(telegramUserId: number): Promise<BotUser> {
    const existing = this.users.get(telegramUserId)
    if (existing) return { ...existing }
    const created: BotUser = { telegramUserId, timezone: null }
    this.users.set(telegramUserId, created)
    return { ...created }
  }

  async getUser(telegramUserId: number): Promise<BotUser | null> {
    const user = this.users.get(telegramUserId)
    return user ? { ...user } : null
  }

  async setTimezone(telegramUserId: number, timeZone: string): Promise<void> {
    const user = (await this.getUser(telegramUserId)) ?? { telegramUserId, timezone: null }
    this.users.set(telegramUserId, { ...user, timezone: timeZone })
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    this.sequence += 1
    const task: Task = {
      id: pseudoUuid(this.sequence),
      telegramUserId: input.telegramUserId,
      title: input.title,
      status: 'active',
      remindAt: input.remindAt,
      reminderState: 'pending',
      reminderAttempts: 0,
      reminderNextAttemptAt: null,
      reminderSentAt: null,
      reminderFailedReason: null,
      completedAt: null,
      createdAt: this.now(),
    }
    this.tasks.set(task.id, task)
    return { ...task }
  }

  async getTaskForUser(taskId: string, telegramUserId: number): Promise<Task | null> {
    const task = this.tasks.get(taskId)
    if (!task || task.telegramUserId !== telegramUserId) return null
    return { ...task }
  }

  async listTasks(telegramUserId: number, limit: number): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter((t) => t.telegramUserId === telegramUserId)
      .sort(compareForList)
      .slice(0, limit)
      .map((t) => ({ ...t }))
  }

  async listTasksInWindow(telegramUserId: number, from: Date, to: Date): Promise<Task[]> {
    return [...this.tasks.values()]
      .filter(
        (t) =>
          t.telegramUserId === telegramUserId &&
          t.status === 'active' &&
          t.remindAt !== null &&
          t.remindAt.getTime() >= from.getTime() &&
          t.remindAt.getTime() < to.getTime(),
      )
      .sort((a, b) => (a.remindAt?.getTime() ?? 0) - (b.remindAt?.getTime() ?? 0))
      .map((t) => ({ ...t }))
  }

  async completeTask(taskId: string, telegramUserId: number, at: Date): Promise<Task | null> {
    const task = this.tasks.get(taskId)
    if (!task || task.telegramUserId !== telegramUserId) return null
    const updated: Task = { ...task, status: 'done', completedAt: at }
    this.tasks.set(taskId, updated)
    return { ...updated }
  }

  async updateTitle(taskId: string, telegramUserId: number, title: string): Promise<Task | null> {
    const task = this.tasks.get(taskId)
    if (!task || task.telegramUserId !== telegramUserId) return null
    const updated: Task = { ...task, title }
    this.tasks.set(taskId, updated)
    return { ...updated }
  }

  async reschedule(taskId: string, telegramUserId: number, remindAt: Date | null): Promise<Task | null> {
    const task = this.tasks.get(taskId)
    if (!task || task.telegramUserId !== telegramUserId) return null
    const updated: Task = {
      ...task,
      remindAt,
      status: 'active',
      completedAt: null,
      reminderState: 'pending',
      reminderAttempts: 0,
      reminderNextAttemptAt: null,
      reminderSentAt: null,
      reminderFailedReason: null,
    }
    this.tasks.set(taskId, updated)
    return { ...updated }
  }

  async deleteTask(taskId: string, telegramUserId: number): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || task.telegramUserId !== telegramUserId) return false
    this.tasks.delete(taskId)
    return true
  }

  async claimDueReminders(now: Date, limit: number): Promise<Task[]> {
    const due = [...this.tasks.values()]
      .filter(
        (t) =>
          t.status === 'active' &&
          t.remindAt !== null &&
          t.remindAt.getTime() <= now.getTime() &&
          (t.reminderState === 'pending' || t.reminderState === 'retry') &&
          (t.reminderNextAttemptAt === null || t.reminderNextAttemptAt.getTime() <= now.getTime()),
      )
      .sort((a, b) => (a.remindAt?.getTime() ?? 0) - (b.remindAt?.getTime() ?? 0))
      .slice(0, limit)

    return due.map((task) => {
      const claimed: Task = {
        ...task,
        reminderState: 'processing',
        reminderAttempts: task.reminderAttempts + 1,
      }
      this.tasks.set(task.id, claimed)
      // Postgres ages a claim via updated_at; the domain Task has no such field,
      // so the age is tracked alongside instead.
      this.claimedAt.set(task.id, now)
      return { ...claimed }
    })
  }

  async markReminderSent(taskId: string, at: Date): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || task.reminderState !== 'processing') return
    this.tasks.set(taskId, { ...task, reminderState: 'sent', reminderSentAt: at, reminderFailedReason: null })
    this.claimedAt.delete(taskId)
  }

  async scheduleReminderRetry(taskId: string, nextAttemptAt: Date, reason: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || task.reminderState !== 'processing') return
    this.tasks.set(taskId, {
      ...task,
      reminderState: 'retry',
      reminderNextAttemptAt: nextAttemptAt,
      reminderFailedReason: reason,
    })
    this.claimedAt.delete(taskId)
  }

  async markReminderFailed(taskId: string, reason: string): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task || task.reminderState !== 'processing') return
    this.tasks.set(taskId, {
      ...task,
      reminderState: 'failed',
      reminderNextAttemptAt: null,
      reminderFailedReason: reason,
    })
    this.claimedAt.delete(taskId)
  }

  async reclaimStalledReminders(stalledBefore: Date, _now: Date, limit: number): Promise<number> {
    const stalled = [...this.tasks.values()]
      .filter((t) => {
        if (t.reminderState !== 'processing') return false
        const claimedAt = this.claimedAt.get(t.id)
        return claimedAt !== undefined && claimedAt.getTime() < stalledBefore.getTime()
      })
      .slice(0, limit)

    for (const task of stalled) {
      this.tasks.set(task.id, {
        ...task,
        reminderState: 'retry',
        reminderNextAttemptAt: null,
        reminderFailedReason: 'stalled_claim_reclaimed',
      })
      this.claimedAt.delete(task.id)
    }
    return stalled.length
  }

  async getDraft(telegramUserId: number): Promise<Draft | null> {
    const draft = this.drafts.get(telegramUserId)
    return draft ? { ...draft } : null
  }

  async saveDraft(input: SaveDraftInput): Promise<void> {
    this.drafts.set(input.telegramUserId, {
      telegramUserId: input.telegramUserId,
      step: input.step,
      title: input.title ?? null,
      taskId: input.taskId ?? null,
      cardChatId: input.cardChatId ?? null,
      cardMessageId: input.cardMessageId ?? null,
      remindAt: input.remindAt ?? null,
    })
  }

  async clearDraft(telegramUserId: number): Promise<void> {
    this.drafts.delete(telegramUserId)
  }
}

/** Active first, then soonest reminder (no-reminder last), then newest. */
function compareForList(a: Task, b: Task): number {
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1
  if (a.remindAt && b.remindAt) return a.remindAt.getTime() - b.remindAt.getTime()
  if (a.remindAt) return -1
  if (b.remindAt) return 1
  return b.createdAt.getTime() - a.createdAt.getTime()
}

/** Shaped like a real uuid so it survives the Prisma repository's id guard. */
function pseudoUuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}
