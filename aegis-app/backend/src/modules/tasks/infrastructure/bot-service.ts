import type {
  IncomingCallback,
  IncomingMessage,
  InlineKeyboardMarkup,
  TelegramBotClient,
} from '../../telegram'
import type { Clock, TaskRepository } from '../application/ports'
import { dayWindow, isValidTimeZone, parseCustomDateTime, resolveSlot, resolveSnooze } from '../domain/schedule'
import type { BotUser, Draft, ReminderSlot, SnoozeSlot, Task } from '../domain/types'
import {
  askCustomDateCard,
  askEditTitleCard,
  askSnoozeCard,
  askTimeCard,
  askTitleCard,
  confirmCard,
  confirmKeyboard,
  createdCard,
  deleteConfirmCard,
  deleteConfirmKeyboard,
  invalidDateCard,
  mainMenuCard,
  mainMenuKeyboard,
  slotKeyboard,
  TITLE_LIMIT,
  taskDetailCard,
  taskDetailKeyboard,
  taskListCard,
  taskListKeyboard,
  timezoneCard,
  timezoneKeyboard,
  todayCard,
  truncate,
  decodeCallback,
  snoozeKeyboard,
  unknownCommandCard,
  welcomeCard,
  type InlineKeyboard,
} from '../notification/format'

/** Cap on rows in the list card/keyboard. */
const TASK_LIST_LIMIT = 20

const REMINDER_SLOTS = new Set<string>(['30m', '1h', 'evening', 'morning', 'none', 'custom'])
const SNOOZE_SLOTS = new Set<string>(['15m', '1h', 'custom'])

/** The command list published to Telegram's UI menu. */
export const BOT_COMMANDS = [
  { command: 'start', description: 'Начать заново' },
  { command: 'new', description: 'Новая задача' },
  { command: 'tasks', description: 'Все мои задачи' },
  { command: 'today', description: 'Что сегодня' },
  { command: 'settings', description: 'Часовой пояс' },
  { command: 'cancel', description: 'Отменить ввод' },
]

/**
 * The bot's conversation layer: maps commands, typed input and inline-button
 * presses onto the repository, and renders the result.
 *
 * SECURITY: every task action resolves the id from callback_data through
 * getTaskForUser(id, callback.from.id). A task belonging to someone else — or a
 * made-up id — resolves to null and gets a neutral "Недоступно"; the bot never
 * reveals whether an id exists (anti-enumeration).
 *
 * UX: cards are edited in place (editMessageText on the pressed message) rather
 * than appended, so a flow occupies one message instead of a stack of them.
 * Never logs message text, titles, tokens, or user ids.
 */
export class BotService {
  constructor(
    private readonly repo: TaskRepository,
    private readonly client: TelegramBotClient,
    private readonly clock: Clock,
  ) {}

  claim(updateId: number): Promise<boolean> {
    return this.repo.claimUpdate(updateId)
  }

  // ── Message entry point ────────────────────────────────────────────────────

  async onMessage(msg: IncomingMessage): Promise<void> {
    try {
      const text = msg.text.trim()
      if (text.startsWith('/')) return await this.onCommand(msg, commandOf(text))
      await this.onPlainText(msg, text)
    } catch (err) {
      console.error(`[bot] message error=${(err as Error).name}`)
    }
  }

  private async onCommand(msg: IncomingMessage, command: string): Promise<void> {
    // /start is the only command that works before onboarding — it IS onboarding.
    if (command === 'start') return await this.start(msg)

    const user = await this.repo.ensureUser(msg.fromTgId)
    if (!user.timezone) return await this.promptTimezone(msg.chatId, null)

    switch (command) {
      case 'new':
        return await this.startCreate(msg.chatId, msg.fromTgId)
      case 'tasks':
        return await this.showList(msg.chatId, user)
      case 'today':
        return await this.showToday(msg.chatId, user)
      case 'settings':
        return await this.promptTimezone(msg.chatId, user.timezone)
      case 'cancel':
        return await this.cancelInput(msg.chatId, msg.fromTgId)
      default:
        await this.send(msg.chatId, unknownCommandCard())
    }
  }

  private async start(msg: IncomingMessage): Promise<void> {
    const user = await this.repo.ensureUser(msg.fromTgId)
    await this.repo.clearDraft(msg.fromTgId)
    if (!user.timezone) {
      // Greeting and the timezone question ride in ONE message: introduce the bot
      // before asking, without spending two notifications to do it.
      await this.send(msg.chatId, welcomeCard(), timezoneKeyboard())
      return
    }
    await this.send(msg.chatId, mainMenuCard(), mainMenuKeyboard())
  }

  /**
   * /cancel. Also retires the wizard card, so its buttons cannot be pressed
   * afterwards and answer "Это сообщение устарело".
   */
  private async cancelInput(chatId: number, userId: number): Promise<void> {
    const draft = await this.repo.getDraft(userId)
    await this.repo.clearDraft(userId)
    if (draft?.cardChatId != null && draft.cardMessageId != null) {
      await this.client
        .editMessageText(draft.cardChatId, draft.cardMessageId, mainMenuCard(), {
          parseMode: 'HTML',
          replyMarkup: mainMenuKeyboard() as InlineKeyboardMarkup,
        })
        .catch(() => {})
      return
    }
    await this.send(chatId, mainMenuCard(), mainMenuKeyboard())
  }

  /** Typed text is only meaningful as input to an open wizard step. */
  private async onPlainText(msg: IncomingMessage, text: string): Promise<void> {
    const user = await this.repo.ensureUser(msg.fromTgId)
    if (!user.timezone) return await this.promptTimezone(msg.chatId, null)

    const draft = await this.repo.getDraft(msg.fromTgId)
    if (!draft) return await this.reply(msg.chatId, mainMenuCard(), mainMenuKeyboard())

    switch (draft.step) {
      case 'awaiting_title':
        return await this.onTitleEntered(msg, draft, text)
      case 'awaiting_edit_title':
        return await this.onEditTitleEntered(msg, draft, user, text)
      case 'awaiting_custom_date':
        return await this.onCustomDateEntered(msg, draft, user, text)
      default:
        // awaiting_time / awaiting_confirm expect a button, not text.
        await this.send(msg.chatId, 'Выберите вариант кнопкой ниже 👇')
    }
  }

  private async onTitleEntered(msg: IncomingMessage, draft: Draft, text: string): Promise<void> {
    const title = normalizeTitle(text)
    if (!title) return await this.reply(msg.chatId, 'Название не может быть пустым. Введите ещё раз.')

    await this.repo.saveDraft({
      telegramUserId: msg.fromTgId,
      step: 'awaiting_time',
      title,
      cardChatId: draft.cardChatId,
      cardMessageId: draft.cardMessageId,
    })
    await this.updateCard(draft, msg.chatId, askTimeCard(title), slotKeyboard())
  }

  private async onEditTitleEntered(
    msg: IncomingMessage,
    draft: Draft,
    user: BotUser,
    text: string,
  ): Promise<void> {
    const title = normalizeTitle(text)
    if (!title) return await this.reply(msg.chatId, 'Название не может быть пустым. Введите ещё раз.')
    if (!draft.taskId) return await this.clearAndMenu(msg.chatId, msg.fromTgId)

    const task = await this.repo.updateTitle(draft.taskId, msg.fromTgId, title)
    await this.repo.clearDraft(msg.fromTgId)
    if (!task) return await this.reply(msg.chatId, 'Задача недоступна.', mainMenuKeyboard())

    await this.updateCard(
      draft,
      msg.chatId,
      taskDetailCard(task, tz(user), this.clock.now()),
      taskDetailKeyboard(task),
    )
  }

  /**
   * The custom-date step serves two flows: creating a task (no taskId — go on to
   * confirmation) and rescheduling an existing one (taskId — apply immediately).
   */
  private async onCustomDateEntered(
    msg: IncomingMessage,
    draft: Draft,
    user: BotUser,
    text: string,
  ): Promise<void> {
    const at = parseCustomDateTime(text, this.clock.now(), tz(user))
    if (!at) {
      // Keep the step open so the user can simply type again — and keep the
      // cancel button, or a mistyped date would trap them with no way out.
      await this.updateCard(draft, msg.chatId, invalidDateCard(), cancelOnlyKeyboard())
      return
    }

    if (draft.taskId) {
      const task = await this.repo.reschedule(draft.taskId, msg.fromTgId, at)
      await this.repo.clearDraft(msg.fromTgId)
      if (!task) return await this.reply(msg.chatId, 'Задача недоступна.', mainMenuKeyboard())
      return await this.updateCard(
        draft,
        msg.chatId,
        taskDetailCard(task, tz(user), this.clock.now()),
        taskDetailKeyboard(task),
      )
    }

    const title = draft.title
    if (!title) return await this.clearAndMenu(msg.chatId, msg.fromTgId)
    await this.repo.saveDraft({
      telegramUserId: msg.fromTgId,
      step: 'awaiting_confirm',
      title,
      remindAt: at,
      cardChatId: draft.cardChatId,
      cardMessageId: draft.cardMessageId,
    })
    await this.updateCard(
      draft,
      msg.chatId,
      confirmCard(title, at, tz(user), this.clock.now()),
      confirmKeyboard(),
    )
  }

  // ── Callback entry point ───────────────────────────────────────────────────

  async onCallback(cb: IncomingCallback): Promise<void> {
    const { action, parts } = decodeCallback(cb.data)
    try {
      // Timezone selection must work before the user has a timezone.
      if (action === 'tz') return await this.setTimezone(cb, parts[0])

      const user = await this.repo.ensureUser(cb.fromTgId)
      if (!user.timezone) {
        await this.edit(cb.chatId, cb.messageId, timezoneCard(null, this.clock.now()), timezoneKeyboard())
        return await this.answer(cb)
      }

      switch (action) {
        case 'new':
          return await this.startCreateFromCallback(cb)
        case 'list':
          return await this.listFromCallback(cb, user)
        case 'slot':
          return await this.chooseSlot(cb, user, parts[0])
        case 'confirm':
          return await this.confirmCreate(cb, user)
        case 'cancel':
          return await this.cancelFromCallback(cb)
        case 'open':
          return await this.openTask(cb, user, parts[0])
        case 'done':
          return await this.completeTask(cb, user, parts[0])
        case 'reopen':
          return await this.reopenTask(cb, user, parts[0])
        case 'snooze':
          return await this.promptSnooze(cb, user, parts[0])
        case 'snz':
          return await this.applySnooze(cb, user, parts[0], parts[1])
        case 'edit':
          return await this.promptEditTitle(cb, parts[0])
        case 'del':
          return await this.promptDelete(cb, user, parts[0])
        case 'delyes':
          return await this.confirmDelete(cb, parts[0])
        default:
          await this.deny(cb)
      }
    } catch (err) {
      console.error(`[bot] callback action=${action} error=${(err as Error).name}`)
      await this.deny(cb).catch(() => {})
    }
  }

  private async setTimezone(cb: IncomingCallback, zone: string | undefined): Promise<void> {
    // Validate against the runtime's tz database: callback_data is user-supplied.
    if (!zone || !isValidTimeZone(zone)) return await this.deny(cb)
    await this.repo.ensureUser(cb.fromTgId)
    await this.repo.setTimezone(cb.fromTgId, zone)
    await this.edit(cb.chatId, cb.messageId, mainMenuCard(), mainMenuKeyboard())
    await this.answer(cb, 'Часовой пояс сохранён')
  }

  private async startCreateFromCallback(cb: IncomingCallback): Promise<void> {
    await this.repo.saveDraft({
      telegramUserId: cb.fromTgId,
      step: 'awaiting_title',
      cardChatId: cb.chatId,
      cardMessageId: cb.messageId,
    })
    await this.edit(cb.chatId, cb.messageId, askTitleCard(), cancelOnlyKeyboard())
    await this.answer(cb)
  }

  private async listFromCallback(cb: IncomingCallback, user: BotUser): Promise<void> {
    const tasks = await this.repo.listTasks(cb.fromTgId, TASK_LIST_LIMIT)
    await this.edit(
      cb.chatId,
      cb.messageId,
      taskListCard(tasks),
      taskListKeyboard(tasks, tz(user), this.clock.now()),
    )
    await this.answer(cb)
  }

  private async chooseSlot(cb: IncomingCallback, user: BotUser, raw: string | undefined): Promise<void> {
    if (!raw || !REMINDER_SLOTS.has(raw)) return await this.deny(cb)
    const slot = raw as ReminderSlot

    const draft = await this.repo.getDraft(cb.fromTgId)
    if (!draft?.title) return await this.expired(cb)

    if (slot === 'custom') {
      await this.repo.saveDraft({
        telegramUserId: cb.fromTgId,
        step: 'awaiting_custom_date',
        title: draft.title,
        cardChatId: draft.cardChatId,
        cardMessageId: draft.cardMessageId,
      })
      await this.edit(cb.chatId, cb.messageId, askCustomDateCard(), cancelOnlyKeyboard())
      return await this.answer(cb)
    }

    const remindAt = resolveSlot(slot, this.clock.now(), tz(user))
    await this.repo.saveDraft({
      telegramUserId: cb.fromTgId,
      step: 'awaiting_confirm',
      title: draft.title,
      remindAt,
      cardChatId: draft.cardChatId,
      cardMessageId: draft.cardMessageId,
    })
    await this.edit(
      cb.chatId,
      cb.messageId,
      confirmCard(draft.title, remindAt, tz(user), this.clock.now()),
      confirmKeyboard(),
    )
    await this.answer(cb)
  }

  private async confirmCreate(cb: IncomingCallback, user: BotUser): Promise<void> {
    const draft = await this.repo.getDraft(cb.fromTgId)
    if (!draft?.title) return await this.expired(cb)

    const task = await this.repo.createTask({
      telegramUserId: cb.fromTgId,
      title: draft.title,
      remindAt: draft.remindAt,
    })
    await this.repo.clearDraft(cb.fromTgId)
    await this.edit(
      cb.chatId,
      cb.messageId,
      createdCard(task.title, task.remindAt, tz(user), this.clock.now()),
      mainMenuKeyboard(),
    )
    await this.answer(cb, 'Задача создана')
  }

  private async cancelFromCallback(cb: IncomingCallback): Promise<void> {
    await this.repo.clearDraft(cb.fromTgId)
    await this.edit(cb.chatId, cb.messageId, mainMenuCard(), mainMenuKeyboard())
    await this.answer(cb, 'Отменено')
  }

  private async openTask(cb: IncomingCallback, user: BotUser, taskId: string | undefined): Promise<void> {
    const task = await this.owned(cb, taskId)
    if (!task) return
    await this.edit(
      cb.chatId,
      cb.messageId,
      taskDetailCard(task, tz(user), this.clock.now()),
      taskDetailKeyboard(task),
    )
    await this.answer(cb)
  }

  private async completeTask(cb: IncomingCallback, user: BotUser, taskId: string | undefined): Promise<void> {
    if (!taskId) return await this.deny(cb)
    const task = await this.repo.completeTask(taskId, cb.fromTgId, this.clock.now())
    if (!task) return await this.deny(cb)
    // Works for both the detail card and a fired reminder: the card becomes the
    // task's detail view showing the completed state.
    await this.edit(
      cb.chatId,
      cb.messageId,
      taskDetailCard(task, tz(user), this.clock.now()),
      taskDetailKeyboard(task),
    )
    await this.answer(cb, 'Выполнено')
  }

  /**
   * Undo of "✅ Выполнено". The old reminder is kept only if it is still ahead —
   * restoring a time that has already passed would fire a reminder instantly,
   * which is not what "вернуть в работу" means.
   */
  private async reopenTask(cb: IncomingCallback, user: BotUser, taskId: string | undefined): Promise<void> {
    const task = await this.owned(cb, taskId)
    if (!task) return
    const now = this.clock.now()
    const keepReminder = task.remindAt && task.remindAt.getTime() > now.getTime() ? task.remindAt : null

    const updated = await this.repo.reschedule(task.id, cb.fromTgId, keepReminder)
    if (!updated) return await this.deny(cb)
    await this.edit(
      cb.chatId,
      cb.messageId,
      taskDetailCard(updated, tz(user), now),
      taskDetailKeyboard(updated),
    )
    await this.answer(cb, 'Вернули в работу')
  }

  private async promptSnooze(cb: IncomingCallback, user: BotUser, taskId: string | undefined): Promise<void> {
    const task = await this.owned(cb, taskId)
    if (!task) return
    await this.edit(
      cb.chatId,
      cb.messageId,
      askSnoozeCard(task, tz(user), this.clock.now()),
      snoozeKeyboard(task.id),
    )
    await this.answer(cb)
  }

  private async applySnooze(
    cb: IncomingCallback,
    user: BotUser,
    taskId: string | undefined,
    raw: string | undefined,
  ): Promise<void> {
    if (!raw || !SNOOZE_SLOTS.has(raw)) return await this.deny(cb)
    const task = await this.owned(cb, taskId)
    if (!task) return
    const slot = raw as SnoozeSlot

    if (slot === 'custom') {
      await this.repo.saveDraft({
        telegramUserId: cb.fromTgId,
        step: 'awaiting_custom_date',
        taskId: task.id,
        cardChatId: cb.chatId,
        cardMessageId: cb.messageId,
      })
      await this.edit(cb.chatId, cb.messageId, askCustomDateCard(), cancelOnlyKeyboard())
      return await this.answer(cb)
    }

    const remindAt = resolveSnooze(slot, this.clock.now())
    const updated = await this.repo.reschedule(task.id, cb.fromTgId, remindAt)
    if (!updated) return await this.deny(cb)
    await this.edit(
      cb.chatId,
      cb.messageId,
      taskDetailCard(updated, tz(user), this.clock.now()),
      taskDetailKeyboard(updated),
    )
    await this.answer(cb, 'Перенесено')
  }

  private async promptEditTitle(cb: IncomingCallback, taskId: string | undefined): Promise<void> {
    const task = await this.owned(cb, taskId)
    if (!task) return
    await this.repo.saveDraft({
      telegramUserId: cb.fromTgId,
      step: 'awaiting_edit_title',
      taskId: task.id,
      cardChatId: cb.chatId,
      cardMessageId: cb.messageId,
    })
    await this.edit(cb.chatId, cb.messageId, askEditTitleCard(task), cancelOnlyKeyboard())
    await this.answer(cb)
  }

  private async promptDelete(cb: IncomingCallback, _user: BotUser, taskId: string | undefined): Promise<void> {
    const task = await this.owned(cb, taskId)
    if (!task) return
    await this.edit(cb.chatId, cb.messageId, deleteConfirmCard(task), deleteConfirmKeyboard(task.id))
    await this.answer(cb)
  }

  private async confirmDelete(cb: IncomingCallback, taskId: string | undefined): Promise<void> {
    if (!taskId) return await this.deny(cb)
    const deleted = await this.repo.deleteTask(taskId, cb.fromTgId)
    if (!deleted) return await this.deny(cb)
    await this.edit(cb.chatId, cb.messageId, '🗑 <b>Задача удалена</b>', mainMenuKeyboard())
    await this.answer(cb, 'Удалено')
  }

  // ── Shared renderers ───────────────────────────────────────────────────────

  private async startCreate(chatId: number, userId: number): Promise<void> {
    const sent = await this.send(chatId, askTitleCard(), cancelOnlyKeyboard())
    await this.repo.saveDraft({
      telegramUserId: userId,
      step: 'awaiting_title',
      cardChatId: chatId,
      cardMessageId: sent ?? null,
    })
  }

  private async showList(chatId: number, user: BotUser): Promise<void> {
    const tasks = await this.repo.listTasks(user.telegramUserId, TASK_LIST_LIMIT)
    await this.send(chatId, taskListCard(tasks), taskListKeyboard(tasks, tz(user), this.clock.now()))
  }

  private async showToday(chatId: number, user: BotUser): Promise<void> {
    const { from, to } = dayWindow(this.clock.now(), tz(user))
    const tasks = await this.repo.listTasksInWindow(user.telegramUserId, from, to)
    await this.send(chatId, todayCard(tasks, tz(user), this.clock.now()), mainMenuKeyboard())
  }

  private async promptTimezone(chatId: number, current: string | null): Promise<void> {
    await this.send(chatId, timezoneCard(current, this.clock.now()), timezoneKeyboard())
  }

  private async clearAndMenu(chatId: number, userId: number): Promise<void> {
    await this.repo.clearDraft(userId)
    await this.send(chatId, mainMenuCard(), mainMenuKeyboard())
  }

  /**
   * Resolve a task id from callback_data, owner-scoped. A foreign or unknown id
   * gets a neutral "Недоступно" and nothing else happens.
   */
  private async owned(cb: IncomingCallback, taskId: string | undefined): Promise<Task | null> {
    if (!taskId) {
      await this.deny(cb)
      return null
    }
    const task = await this.repo.getTaskForUser(taskId, cb.fromTgId)
    if (!task) {
      await this.deny(cb)
      return null
    }
    return task
  }

  /**
   * Update the wizard card in place. Falls back to a new message when the draft
   * has no card reference (e.g. the draft outlived a card we can no longer edit).
   */
  private async updateCard(
    draft: Draft,
    fallbackChatId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    if (draft.cardChatId !== null && draft.cardMessageId !== null) {
      const res = await this.client.editMessageText(draft.cardChatId, draft.cardMessageId, text, {
        parseMode: 'HTML',
        ...(keyboard ? { replyMarkup: keyboard as InlineKeyboardMarkup } : {}),
      })
      if (res.ok) return
    }
    await this.send(fallbackChatId, text, keyboard)
  }

  /** send() when the caller does not need the message_id. */
  private async reply(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.send(chatId, text, keyboard)
  }

  /** Returns the sent message_id, or null when the send failed. */
  private async send(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<number | null> {
    const res = await this.client.sendMessage(chatId, text, {
      parseMode: 'HTML',
      ...(keyboard ? { replyMarkup: keyboard as InlineKeyboardMarkup } : {}),
    })
    return res.messageId ?? null
  }

  private async edit(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    await this.client.editMessageText(chatId, messageId, text, {
      parseMode: 'HTML',
      ...(keyboard ? { replyMarkup: keyboard as InlineKeyboardMarkup } : {}),
    })
  }

  /** The draft is gone (restart, /cancel, or a stale card): fail softly. */
  private async expired(cb: IncomingCallback): Promise<void> {
    await this.edit(cb.chatId, cb.messageId, mainMenuCard(), mainMenuKeyboard())
    await this.answer(cb, 'Это сообщение устарело')
  }

  private async deny(cb: IncomingCallback): Promise<void> {
    await this.client.answerCallbackQuery(cb.id, { text: 'Недоступно' })
  }

  private async answer(cb: IncomingCallback, text?: string, showAlert = false): Promise<void> {
    await this.client.answerCallbackQuery(cb.id, { ...(text ? { text } : {}), showAlert })
  }
}

/** `/new@BotName arg` -> `new`. */
function commandOf(text: string): string {
  const first = text.split(/\s+/)[0] ?? ''
  return first.slice(1).split('@')[0]!.toLowerCase()
}

function normalizeTitle(text: string): string | null {
  const title = truncate(text.trim().replaceAll(/\s+/g, ' '), TITLE_LIMIT)
  return title.length > 0 ? title : null
}

function cancelOnlyKeyboard(): InlineKeyboard {
  return { inline_keyboard: [[{ text: '✕ Отмена', callback_data: 'cancel' }]] }
}

function tz(user: BotUser): string {
  // Callers guard on timezone before reaching a renderer; UTC is a safe fallback.
  return user.timezone ?? 'UTC'
}
