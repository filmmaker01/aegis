import type { DbClient } from '../../db'
import type { AppEnv } from '../../env'
import { IngestService } from './application/ingest-service'
import type { ArchiveRepository, Clock, Notifier } from './application/ports'
import type { MediaRepository } from './application/media-ports'
import type { QueryRepository } from './application/query-ports'
import { QueryService } from './application/query-service'
import { InMemoryArchiveRepository } from './infrastructure/in-memory-repository'
import { PrismaArchiveRepository } from './infrastructure/prisma-archive-repository'
import { CallbackService } from './infrastructure/callback-service'
import { TelegramConnectionFetcher } from './infrastructure/telegram-connection-fetcher'
import { TelegramNotifier, noopNotifier } from './infrastructure/telegram-notifier'
import { MediaDownloadService } from './media/download-service'
import { createMediaStorage } from './media/storage'
import { createReadRoutes } from './transport/read-routes'
import { createWebhookRoutes } from '../telegram/transport/webhook-routes'
import { TelegramFileClient } from '../telegram/file-client'

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
 * service, media download worker, query service, the Telegram webhook ingress
 * and the Mini App read API.
 */
export function createArchiveModule({
  env,
  db,
  clock = systemClock,
  notifier,
}: CreateArchiveModuleOptions) {
  const repository: ArchiveRepository & QueryRepository & MediaRepository = db
    ? new PrismaArchiveRepository(db)
    : new InMemoryArchiveRepository(clock.now)

  const fileClient = env.TELEGRAM_BOT_TOKEN ? new TelegramFileClient(env.TELEGRAM_BOT_TOKEN) : null
  const mediaStorage = createMediaStorage(env)

  const resolvedNotifier =
    notifier ?? (fileClient ? new TelegramNotifier(fileClient, mediaStorage) : noopNotifier)

  const connectionFetcher = env.TELEGRAM_BOT_TOKEN
    ? new TelegramConnectionFetcher(env.TELEGRAM_BOT_TOKEN)
    : undefined

  // Media worker: downloads media on arrival. Driven by a fire-and-forget trigger
  // from the ingest service (never blocks the webhook ack). No timers here so the
  // factory stays side-effect-free for tests; the server entry may sweep periodically.
  const mediaWorker = fileClient
    ? new MediaDownloadService(repository, fileClient, mediaStorage, {
        ...(env.MEDIA_MAX_BYTES ? { maxBytes: env.MEDIA_MAX_BYTES } : {}),
      })
    : null

  let mediaRunning = false
  const mediaTrigger = mediaWorker
    ? () => {
        if (mediaRunning) return
        mediaRunning = true
        void mediaWorker
          .processPending()
          .catch((err) => console.error('[media] sweep error:', (err as Error).name))
          .finally(() => {
            mediaRunning = false
          })
      }
    : undefined

  const ingest = new IngestService({
    repository,
    notifier: resolvedNotifier,
    clock,
    connectionFetcher,
    mediaTrigger,
    mediaReader: repository,
  })
  const query = new QueryService(repository)

  // Inline-button (callback_query) handler — enforces owner-only access and
  // re-sends restored content to the owner's chat. Only when a bot token exists.
  const callback = fileClient
    ? new CallbackService(repository, fileClient, mediaStorage)
    : undefined

  const webhookRoutes = createWebhookRoutes({
    ingest,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    callback,
  })
  const readRoutes = createReadRoutes({
    query,
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSeconds: env.TELEGRAM_INITDATA_MAX_AGE_SECONDS ?? 3600,
  })

  return { ingest, query, repository, mediaWorker, callback, webhookRoutes, readRoutes }
}
