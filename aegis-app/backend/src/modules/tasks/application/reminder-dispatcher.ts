import type { Clock, TaskNotifier, TaskRepository } from './ports'

const DEFAULT_BATCH = 50
const DEFAULT_MAX_ATTEMPTS = 5
/** A claim older than this is assumed to belong to a dead process. */
const DEFAULT_STALLED_AFTER_SECONDS = 300
/** Backoff ceiling, so a long-lived retry never drifts absurdly far out. */
const MAX_BACKOFF_SECONDS = 60 * 60

export interface ReminderDispatcherOptions {
  repository: TaskRepository
  notifier: TaskNotifier
  clock: Clock
  /** Max reminders claimed per sweep. */
  batchSize?: number
  /** Attempts before a reminder is given up on. */
  maxAttempts?: number
  /** How long a `processing` claim may sit before the reaper takes it back. */
  stalledAfterSeconds?: number
}

export interface SweepReport {
  claimed: number
  sent: number
  retried: number
  failed: number
  /** Reminders recovered from a crashed sweep. */
  reclaimed: number
}

/**
 * Delivers due reminders through an explicit state machine
 * (pending -> processing -> sent | retry | failed).
 *
 * ## No duplicates
 * The claim moves `pending`/`retry` -> `processing` in the SAME statement that
 * selects the rows, so concurrent sweeps — the in-process ticker racing the cron
 * job — can never both pick up one task.
 *
 * ## No silent loss
 * A sweep killed mid-flight leaves rows in `processing`. The reaper returns them
 * to `retry` once they have been stuck for `stalledAfterSeconds`, so the reminder
 * is delivered late rather than lost. That timeout is deliberately far longer than
 * any real send, so a slow-but-alive attempt is never duplicated by the reaper.
 *
 * ## The honest limit
 * Telegram's sendMessage has no idempotency key, so exactly-once is impossible.
 * One window remains: a hard crash after Telegram accepted the message but before
 * `markReminderSent` commits. The reaper will then re-deliver it once. That window
 * is a single UPDATE wide, and graceful shutdown drains in-flight sweeps to avoid
 * it entirely on deploys. Everywhere else, delivery is exactly once.
 *
 * Sending is per-task and isolated: one user's failure never blocks the batch.
 */
export class ReminderDispatcher {
  private readonly repository: TaskRepository
  private readonly notifier: TaskNotifier
  private readonly clock: Clock
  private readonly batchSize: number
  private readonly maxAttempts: number
  private readonly stalledAfterSeconds: number

  constructor({
    repository,
    notifier,
    clock,
    batchSize = DEFAULT_BATCH,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    stalledAfterSeconds = DEFAULT_STALLED_AFTER_SECONDS,
  }: ReminderDispatcherOptions) {
    this.repository = repository
    this.notifier = notifier
    this.clock = clock
    this.batchSize = batchSize
    this.maxAttempts = maxAttempts
    this.stalledAfterSeconds = stalledAfterSeconds
  }

  /** One sweep: recover stalled claims, then deliver what is due. */
  async sweep(): Promise<SweepReport> {
    const reclaimed = await this.reclaimStalled()
    const report: SweepReport = { claimed: 0, sent: 0, retried: 0, failed: 0, reclaimed }

    const due = await this.repository.claimDueReminders(this.clock.now(), this.batchSize)
    report.claimed = due.length
    if (due.length === 0) {
      if (reclaimed > 0) console.log(`[reminders] sweep reclaimed=${reclaimed}`)
      return report
    }

    for (const task of due) {
      // The bot's private chat with a user has chat_id === the user's id.
      const result = await this.deliver(task.telegramUserId, task)

      if (result.outcome === 'sent') {
        await this.settle(task.id, () => this.repository.markReminderSent(task.id, this.clock.now()))
        report.sent += 1
        continue
      }

      const reason = result.reason ?? result.outcome

      if (result.outcome === 'permanent') {
        await this.settle(task.id, () => this.repository.markReminderFailed(task.id, reason))
        report.failed += 1
        continue
      }

      // Transient. Give up once the attempt budget is spent, so a reminder that
      // can never land stops consuming sweeps forever.
      if (task.reminderAttempts >= this.maxAttempts) {
        await this.settle(task.id, () =>
          this.repository.markReminderFailed(task.id, `${reason}_attempts_exhausted`),
        )
        report.failed += 1
        continue
      }

      const nextAttemptAt = this.backoffFrom(task.reminderAttempts, result.retryAfterSeconds)
      await this.settle(task.id, () =>
        this.repository.scheduleReminderRetry(task.id, nextAttemptAt, reason),
      )
      report.retried += 1
    }

    // Safe diagnostics only: counts, never titles or user ids.
    console.log(
      `[reminders] sweep claimed=${report.claimed} sent=${report.sent} ` +
        `retried=${report.retried} failed=${report.failed} reclaimed=${report.reclaimed}`,
    )
    return report
  }

  private async deliver(chatId: number, task: Parameters<TaskNotifier['sendReminder']>[1]) {
    try {
      return await this.notifier.sendReminder(chatId, task)
    } catch (err) {
      // A thrown error is a transport failure (DNS, socket, abort) — retryable.
      console.error(`[reminders] send threw error=${(err as Error).name}`)
      return { outcome: 'retry' as const, reason: 'transport_error' }
    }
  }

  /**
   * A settle write that fails leaves the row in `processing`; the reaper picks it
   * up later, so the reminder is never stranded. Never rethrows: one bad row must
   * not abort the batch.
   */
  private async settle(taskId: string, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (err) {
      console.error(`[reminders] state write failed error=${(err as Error).name}`)
    }
  }

  private async reclaimStalled(): Promise<number> {
    const stalledBefore = new Date(this.clock.now().getTime() - this.stalledAfterSeconds * 1000)
    try {
      return await this.repository.reclaimStalledReminders(stalledBefore, this.clock.now(), this.batchSize)
    } catch (err) {
      console.error(`[reminders] reclaim failed error=${(err as Error).name}`)
      return 0
    }
  }

  /**
   * Exponential backoff on the attempts already made: ~1, 2, 4, 8, 16 minutes,
   * capped. Telegram's own `retry_after` wins when it sent one (429).
   */
  private backoffFrom(attempts: number, retryAfterSeconds?: number): Date {
    const exponential = Math.min(60 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS)
    const seconds = Math.max(retryAfterSeconds ?? 0, exponential)
    return new Date(this.clock.now().getTime() + seconds * 1000)
  }
}
