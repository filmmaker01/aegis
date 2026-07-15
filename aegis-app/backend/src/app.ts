import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

import type { DbClient } from './db'
import type { AppEnv } from './env'
import { errorResponse, handleError, validationErrorHook } from './http/errors'
import { metricsSnapshot } from './monitoring'
import { createArchiveModule } from './modules/archive'
import { createAuthModule, type AuthHttpEnv } from './modules/auth'

type CreateAppOptions = {
  env: AppEnv
  prisma: DbClient
}

export function createApp({ env, prisma }: CreateAppOptions) {
  const auth = createAuthModule({ db: prisma, env })
  // Archive can run in-memory (temporary, lost on restart) when Postgres is unavailable.
  const archive = createArchiveModule({ env, db: env.ARCHIVE_STORE === 'memory' ? undefined : prisma })
  const app = new OpenAPIHono<AuthHttpEnv>({
    defaultHook: validationErrorHook,
  })

  app.use(secureHeaders())
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.CORS_ORIGINS[0] ?? null
        return env.CORS_ORIGINS.includes(origin) ? origin : null
      },
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      credentials: true,
      maxAge: 600,
    }),
  )
  app.get('/', (c) => {
    return c.json({
      name: 'web_app_demo backend',
      status: 'ok',
    })
  })

  // Liveness: process is up (no external deps). Used by the platform health check.
  app.get('/health', (c) => {
    return c.json({ status: 'ok' })
  })

  // Readiness: DB reachable + error-metrics snapshot. 503 when the DB is down.
  app.get('/ready', async (c) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return c.json({ status: 'ready', db: 'ok', metrics: metricsSnapshot() })
    } catch {
      return c.json({ status: 'degraded', db: 'down', metrics: metricsSnapshot() }, 503)
    }
  })

  app.route('/api/auth', auth.routes)

  // Aegis: Telegram Business webhook ingress (secret-token verified) + Mini App read API (initData-auth)
  app.route('/telegram/webhook', archive.webhookRoutes)
  app.route('/api/archive', archive.readRoutes)

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'web_app_demo API',
      version: '1.0.0',
    },
  })

  app.notFound((c) => c.json(errorResponse('NOT_FOUND', 'Route not found'), 404))
  app.onError(handleError)

  return app
}

export type AppType = ReturnType<typeof createApp>
