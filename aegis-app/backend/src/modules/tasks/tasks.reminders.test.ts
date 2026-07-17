import { describe, expect, test } from 'bun:test'

import type { Clock, DeliveryResult, TaskNotifier } from './application/ports'
import { ReminderDispatcher } from './application/reminder-dispatcher'
import type { Task } from './domain/types'
import { InMemoryTaskRepository } from './infrastructure/in-memory-repository'

const NOW = '2026-07-17T12:00:00Z'
const DUE = new Date('2026-07-17T11:00:00Z')

/** A clock the test can move, so backoff windows can be crossed deliberately. */
function movableClock(at = NOW) {
  let current = new Date(at)
  return {
    now: () => current,
    set: (iso: string) => {
      current = new Date(iso)
    },
    advanceSeconds: (s: number) => {
      current = new Date(current.getTime() + s * 1000)
    },
  } satisfies Clock & { set: (iso: string) => void; advanceSeconds: (s: number) => void }
}

function recordingNotifier(result: DeliveryResult = { outcome: 'sent' }) {
  const sent: Array<{ chatId: number; task: Task }> = []
  const notifier: TaskNotifier = {
    async sendReminder(chatId, task) {
      sent.push({ chatId, task })
      return result
    },
  }
  return { notifier, sent }
}

async function seed(repo: InMemoryTaskRepository, userId = 42, remindAt: Date | null = DUE) {
  await repo.ensureUser(userId)
  return repo.createTask({ telegramUserId: userId, title: 'Позвонить врачу', remindAt })
}

function dispatcher(
  repo: InMemoryTaskRepository,
  notifier: TaskNotifier,
  clock: Clock,
  overrides: { maxAttempts?: number; stalledAfterSeconds?: number; batchSize?: number } = {},
) {
  return new ReminderDispatcher({ repository: repo, notifier, clock, ...overrides })
}

describe('happy path', () => {
  test('delivers a due reminder and marks it sent', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const { notifier, sent } = recordingNotifier()

    const report = await dispatcher(repo, notifier, clock).sweep()

    expect(report).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 })
    expect(sent[0]!.chatId).toBe(42)

    const after = await repo.getTaskForUser(task.id, 42)
    expect(after!.reminderState).toBe('sent')
    expect(after!.reminderSentAt).toEqual(new Date(NOW))
    expect(after!.reminderAttempts).toBe(1)
  })

  test('never sends the same reminder twice across sweeps', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await seed(repo)
    const { notifier, sent } = recordingNotifier()
    const d = dispatcher(repo, notifier, clock)

    await d.sweep()
    await d.sweep()
    await d.sweep()

    expect(sent).toHaveLength(1)
  })

  test('concurrent sweeps cannot both claim the same reminder', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await seed(repo)
    const { notifier, sent } = recordingNotifier()
    const d = dispatcher(repo, notifier, clock)

    await Promise.all([d.sweep(), d.sweep(), d.sweep()])

    expect(sent).toHaveLength(1)
  })

  test('ignores reminders that are not due, have none, or are completed', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await seed(repo, 42, new Date('2026-07-17T12:01:00Z')) // future
    await seed(repo, 42, null) // no reminder
    const done = await seed(repo, 42)
    await repo.completeTask(done.id, 42, new Date(NOW))
    const { notifier, sent } = recordingNotifier()

    expect((await dispatcher(repo, notifier, clock).sweep()).claimed).toBe(0)
    expect(sent).toHaveLength(0)
  })
})

describe('permanent failures', () => {
  test('a blocked bot fails the reminder immediately and never retries', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const blocked = recordingNotifier({ outcome: 'permanent', reason: 'blocked_by_user' })

    const report = await dispatcher(repo, blocked.notifier, clock).sweep()
    expect(report).toMatchObject({ sent: 0, failed: 1, retried: 0 })

    const after = await repo.getTaskForUser(task.id, 42)
    expect(after!.reminderState).toBe('failed')
    expect(after!.reminderFailedReason).toBe('blocked_by_user')

    // A later sweep must not pick it up again — this is what stops the old
    // infinite retry loop against a user who blocked the bot.
    clock.advanceSeconds(3600)
    const later = recordingNotifier()
    expect((await dispatcher(repo, later.notifier, clock).sweep()).claimed).toBe(0)
    expect(later.sent).toHaveLength(0)
  })
})

describe('transient failures and backoff', () => {
  test('a transient failure schedules a retry rather than dropping the reminder', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const failing = recordingNotifier({ outcome: 'retry', reason: 'http_502' })

    const report = await dispatcher(repo, failing.notifier, clock).sweep()
    expect(report).toMatchObject({ sent: 0, retried: 1 })

    const after = await repo.getTaskForUser(task.id, 42)
    expect(after!.reminderState).toBe('retry')
    expect(after!.reminderAttempts).toBe(1)
    expect(after!.reminderFailedReason).toBe('http_502')
    expect(after!.reminderNextAttemptAt!.getTime()).toBeGreaterThan(clock.now().getTime())
  })

  test('the backoff is respected: too early is not claimed, later is', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await seed(repo)
    await dispatcher(repo, recordingNotifier({ outcome: 'retry' }).notifier, clock).sweep()

    // First backoff is ~60s.
    clock.advanceSeconds(30)
    const tooEarly = recordingNotifier()
    expect((await dispatcher(repo, tooEarly.notifier, clock).sweep()).claimed).toBe(0)

    clock.advanceSeconds(40) // now past the backoff
    const later = recordingNotifier()
    expect((await dispatcher(repo, later.notifier, clock).sweep()).sent).toBe(1)
  })

  test('backoff grows with attempts', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const failing = recordingNotifier({ outcome: 'retry' })
    const d = dispatcher(repo, failing.notifier, clock)

    await d.sweep()
    const first = (await repo.getTaskForUser(task.id, 42))!.reminderNextAttemptAt!

    clock.advanceSeconds(120)
    await d.sweep()
    const second = (await repo.getTaskForUser(task.id, 42))!.reminderNextAttemptAt!

    const firstGap = first.getTime() - new Date(NOW).getTime()
    const secondGap = second.getTime() - new Date(NOW).getTime() - 120_000
    expect(secondGap).toBeGreaterThan(firstGap)
  })

  test("Telegram's retry_after wins over the computed backoff", async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const limited = recordingNotifier({ outcome: 'retry', reason: 'rate_limited', retryAfterSeconds: 600 })

    await dispatcher(repo, limited.notifier, clock).sweep()

    const after = await repo.getTaskForUser(task.id, 42)
    expect(after!.reminderNextAttemptAt!.toISOString()).toBe('2026-07-17T12:10:00.000Z')
  })

  test('a thrown send is treated as transient, not lost', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const notifier: TaskNotifier = {
      async sendReminder() {
        throw new Error('ECONNRESET')
      },
    }

    const report = await dispatcher(repo, notifier, clock).sweep()
    expect(report.retried).toBe(1)
    expect((await repo.getTaskForUser(task.id, 42))!.reminderState).toBe('retry')
  })

  test('attempts are exhausted into a terminal failure', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    const failing = recordingNotifier({ outcome: 'retry', reason: 'http_500' })
    const d = dispatcher(repo, failing.notifier, clock, { maxAttempts: 3 })

    for (let i = 0; i < 6; i++) {
      await d.sweep()
      clock.advanceSeconds(3600) // always past the backoff
    }

    const after = await repo.getTaskForUser(task.id, 42)
    expect(after!.reminderState).toBe('failed')
    expect(after!.reminderFailedReason).toContain('attempts_exhausted')
    // 3 attempts allowed, and the 4th claim is the one that gives up.
    expect(failing.sent.length).toBeLessThanOrEqual(4)
  })

  test('one user failure never blocks the rest of the batch', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await repo.ensureUser(1)
    await repo.ensureUser(2)
    await repo.createTask({ telegramUserId: 1, title: 'Первая', remindAt: new Date('2026-07-17T10:00:00Z') })
    await repo.createTask({ telegramUserId: 2, title: 'Вторая', remindAt: new Date('2026-07-17T11:00:00Z') })

    const seen: number[] = []
    const notifier: TaskNotifier = {
      async sendReminder(chatId) {
        seen.push(chatId)
        if (chatId === 1) throw new Error('network down')
        return { outcome: 'sent' }
      },
    }

    const report = await dispatcher(repo, notifier, clock).sweep()
    expect(seen).toEqual([1, 2])
    expect(report).toMatchObject({ sent: 1, retried: 1 })
  })
})

describe('crash recovery (the reaper)', () => {
  test('a reminder stranded in processing by a crash is recovered, not lost', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)

    // Simulate a sweep that claimed the row and then died before sending.
    await repo.claimDueReminders(clock.now(), 10)
    expect((await repo.getTaskForUser(task.id, 42))!.reminderState).toBe('processing')

    // Before the stall timeout, the row is left alone (the sweep may still be alive).
    clock.advanceSeconds(60)
    const tooEarly = recordingNotifier()
    const early = await dispatcher(repo, tooEarly.notifier, clock, { stalledAfterSeconds: 300 }).sweep()
    expect(early.reclaimed).toBe(0)
    expect(tooEarly.sent).toHaveLength(0)

    // Past the timeout the reaper takes it back and it is delivered.
    clock.advanceSeconds(300)
    const recovered = recordingNotifier()
    const report = await dispatcher(repo, recovered.notifier, clock, { stalledAfterSeconds: 300 }).sweep()
    expect(report.reclaimed).toBe(1)
    expect(report.sent).toBe(1)
    expect((await repo.getTaskForUser(task.id, 42))!.reminderState).toBe('sent')
  })

  test('the reaper leaves a settled reminder alone', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await seed(repo)
    await dispatcher(repo, recordingNotifier().notifier, clock).sweep()

    clock.advanceSeconds(9999)
    const later = recordingNotifier()
    const report = await dispatcher(repo, later.notifier, clock).sweep()
    expect(report.reclaimed).toBe(0)
    expect(later.sent).toHaveLength(0)
  })
})

describe('snooze', () => {
  test('a snoozed task fires again with a clean delivery state', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)

    const first = recordingNotifier()
    await dispatcher(repo, first.notifier, clock).sweep()
    expect(first.sent).toHaveLength(1)

    // "⏱ Через 15 минут"
    await repo.reschedule(task.id, 42, new Date('2026-07-17T12:15:00Z'))
    const rearmed = await repo.getTaskForUser(task.id, 42)
    expect(rearmed!.reminderState).toBe('pending')
    expect(rearmed!.reminderAttempts).toBe(0)
    expect(rearmed!.reminderSentAt).toBeNull()

    clock.set('2026-07-17T12:16:00Z')
    const second = recordingNotifier()
    expect((await dispatcher(repo, second.notifier, clock).sweep()).sent).toBe(1)
  })

  test('rescheduling a permanently failed reminder re-arms it', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    const task = await seed(repo)
    await dispatcher(repo, recordingNotifier({ outcome: 'permanent', reason: 'blocked_by_user' }).notifier, clock).sweep()
    expect((await repo.getTaskForUser(task.id, 42))!.reminderState).toBe('failed')

    // The user unblocked the bot and snoozed the task from a fresh card.
    await repo.reschedule(task.id, 42, new Date('2026-07-17T12:15:00Z'))
    clock.set('2026-07-17T12:16:00Z')
    const retry = recordingNotifier()
    expect((await dispatcher(repo, retry.notifier, clock).sweep()).sent).toBe(1)
  })
})

describe('batching', () => {
  test('respects the batch size', async () => {
    const clock = movableClock()
    const repo = new InMemoryTaskRepository(clock.now)
    await repo.ensureUser(42)
    for (let i = 0; i < 5; i++) {
      await repo.createTask({ telegramUserId: 42, title: `Задача ${i}`, remindAt: DUE })
    }
    const { notifier, sent } = recordingNotifier()

    await dispatcher(repo, notifier, clock, { batchSize: 2 }).sweep()
    expect(sent).toHaveLength(2)
  })
})
