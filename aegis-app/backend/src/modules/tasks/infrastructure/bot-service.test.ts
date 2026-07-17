import { describe, expect, test } from 'bun:test'

import type { SendMessageOptions, TelegramBotClient } from '../../telegram'
import type { Clock } from '../application/ports'
import { BotService } from './bot-service'
import { InMemoryTaskRepository } from './in-memory-repository'

const NOW = '2026-07-17T09:00:00Z' // 12:00 MSK
const MSK = 'Europe/Moscow'
const USER = 42
const OTHER = 99

interface SentMessage {
  chatId: number
  text: string
  /** callback_data of every button, flattened. */
  keyboard: string[]
  /** The visible label of every button — the task list lives here now. */
  labels: string[]
}

interface FakeClientOptions {
  /** Simulates Telegram rejecting an edit (e.g. the user deleted the card). */
  failEdits?: boolean
  /** Simulates the Bot API being unreachable. */
  throwOnSend?: boolean
}

/** Records outbound calls and hands back predictable message ids. */
function fakeClient(options: FakeClientOptions = {}) {
  const sent: SentMessage[] = []
  const edits: SentMessage[] = []
  const answers: Array<{ id: string; text?: string }> = []
  let nextMessageId = 100

  const buttons = (o?: SendMessageOptions): string[] =>
    (o?.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? b.text)
  const labels = (o?: SendMessageOptions): string[] =>
    (o?.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.text)

  const client = {
    async sendMessage(chatId: number, text: string, o?: SendMessageOptions) {
      if (options.throwOnSend) throw new Error('ECONNRESET')
      nextMessageId += 1
      sent.push({ chatId, text, keyboard: buttons(o), labels: labels(o) })
      return { ok: true, status: 200, messageId: nextMessageId }
    },
    async editMessageText(chatId: number, _messageId: number, text: string, o?: SendMessageOptions) {
      if (options.failEdits) {
        return { ok: false, status: 400, description: 'Bad Request: message to edit not found' }
      }
      edits.push({ chatId, text, keyboard: buttons(o), labels: labels(o) })
      return { ok: true, status: 200 }
    },
    async answerCallbackQuery(id: string, o?: { text?: string }) {
      answers.push({ id, ...(o?.text ? { text: o.text } : {}) })
      return { ok: true, status: 200 }
    },
    async editMessageReplyMarkup() {
      return { ok: true, status: 200 }
    },
    async setMyCommands() {
      return { ok: true, status: 200 }
    },
  } as unknown as TelegramBotClient

  return { client, sent, edits, answers, lastEdit: () => edits.at(-1)!, lastSent: () => sent.at(-1)! }
}

function setup(now = NOW, options: FakeClientOptions = {}) {
  const clock: Clock = { now: () => new Date(now) }
  const repo = new InMemoryTaskRepository(clock.now)
  const fake = fakeClient(options)
  const bot = new BotService(repo, fake.client, clock)
  return { bot, repo, clock, ...fake }
}

/** A user who has already completed the timezone onboarding. */
async function onboarded(repo: InMemoryTaskRepository, userId = USER) {
  await repo.ensureUser(userId)
  await repo.setTimezone(userId, MSK)
}

const message = (text: string, fromTgId = USER) => ({
  fromTgId,
  chatId: fromTgId,
  messageId: 1,
  text,
})

const callback = (data: string, fromTgId = USER) => ({
  id: 'cb1',
  fromTgId,
  chatId: fromTgId,
  messageId: 500,
  data,
})

describe('onboarding', () => {
  test('/start greets and asks for a timezone in ONE message', async () => {
    const { bot, sent } = setup()
    await bot.onMessage(message('/start'))

    // One message, not a greeting followed by a second notification.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Привет')
    expect(sent[0]!.text).toContain('город')
    expect(sent[0]!.keyboard).toContain('tz:Europe/Moscow')
  })

  test('picking a timezone stores it and opens the menu', async () => {
    const { bot, repo, lastEdit } = setup()
    await bot.onMessage(message('/start'))
    await bot.onCallback(callback('tz:Europe/Moscow'))

    expect((await repo.getUser(USER))!.timezone).toBe(MSK)
    expect(lastEdit().text).toContain('Мои задачи')
    expect(lastEdit().keyboard).toContain('new')
  })

  test('rejects a bogus timezone from forged callback_data', async () => {
    const { bot, repo, answers } = setup()
    await bot.onCallback(callback('tz:Mars/Olympus'))
    expect(await repo.getUser(USER)).toBeNull()
    expect(answers.at(-1)!.text).toBe('Недоступно')
  })

  test('other commands are gated behind the timezone', async () => {
    const { bot, lastSent } = setup()
    await bot.onMessage(message('/tasks'))
    expect(lastSent().text).toContain('Часовой пояс')
  })

  test('/start again does not re-ask an onboarded user', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/start'))
    expect(lastSent().text).toContain('Мои задачи')
  })
})

describe('create flow', () => {
  test('title -> slot -> confirm creates the task', async () => {
    const { bot, repo, edits, lastEdit } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Купить хлеб'))
    expect(edits.at(-1)!.text).toContain('Купить хлеб')
    expect(edits.at(-1)!.keyboard).toContain('slot:evening')

    await bot.onCallback(callback('slot:evening'))
    expect(lastEdit().text).toContain('сегодня, 19:00')
    expect(lastEdit().keyboard).toEqual(['confirm', 'cancel'])

    await bot.onCallback(callback('confirm'))
    expect(lastEdit().text).toContain('Задача создана')

    const tasks = await repo.listTasks(USER, 10)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Купить хлеб')
    // 19:00 MSK == 16:00 UTC — stored in UTC.
    expect(tasks[0]!.remindAt!.toISOString()).toBe('2026-07-17T16:00:00.000Z')
    expect(await repo.getDraft(USER)).toBeNull()
  })

  test('"Без напоминания" creates a task with no remind_at', async () => {
    const { bot, repo } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Когда-нибудь'))
    await bot.onCallback(callback('slot:none'))
    await bot.onCallback(callback('confirm'))

    const tasks = await repo.listTasks(USER, 10)
    expect(tasks[0]!.remindAt).toBeNull()
  })

  test('custom date: a valid input advances to confirmation', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Забрать посылку'))
    await bot.onCallback(callback('slot:custom'))
    expect(lastEdit().text).toContain('Другая дата')

    await bot.onMessage(message('25.12 14:30'))
    expect(lastEdit().text).toContain('25 дек, 14:30')

    await bot.onCallback(callback('confirm'))
    const tasks = await repo.listTasks(USER, 10)
    expect(tasks[0]!.remindAt!.toISOString()).toBe('2026-12-25T11:30:00.000Z')
  })

  test('custom date: junk re-prompts and keeps the step open', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Задача'))
    await bot.onCallback(callback('slot:custom'))
    await bot.onMessage(message('когда-нибудь потом'))

    expect(lastEdit().text).toContain('Не получилось разобрать')
    expect((await repo.getDraft(USER))!.step).toBe('awaiting_custom_date')
    // The way out must survive a typo — without this the user is trapped in the
    // step with no button to press.
    expect(lastEdit().keyboard).toContain('cancel')

    // The user can simply type again.
    await bot.onMessage(message('18:45'))
    expect(lastEdit().text).toContain('сегодня, 18:45')
  })

  test('cancel drops the draft without creating anything', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Ненужное'))
    await bot.onCallback(callback('cancel'))

    expect(await repo.getDraft(USER)).toBeNull()
    expect(await repo.listTasks(USER, 10)).toHaveLength(0)
    expect(lastEdit().text).toContain('Мои задачи')
  })

  test('/cancel clears an in-progress draft', async () => {
    const { bot, repo } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Ненужное'))
    await bot.onMessage(message('/cancel'))

    expect(await repo.getDraft(USER)).toBeNull()
  })

  test('an empty title is rejected', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/new'))
    await bot.onMessage({ ...message('x'), text: '   .   ' })
    // Whitespace-only never reaches here (transport drops it); a lone dot is a
    // valid title, so the draft advances.
    expect((await repo.getDraft(USER))!.step).toBe('awaiting_time')
    expect(lastSent).toBeDefined()
  })

  test('confirming without a draft fails softly instead of throwing', async () => {
    const { bot, repo, answers, lastEdit } = setup()
    await onboarded(repo)
    await bot.onCallback(callback('confirm'))
    expect(answers.at(-1)!.text).toBe('Это сообщение устарело')
    expect(lastEdit().text).toContain('Мои задачи')
    expect(await repo.listTasks(USER, 10)).toHaveLength(0)
  })

  test('typing during the button-only step nudges instead of creating', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Задача'))
    await bot.onMessage(message('вечером пожалуйста'))
    expect(lastSent().text).toContain('кнопкой')
  })
})

describe('task list and detail', () => {
  test('lists only the caller own tasks', async () => {
    const { bot, repo, edits } = setup()
    await onboarded(repo)
    await onboarded(repo, OTHER)
    await repo.createTask({ telegramUserId: USER, title: 'Моя задача', remindAt: null })
    await repo.createTask({ telegramUserId: OTHER, title: 'Чужая задача', remindAt: null })

    await bot.onCallback(callback('list'))

    // The tasks live on the buttons now, not in the card text.
    const shown = edits.at(-1)!.labels.join(' | ')
    expect(shown).toContain('Моя задача')
    expect(shown).not.toContain('Чужая задача')
  })

  test('opens a task detail card with its actions', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Позвонить врачу',
      remindAt: new Date('2026-07-17T16:00:00Z'),
    })

    await bot.onCallback(callback(`open:${task.id}`))

    expect(lastEdit().text).toContain('Позвонить врачу')
    expect(lastEdit().text).toContain('сегодня, 19:00')
    expect(lastEdit().keyboard).toEqual([
      `done:${task.id}`,
      `snooze:${task.id}`,
      `edit:${task.id}`,
      `del:${task.id}`,
      'list',
    ])
  })

  test('the empty list reads as empty, not broken', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)
    await bot.onCallback(callback('list'))
    expect(lastEdit().text).toContain('Пока пусто')
  })
})

describe('ownership', () => {
  test('every task action on a foreign task is denied', async () => {
    const { bot, repo, answers, edits } = setup()
    await onboarded(repo)
    await onboarded(repo, OTHER)
    const foreign = await repo.createTask({ telegramUserId: OTHER, title: 'Секрет', remindAt: null })

    const editsBefore = edits.length
    for (const data of [
      `open:${foreign.id}`,
      `done:${foreign.id}`,
      `snooze:${foreign.id}`,
      `snz:${foreign.id}:15m`,
      `edit:${foreign.id}`,
      `del:${foreign.id}`,
      `delyes:${foreign.id}`,
    ]) {
      await bot.onCallback(callback(data))
      expect(answers.at(-1)!.text).toBe('Недоступно')
    }

    // Nothing was rendered and the task is untouched.
    expect(edits).toHaveLength(editsBefore)
    const still = await repo.getTaskForUser(foreign.id, OTHER)
    expect(still!.status).toBe('active')
    expect(still!.title).toBe('Секрет')
  })

  test('an unknown id is indistinguishable from a foreign one', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)
    await bot.onCallback(callback('open:00000000-0000-4000-8000-000000009999'))
    expect(answers.at(-1)!.text).toBe('Недоступно')
  })

  test('a malformed id is denied rather than crashing', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)
    await bot.onCallback(callback('open:not-a-uuid'))
    expect(answers.at(-1)!.text).toBe('Недоступно')
  })

  test('an unknown action is denied', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)
    await bot.onCallback(callback('drop_database'))
    expect(answers.at(-1)!.text).toBe('Недоступно')
  })
})

describe('task actions', () => {
  test('✅ Выполнено completes the task and re-renders the card', async () => {
    const { bot, repo, lastEdit, answers } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Сдать отчёт', remindAt: null })

    await bot.onCallback(callback(`done:${task.id}`))

    const updated = await repo.getTaskForUser(task.id, USER)
    expect(updated!.status).toBe('done')
    expect(updated!.completedAt).not.toBeNull()
    expect(answers.at(-1)!.text).toBe('Выполнено')
    expect(lastEdit().text).toContain('Выполнено')
    // A completed task offers no "done"/"snooze" any more — it offers an undo.
    expect(lastEdit().keyboard).toEqual([
      `reopen:${task.id}`,
      `edit:${task.id}`,
      `del:${task.id}`,
      'list',
    ])
  })

  test('↩️ Вернуть в работу undoes a mis-tapped "Выполнено"', async () => {
    const { bot, repo, lastEdit, answers } = setup()
    await onboarded(repo)
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Сдать отчёт',
      remindAt: new Date('2026-07-17T16:00:00Z'), // 19:00 MSK — still ahead of NOW
    })
    await bot.onCallback(callback(`done:${task.id}`))

    await bot.onCallback(callback(`reopen:${task.id}`))

    const reopened = await repo.getTaskForUser(task.id, USER)
    expect(reopened!.status).toBe('active')
    expect(reopened!.completedAt).toBeNull()
    // The reminder was still in the future, so it survives the undo.
    expect(reopened!.remindAt!.toISOString()).toBe('2026-07-17T16:00:00.000Z')
    expect(answers.at(-1)!.text).toBe('Вернули в работу')
    expect(lastEdit().keyboard).toContain(`done:${task.id}`)
  })

  test('reopening drops a reminder that has already passed', async () => {
    const { bot, repo } = setup()
    await onboarded(repo)
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Просрочено',
      remindAt: new Date('2026-07-17T08:00:00Z'), // already behind NOW
    })
    await bot.onCallback(callback(`done:${task.id}`))
    await bot.onCallback(callback(`reopen:${task.id}`))

    // Restoring a past time would fire a reminder the instant it is reopened.
    const reopened = await repo.getTaskForUser(task.id, USER)
    expect(reopened!.status).toBe('active')
    expect(reopened!.remindAt).toBeNull()
  })

  test('reopening a foreign task is denied', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)
    await onboarded(repo, OTHER)
    const foreign = await repo.createTask({ telegramUserId: OTHER, title: 'Чужая', remindAt: null })
    await repo.completeTask(foreign.id, OTHER, new Date(NOW))

    await bot.onCallback(callback(`reopen:${foreign.id}`))

    expect(answers.at(-1)!.text).toBe('Недоступно')
    expect((await repo.getTaskForUser(foreign.id, OTHER))!.status).toBe('done')
  })

  test('⏱ Через 15 минут reschedules and re-arms the reminder', async () => {
    const { bot, repo } = setup()
    await onboarded(repo)
    const task = await repo.createTask({
      telegramUserId: USER,
      title: 'Проверить духовку',
      remindAt: new Date('2026-07-17T08:00:00Z'),
    })
    // Simulate the reminder having already fired.
    await repo.claimDueReminders(new Date(NOW), 10)

    await bot.onCallback(callback(`snz:${task.id}:15m`))

    const updated = await repo.getTaskForUser(task.id, USER)
    expect(updated!.remindAt!.toISOString()).toBe('2026-07-17T09:15:00.000Z')
    expect(updated!.reminderSentAt).toBeNull()
  })

  test('⏰ Перенести offers the snooze options', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Задача', remindAt: null })

    await bot.onCallback(callback(`snooze:${task.id}`))

    expect(lastEdit().keyboard).toEqual([
      `snz:${task.id}:15m`,
      `snz:${task.id}:1h`,
      `snz:${task.id}:custom`,
      `open:${task.id}`,
    ])
  })

  test('snooze to a custom date applies immediately', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Задача', remindAt: null })

    await bot.onCallback(callback(`snz:${task.id}:custom`))
    await bot.onMessage(message('20:00'))

    const updated = await repo.getTaskForUser(task.id, USER)
    // 20:00 MSK == 17:00 UTC
    expect(updated!.remindAt!.toISOString()).toBe('2026-07-17T17:00:00.000Z')
    expect(await repo.getDraft(USER)).toBeNull()
    expect(lastEdit().text).toContain('сегодня, 20:00')
  })

  test('✏️ Изменить renames the task', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Старое', remindAt: null })

    await bot.onCallback(callback(`edit:${task.id}`))
    expect(lastEdit().text).toContain('Старое')
    await bot.onMessage(message('Новое название'))

    expect((await repo.getTaskForUser(task.id, USER))!.title).toBe('Новое название')
    expect(await repo.getDraft(USER)).toBeNull()
    expect(lastEdit().text).toContain('Новое название')
  })

  test('🗑 Удалить asks first, then deletes', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Лишняя', remindAt: null })

    await bot.onCallback(callback(`del:${task.id}`))
    expect(lastEdit().text).toContain('Удалить задачу?')
    expect(await repo.getTaskForUser(task.id, USER)).not.toBeNull()

    await bot.onCallback(callback(`delyes:${task.id}`))
    expect(await repo.getTaskForUser(task.id, USER)).toBeNull()
    expect(lastEdit().text).toContain('удалена')
  })
})

describe('/today', () => {
  test('shows only tasks due within the owner local day', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await repo.createTask({
      telegramUserId: USER,
      title: 'Сегодня вечером',
      remindAt: new Date('2026-07-17T16:00:00Z'), // 19:00 MSK today
    })
    await repo.createTask({
      telegramUserId: USER,
      title: 'Завтра утром',
      remindAt: new Date('2026-07-18T06:00:00Z'),
    })
    await repo.createTask({ telegramUserId: USER, title: 'Без срока', remindAt: null })

    await bot.onMessage(message('/today'))

    expect(lastSent().text).toContain('Сегодня вечером')
    expect(lastSent().text).not.toContain('Завтра утром')
    expect(lastSent().text).not.toContain('Без срока')
  })

  test('reads as empty when nothing is due today', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/today'))
    expect(lastSent().text).toContain('ничего не запланировано')
  })
})

describe('commands', () => {
  test('/settings shows the current timezone', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/settings'))
    expect(lastSent().text).toContain('Москва (UTC+3)')
  })

  test('an unknown command shows help, not a stack trace', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/archive'))
    expect(lastSent().text).toContain('/new')
  })

  test('a command addressed to the bot by name still works', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('/tasks@my_planner_bot'))
    expect(lastSent().text).toContain('Мои задачи')
  })

  test('plain text with no draft opens the menu', async () => {
    const { bot, repo, lastSent } = setup()
    await onboarded(repo)
    await bot.onMessage(message('привет'))
    expect(lastSent().text).toContain('Мои задачи')
  })
})

describe('safety', () => {
  test('a title with HTML is escaped, not rendered', async () => {
    const { bot, repo, lastEdit } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('<b>жирный</b> & <script>alert(1)</script>'))

    expect(lastEdit().text).toContain('&lt;b&gt;жирный&lt;/b&gt; &amp;')
    expect(lastEdit().text).not.toContain('<script>')
  })

  test('a repository failure is swallowed rather than crashing the webhook', async () => {
    const { bot, repo } = setup()
    await onboarded(repo)
    repo.listTasks = async () => {
      throw new Error('db down')
    }
    // Must not reject: the webhook returning 500 would make Telegram retry forever.
    await expect(bot.onCallback(callback('list'))).resolves.toBeUndefined()
  })
})

describe('resilience', () => {
  test('a restart mid-creation keeps the draft: a fresh bot finishes the flow', async () => {
    const { bot, repo, clock, client } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Купить хлеб'))

    // The draft lives in the store, not in the process — rebuild the service as a
    // restart would, and carry on from the exact step the user was on.
    const restarted = new BotService(repo, client, clock)
    expect((await repo.getDraft(USER))!.step).toBe('awaiting_time')

    await restarted.onCallback(callback('slot:evening'))
    await restarted.onCallback(callback('confirm'))

    const tasks = await repo.listTasks(USER, 10)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Купить хлеб')
    expect(tasks[0]!.remindAt!.toISOString()).toBe('2026-07-17T16:00:00.000Z')
  })

  test('a card the user deleted falls back to a new message instead of vanishing', async () => {
    // editMessageText fails the way Telegram fails it for a deleted message.
    const { bot, repo, sent } = setup(NOW, { failEdits: true })
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    const before = sent.length
    await bot.onMessage(message('Купить хлеб'))

    // The wizard still moved forward, delivered as a fresh message.
    expect(sent.length).toBeGreaterThan(before)
    expect(sent.at(-1)!.text).toContain('Купить хлеб')
    expect(sent.at(-1)!.keyboard).toContain('slot:evening')
    expect((await repo.getDraft(USER))!.step).toBe('awaiting_time')
  })

  test('an unreachable Bot API does not crash the webhook or lose the draft', async () => {
    const { bot, repo } = setup(NOW, { throwOnSend: true })
    await onboarded(repo)

    await expect(bot.onMessage(message('/new'))).resolves.toBeUndefined()
    await expect(bot.onMessage(message('привет'))).resolves.toBeUndefined()
    await expect(bot.onCallback(callback('list'))).resolves.toBeUndefined()
  })

  test('pressing confirm twice creates exactly one task', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)

    await bot.onMessage(message('/new'))
    await bot.onMessage(message('Купить хлеб'))
    await bot.onCallback(callback('slot:1h'))
    await bot.onCallback(callback('confirm'))
    // The card is replaced, but a fast double-tap can still deliver the second press.
    await bot.onCallback(callback('confirm'))

    expect(await repo.listTasks(USER, 10)).toHaveLength(1)
    expect(answers.at(-1)!.text).toBe('Это сообщение устарело')
  })

  test('pressing delete twice is harmless', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Лишняя', remindAt: null })

    await bot.onCallback(callback(`delyes:${task.id}`))
    await bot.onCallback(callback(`delyes:${task.id}`))

    expect(await repo.listTasks(USER, 10)).toHaveLength(0)
    // The second press finds nothing and is denied — no crash, no leak.
    expect(answers.at(-1)!.text).toBe('Недоступно')
  })

  test('a button on a card whose task was deleted elsewhere is denied', async () => {
    const { bot, repo, answers } = setup()
    await onboarded(repo)
    const task = await repo.createTask({ telegramUserId: USER, title: 'Задача', remindAt: null })
    await repo.deleteTask(task.id, USER)

    // The stale card still has its buttons; every one must fail closed.
    for (const data of [`open:${task.id}`, `done:${task.id}`, `snooze:${task.id}`, `edit:${task.id}`]) {
      await bot.onCallback(callback(data))
      expect(answers.at(-1)!.text).toBe('Недоступно')
    }
  })
})
