import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { createPrisma, type DbClient } from '../../../db'
import { PrismaTaskRepository } from './prisma-task-repository'

/**
 * Integration tests for the Prisma repository against a REAL Postgres.
 * Opt-in: run with PG_INTEGRATION=1 and DATABASE_URL set. Skipped otherwise
 * (so the no-DB unit suite is unaffected).
 *
 *   PG_INTEGRATION=1 DATABASE_URL=postgres://... bun test <thisfile>
 *
 * These cover what the in-memory double cannot: the raw claim statement, the
 * uuid guard, and owner scoping as expressed in real SQL.
 */
const shouldRun = Boolean(Bun.env.PG_INTEGRATION) && Boolean(Bun.env.DATABASE_URL)
const d = shouldRun ? describe : describe.skip

// Unique per run so repeated runs don't collide and stay isolated for scoping.
const SUFFIX = Math.floor(Math.random() * 1e9)
const USER = 900_000_000 + (SUFFIX % 1_000_000)
const OTHER = USER + 1

let db: DbClient
let repo: PrismaTaskRepository

beforeAll(async () => {
  if (!shouldRun) return
  db = createPrisma(Bun.env.DATABASE_URL!)
  repo = new PrismaTaskRepository(db)
  await repo.ensureUser(USER)
  await repo.ensureUser(OTHER)
})

afterAll(async () => {
  if (!shouldRun) return
  // Tasks and drafts cascade from bot_users.
  await db.botUser.deleteMany({ where: { telegramUserId: { in: [BigInt(USER), BigInt(OTHER)] } } })
  await db.$disconnect()
})

d('PrismaTaskRepository', () => {
  test('creates and reads back a task, owner-scoped', async () => {
    const remindAt = new Date('2026-07-17T16:00:00.000Z')
    const task = await repo.createTask({ telegramUserId: USER, title: 'Купить хлеб', remindAt })

    const mine = await repo.getTaskForUser(task.id, USER)
    expect(mine!.title).toBe('Купить хлеб')
    expect(mine!.status).toBe('active')
    // Stored and returned in UTC, to the millisecond.
    expect(mine!.remindAt!.toISOString()).toBe(remindAt.toISOString())

    // The same id is invisible to another user.
    expect(await repo.getTaskForUser(task.id, OTHER)).toBeNull()
  })

  test('a malformed id resolves to null instead of raising a uuid cast error', async () => {
    expect(await repo.getTaskForUser('not-a-uuid', USER)).toBeNull()
    expect(await repo.deleteTask('not-a-uuid', USER)).toBe(false)
    expect(await repo.completeTask("'; drop table tasks; --", USER, new Date())).toBeNull()
  })

  test('foreign writes touch nothing', async () => {
    const task = await repo.createTask({ telegramUserId: OTHER, title: 'Секрет', remindAt: null })

    expect(await repo.completeTask(task.id, USER, new Date())).toBeNull()
    expect(await repo.updateTitle(task.id, USER, 'взлом')).toBeNull()
    expect(await repo.deleteTask(task.id, USER)).toBe(false)

    const still = await repo.getTaskForUser(task.id, OTHER)
    expect(still!.title).toBe('Секрет')
    expect(still!.status).toBe('active')
  })

  test('claimDueReminders claims a due reminder exactly once', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Напоминание',
      remindAt: new Date(Date.now() - 60_000),
    })

    const first = await repo.claimDueReminders(new Date(), 50)
    expect(first.map((t) => t.id)).toContain(task.id)

    const second = await repo.claimDueReminders(new Date(), 50)
    expect(second.map((t) => t.id)).not.toContain(task.id)
  })

  test('concurrent claims never hand the same task to both callers', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Гонка',
      remindAt: new Date(Date.now() - 60_000),
    })

    const [a, b] = await Promise.all([
      repo.claimDueReminders(new Date(), 50),
      repo.claimDueReminders(new Date(), 50),
    ])

    const claims = [...a, ...b].filter((t) => t.id === task.id)
    expect(claims).toHaveLength(1)
  })

  test('does not claim future or completed reminders', async () => {
    const future = await repo.createTask({
      telegramUserId: USER,
      title: 'Позже',
      remindAt: new Date(Date.now() + 3_600_000),
    })
    const done = await repo.createTask({
      telegramUserId: USER,
      title: 'Готово',
      remindAt: new Date(Date.now() - 60_000),
    })
    await repo.completeTask(done.id, USER, new Date())

    const claimed = (await repo.claimDueReminders(new Date(), 50)).map((t) => t.id)
    expect(claimed).not.toContain(future.id)
    expect(claimed).not.toContain(done.id)
  })

  test('the claim transitions pending -> processing and counts the attempt', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Состояние',
      remindAt: new Date(Date.now() - 60_000),
    })

    const claimed = (await repo.claimDueReminders(new Date(), 50)).find((t) => t.id === task.id)
    expect(claimed!.reminderState).toBe('processing')
    expect(claimed!.reminderAttempts).toBe(1)
    expect((await repo.getTaskForUser(task.id, USER))!.reminderState).toBe('processing')
  })

  test('markReminderSent is terminal and stamps the send time', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Отправлено',
      remindAt: new Date(Date.now() - 60_000),
    })
    await repo.claimDueReminders(new Date(), 50)
    const at = new Date()
    await repo.markReminderSent(task.id, at)

    const after = await repo.getTaskForUser(task.id, USER)
    expect(after!.reminderState).toBe('sent')
    expect(after!.reminderSentAt!.toISOString()).toBe(at.toISOString())
    expect((await repo.claimDueReminders(new Date(), 50)).map((t) => t.id)).not.toContain(task.id)
  })

  test('markReminderFailed is terminal — a blocked user is not retried forever', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Заблокирован',
      remindAt: new Date(Date.now() - 60_000),
    })
    await repo.claimDueReminders(new Date(), 50)
    await repo.markReminderFailed(task.id, 'blocked_by_user')

    const after = await repo.getTaskForUser(task.id, USER)
    expect(after!.reminderState).toBe('failed')
    expect(after!.reminderFailedReason).toBe('blocked_by_user')
    expect((await repo.claimDueReminders(new Date(), 50)).map((t) => t.id)).not.toContain(task.id)
  })

  test('scheduleReminderRetry honours the backoff instant', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Повтор',
      remindAt: new Date(Date.now() - 60_000),
    })
    await repo.claimDueReminders(new Date(), 50)
    await repo.scheduleReminderRetry(task.id, new Date(Date.now() + 3_600_000), 'http_502')

    // Backoff not reached.
    expect((await repo.claimDueReminders(new Date(), 50)).map((t) => t.id)).not.toContain(task.id)
    // Past the backoff.
    const later = new Date(Date.now() + 7_200_000)
    expect((await repo.claimDueReminders(later, 50)).map((t) => t.id)).toContain(task.id)
  })

  test('a settle write only applies while the row is still processing', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Чужой settle',
      remindAt: new Date(Date.now() - 60_000),
    })
    // Never claimed -> still `pending`; a stray settle must not corrupt it.
    await repo.markReminderSent(task.id, new Date())
    expect((await repo.getTaskForUser(task.id, USER))!.reminderState).toBe('pending')
  })

  test('reclaimStalledReminders recovers a claim stranded by a crash', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Осиротевший',
      remindAt: new Date(Date.now() - 60_000),
    })
    await repo.claimDueReminders(new Date(), 50)

    // A claim younger than the cutoff belongs to a possibly-alive sweep.
    expect(await repo.reclaimStalledReminders(new Date(Date.now() - 60_000), new Date(), 50)).toBe(0)
    expect((await repo.getTaskForUser(task.id, USER))!.reminderState).toBe('processing')

    // Older than the cutoff -> reclaimed to `retry` and claimable again.
    const reclaimed = await repo.reclaimStalledReminders(new Date(Date.now() + 60_000), new Date(), 50)
    expect(reclaimed).toBeGreaterThanOrEqual(1)
    expect((await repo.getTaskForUser(task.id, USER))!.reminderState).toBe('retry')
    expect((await repo.claimDueReminders(new Date(), 50)).map((t) => t.id)).toContain(task.id)
  })

  test('reschedule re-arms the whole delivery state machine', async () => {
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Перенос',
      remindAt: new Date(Date.now() - 60_000),
    })
    await repo.claimDueReminders(new Date(), 50)
    await repo.markReminderSent(task.id, new Date())

    const later = new Date(Date.now() + 900_000)
    const updated = await repo.reschedule(task.id, USER, later)

    expect(updated!.remindAt!.toISOString()).toBe(later.toISOString())
    expect(updated!.reminderState).toBe('pending')
    expect(updated!.reminderAttempts).toBe(0)
    expect(updated!.reminderSentAt).toBeNull()
    expect(updated!.reminderFailedReason).toBeNull()
  })

  test('claimUpdate is atomic across duplicate delivery', async () => {
    const updateId = Date.now() + SUFFIX
    expect(await repo.claimUpdate(updateId)).toBe(true)
    expect(await repo.claimUpdate(updateId)).toBe(false)
  })

  test('drafts upsert per user and clear', async () => {
    await repo.saveDraft({ telegramUserId: USER, step: 'awaiting_title', cardChatId: USER, cardMessageId: 7 })
    await repo.saveDraft({ telegramUserId: USER, step: 'awaiting_time', title: 'Задача' })

    const draft = await repo.getDraft(USER)
    expect(draft!.step).toBe('awaiting_time')
    expect(draft!.title).toBe('Задача')
    // Fields omitted on the second save are reset, not carried over.
    expect(draft!.cardMessageId).toBeNull()

    await repo.clearDraft(USER)
    expect(await repo.getDraft(USER)).toBeNull()
  })

  test('timezone survives a round-trip', async () => {
    await repo.setTimezone(USER, 'Europe/Moscow')
    expect((await repo.getUser(USER))!.timezone).toBe('Europe/Moscow')
  })
})
