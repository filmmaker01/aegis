import type { DbClient } from '../../db'
import type { AppEnv } from '../../env'
import type { Clock, TaskNotifier, TaskRepository } from './application/ports'
import { ReminderDispatcher } from './application/reminder-dispatcher'
import { BotService } from './infrastructure/bot-service'
import { InMemoryTaskRepository } from './infrastructure/in-memory-repository'
import { PrismaTaskRepository } from './infrastructure/prisma-task-repository'
import { TelegramTaskNotifier, noopNotifier } from './infrastructure/telegram-notifier'
import { createWebhookRoutes, TelegramBotClient } from '../telegram'

const systemClock: Clock = { now: () => new Date() }

export interface CreateTasksModuleOptions {
  env: AppEnv
  /** When omitted, an in-memory repository is used (local dev without Postgres). */
  db?: DbClient
  clock?: Clock
  notifier?: TaskNotifier
}

/**
 * Wires the planner: repository (Prisma in prod, in-memory otherwise), the bot
 * conversation service, the reminder dispatcher and the Telegram webhook ingress.
 *
 * Side-effect free: no timers are started here, so tests can drive sweep() by
 * hand. The server entry owns the ticker.
 */
export function createTasksModule({ env, db, clock = systemClock, notifier }: CreateTasksModuleOptions) {
  const repository: TaskRepository = db
    ? new PrismaTaskRepository(db)
    : new InMemoryTaskRepository(clock.now)

  const client = env.TELEGRAM_BOT_TOKEN ? new TelegramBotClient(env.TELEGRAM_BOT_TOKEN) : null

  const resolvedNotifier = notifier ?? (client ? new TelegramTaskNotifier(client) : noopNotifier)

  // Without a bot token there is nobody to talk to, so the webhook has no handler
  // and simply rejects updates rather than half-processing them.
  const bot = client ? new BotService(repository, client, clock) : undefined

  const reminders = new ReminderDispatcher({
    repository,
    notifier: resolvedNotifier,
    clock,
    maxAttempts: env.REMINDER_MAX_ATTEMPTS,
    stalledAfterSeconds: env.REMINDER_STALLED_AFTER_SECONDS,
  })

  const webhookRoutes = createWebhookRoutes({
    handler: bot,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
  })

  return { repository, bot, reminders, client, webhookRoutes }
}
