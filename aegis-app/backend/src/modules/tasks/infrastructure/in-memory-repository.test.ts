import { describe, expect, test } from 'bun:test'

import { InMemoryTaskRepository } from './in-memory-repository'

const NOW = new Date('2026-07-17T09:00:00Z')
const USER = 42
const OTHER = 99

function repo() {
  return new InMemoryTaskRepository(() => NOW)
}

async function withUser(r: InMemoryTaskRepository, id = USER) {
  await r.ensureUser(id)
  return r
}

describe('claimUpdate', () => {
  test('claims an id once', async () => {
    const r = repo()
    expect(await r.claimUpdate(1)).toBe(true)
    expect(await r.claimUpdate(1)).toBe(false)
  })
})

describe('users', () => {
  test('ensureUser is idempotent and starts without a timezone', async () => {
    const r = repo()
    expect((await r.ensureUser(USER)).timezone).toBeNull()
    await r.setTimezone(USER, 'Europe/Moscow')
    expect((await r.ensureUser(USER)).timezone).toBe('Europe/Moscow')
  })

  test('an unknown user resolves to null', async () => {
    expect(await repo().getUser(USER)).toBeNull()
  })
})

describe('ownership scoping', () => {
  test('a foreign task is invisible to every read and write', async () => {
    const r = await withUser(repo())
    await r.ensureUser(OTHER)
    const task = await r.createTask({ telegramUserId: OTHER, title: 'Секрет', remindAt: null })

    expect(await r.getTaskForUser(task.id, USER)).toBeNull()
    expect(await r.completeTask(task.id, USER, NOW)).toBeNull()
    expect(await r.updateTitle(task.id, USER, 'взлом')).toBeNull()
    expect(await r.reschedule(task.id, USER, NOW)).toBeNull()
    expect(await r.deleteTask(task.id, USER)).toBe(false)

    // Untouched for its real owner.
    const still = await r.getTaskForUser(task.id, OTHER)
    expect(still!.title).toBe('Секрет')
    expect(still!.status).toBe('active')
  })

  test('listTasks returns only the caller tasks', async () => {
    const r = await withUser(repo())
    await r.ensureUser(OTHER)
    await r.createTask({ telegramUserId: USER, title: 'Моя', remindAt: null })
    await r.createTask({ telegramUserId: OTHER, title: 'Чужая', remindAt: null })

    const mine = await r.listTasks(USER, 10)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.title).toBe('Моя')
  })
})

describe('listTasks ordering', () => {
  test('active before done, soonest reminder first, no-reminder last', async () => {
    const r = await withUser(repo())
    const done = await r.createTask({ telegramUserId: USER, title: 'Готово', remindAt: null })
    await r.completeTask(done.id, USER, NOW)
    await r.createTask({ telegramUserId: USER, title: 'Без срока', remindAt: null })
    await r.createTask({ telegramUserId: USER, title: 'Позже', remindAt: new Date('2026-07-18T10:00:00Z') })
    await r.createTask({ telegramUserId: USER, title: 'Скоро', remindAt: new Date('2026-07-17T10:00:00Z') })

    expect((await r.listTasks(USER, 10)).map((t) => t.title)).toEqual(['Скоро', 'Позже', 'Без срока', 'Готово'])
  })

  test('respects the limit', async () => {
    const r = await withUser(repo())
    for (let i = 0; i < 5; i++) await r.createTask({ telegramUserId: USER, title: `T${i}`, remindAt: null })
    expect(await r.listTasks(USER, 2)).toHaveLength(2)
  })
})

describe('listTasksInWindow', () => {
  test('is half-open: includes `from`, excludes `to`', async () => {
    const r = await withUser(repo())
    const from = new Date('2026-07-17T00:00:00Z')
    const to = new Date('2026-07-18T00:00:00Z')
    await r.createTask({ telegramUserId: USER, title: 'На границе from', remindAt: from })
    await r.createTask({ telegramUserId: USER, title: 'На границе to', remindAt: to })

    expect((await r.listTasksInWindow(USER, from, to)).map((t) => t.title)).toEqual(['На границе from'])
  })

  test('excludes completed tasks and tasks without a reminder', async () => {
    const r = await withUser(repo())
    const from = new Date('2026-07-17T00:00:00Z')
    const to = new Date('2026-07-18T00:00:00Z')
    const done = await r.createTask({ telegramUserId: USER, title: 'Готово', remindAt: new Date('2026-07-17T10:00:00Z') })
    await r.completeTask(done.id, USER, NOW)
    await r.createTask({ telegramUserId: USER, title: 'Без срока', remindAt: null })

    expect(await r.listTasksInWindow(USER, from, to)).toHaveLength(0)
  })
})

describe('mutations', () => {
  test('completeTask stamps the completion time', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: null })
    const done = await r.completeTask(task.id, USER, NOW)
    expect(done!.status).toBe('done')
    expect(done!.completedAt).toEqual(NOW)
  })

  test('reschedule re-arms a fired reminder and revives a done task', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: new Date('2026-07-17T08:00:00Z') })
    await r.claimDueReminders(NOW, 10)
    await r.completeTask(task.id, USER, NOW)

    const later = new Date('2026-07-17T10:00:00Z')
    const updated = await r.reschedule(task.id, USER, later)

    expect(updated!.remindAt).toEqual(later)
    expect(updated!.reminderSentAt).toBeNull()
    expect(updated!.status).toBe('active')
    expect(updated!.completedAt).toBeNull()
  })

  test('deleteTask removes the row', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Лишняя', remindAt: null })
    expect(await r.deleteTask(task.id, USER)).toBe(true)
    expect(await r.getTaskForUser(task.id, USER)).toBeNull()
    expect(await r.deleteTask(task.id, USER)).toBe(false)
  })
})

describe('claimDueReminders', () => {
  test('claims a due reminder exactly once', async () => {
    const r = await withUser(repo())
    await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: new Date('2026-07-17T08:00:00Z') })

    expect(await r.claimDueReminders(NOW, 10)).toHaveLength(1)
    expect(await r.claimDueReminders(NOW, 10)).toHaveLength(0)
  })

  test('claims at the exact due instant but not before', async () => {
    const r = await withUser(repo())
    await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: NOW })
    expect(await r.claimDueReminders(new Date(NOW.getTime() - 1), 10)).toHaveLength(0)
    expect(await r.claimDueReminders(NOW, 10)).toHaveLength(1)
  })

  test('the claim moves pending -> processing and counts the attempt', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: new Date('2026-07-17T08:00:00Z') })

    const claimed = await r.claimDueReminders(NOW, 10)
    expect(claimed[0]!.reminderState).toBe('processing')
    expect(claimed[0]!.reminderAttempts).toBe(1)
    expect((await r.getTaskForUser(task.id, USER))!.reminderState).toBe('processing')
  })

  test('scheduleReminderRetry makes it claimable again once the backoff passes', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: new Date('2026-07-17T08:00:00Z') })
    await r.claimDueReminders(NOW, 10)
    await r.scheduleReminderRetry(task.id, new Date('2026-07-17T09:30:00Z'), 'http_502')

    // Backoff not reached yet.
    expect(await r.claimDueReminders(new Date('2026-07-17T09:00:00Z'), 10)).toHaveLength(0)
    // Past the backoff.
    expect(await r.claimDueReminders(new Date('2026-07-17T09:31:00Z'), 10)).toHaveLength(1)
  })

  test('markReminderSent and markReminderFailed are terminal', async () => {
    const r = await withUser(repo())
    const sent = await r.createTask({ telegramUserId: USER, title: 'A', remindAt: new Date('2026-07-17T08:00:00Z') })
    const failed = await r.createTask({ telegramUserId: USER, title: 'B', remindAt: new Date('2026-07-17T08:00:00Z') })
    await r.claimDueReminders(NOW, 10)
    await r.markReminderSent(sent.id, NOW)
    await r.markReminderFailed(failed.id, 'blocked_by_user')

    expect((await r.getTaskForUser(sent.id, USER))!.reminderState).toBe('sent')
    expect((await r.getTaskForUser(failed.id, USER))!.reminderState).toBe('failed')
    // Neither is ever claimed again.
    expect(await r.claimDueReminders(new Date('2026-07-18T00:00:00Z'), 10)).toHaveLength(0)
  })

  test('a settle write only applies to a row still in processing', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: new Date('2026-07-17T08:00:00Z') })
    // Never claimed, so it is `pending` — a stray settle must not corrupt it.
    await r.markReminderSent(task.id, NOW)
    expect((await r.getTaskForUser(task.id, USER))!.reminderState).toBe('pending')
  })

  test('reclaimStalledReminders recovers a crashed claim after the timeout', async () => {
    const r = await withUser(repo())
    const task = await r.createTask({ telegramUserId: USER, title: 'Задача', remindAt: new Date('2026-07-17T08:00:00Z') })
    await r.claimDueReminders(NOW, 10)

    // Claim is younger than the cutoff -> left alone.
    expect(await r.reclaimStalledReminders(new Date('2026-07-17T08:55:00Z'), NOW, 10)).toBe(0)

    // Claim is older than the cutoff -> reclaimed and claimable again.
    expect(await r.reclaimStalledReminders(new Date('2026-07-17T09:05:00Z'), NOW, 10)).toBe(1)
    expect((await r.getTaskForUser(task.id, USER))!.reminderState).toBe('retry')
    expect(await r.claimDueReminders(NOW, 10)).toHaveLength(1)
  })

  test('claims across users, oldest first, honouring the limit', async () => {
    const r = await withUser(repo())
    await r.ensureUser(OTHER)
    await r.createTask({ telegramUserId: USER, title: 'Вторая', remindAt: new Date('2026-07-17T08:30:00Z') })
    await r.createTask({ telegramUserId: OTHER, title: 'Первая', remindAt: new Date('2026-07-17T08:00:00Z') })

    const claimed = await r.claimDueReminders(NOW, 1)
    expect(claimed.map((t) => t.title)).toEqual(['Первая'])
  })
})

describe('drafts', () => {
  test('saveDraft upserts one draft per user', async () => {
    const r = await withUser(repo())
    await r.saveDraft({ telegramUserId: USER, step: 'awaiting_title' })
    await r.saveDraft({ telegramUserId: USER, step: 'awaiting_time', title: 'Задача' })

    const draft = await r.getDraft(USER)
    expect(draft!.step).toBe('awaiting_time')
    expect(draft!.title).toBe('Задача')
  })

  test('omitted fields reset rather than linger from the previous step', async () => {
    const r = await withUser(repo())
    await r.saveDraft({ telegramUserId: USER, step: 'awaiting_confirm', title: 'Задача', remindAt: NOW })
    await r.saveDraft({ telegramUserId: USER, step: 'awaiting_title' })
    expect((await r.getDraft(USER))!.remindAt).toBeNull()
  })

  test('clearDraft removes it and drafts are per-user', async () => {
    const r = await withUser(repo())
    await r.saveDraft({ telegramUserId: USER, step: 'awaiting_title' })
    await r.saveDraft({ telegramUserId: OTHER, step: 'awaiting_title' })
    await r.clearDraft(USER)

    expect(await r.getDraft(USER)).toBeNull()
    expect(await r.getDraft(OTHER)).not.toBeNull()
  })
})
