import type { DbClient } from '../../db'
import type { AppEnv } from '../../env'
import { IngestService } from './application/ingest-service'
import type { ArchiveRepository, Clock, Notifier } from './application/ports'
import type { QueryRepository } from './application/query-ports'
import { QueryService } from './application/query-service'
import { InMemoryArchiveRepository } from './infrastructure/in-memory-repository'
import { PrismaArchiveRepository } from './infrastructure/prisma-archive-repository'
import { TelegramNotifier, noopNotifier } from './infrastructure/telegram-notifier'
import { createReadRoutes } from './transport/read-routes'
import { createWebhookRoutes } from '../telegram/transport/webhook-routes'

const systemClock: Clock = { now: () => new Date() }

export interface CreateArchiveModuleOptions {
  env: AppEnv
  /** When omitted, an in-memory repository is used (local dev without Postgres). */
  db?: DbClient
  clock?: Clock
  notifier?: Notifier
}

/**
 * Wires the archive: repository (Prisma in prod, in-memory otherwise), ingest
 * service, query service, the Telegram webhook ingress and the Mini App read API.
 */
export function createArchiveModule({
  env,
  db,
  clock = systemClock,
  notifier,
}: CreateArchiveModuleOptions) {
  const repository: ArchiveRepository & QueryRepository = db
    ? new PrismaArchiveRepository(db)
    : new InMemoryArchiveRepository(clock.now)

  const resolvedNotifier =
    notifier ?? (env.TELEGRAM_BOT_TOKEN ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN) : noopNotifier)

  const ingest = new IngestService({ repository, notifier: resolvedNotifier, clock })
  const query = new QueryService(repository)

  const webhookRoutes = createWebhookRoutes({ ingest, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET })
  const readRoutes = createReadRoutes({
    query,
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSeconds: env.TELEGRAM_INITDATA_MAX_AGE_SECONDS ?? 3600,
  })

  return { ingest, query, repository, webhookRoutes, readRoutes }
}
