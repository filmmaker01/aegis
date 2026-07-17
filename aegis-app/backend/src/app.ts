import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

import type { DbClient } from './db'
import type { AppEnv } from './env'
import { errorResponse, handleError, validationErrorHook } from './http/errors'
import { metricsSnapshot } from './monitoring'
import { createTasksModule } from './modules/tasks'
import { createAuthModule, type AuthHttpEnv } from './modules/auth'

export type TasksModule = ReturnType<typeof createTasksModule>

/** In-memory store is a local-dev fallback; production always uses Postgres. */
export function storeFor(env: AppEnv, prisma: DbClient): DbClient | undefined {
  return env.TASKS_STORE === 'memory' ? undefined : prisma
}

type CreateAppOptions = {
  env: AppEnv
  prisma: DbClient
  /**
   * The planner module. Injectable so the server entry can share ONE instance
   * between the webhook and the reminder ticker — two instances would each hold
   * their own in-memory store in dev, and reminders would never find their tasks.
   */
  tasks?: TasksModule
}

export function createApp({ env, prisma, tasks = createTasksModule({ env, db: storeFor(env, prisma) }) }: CreateAppOptions) {
  const auth = createAuthModule({ db: prisma, env })
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

  // Planner: Telegram Bot webhook ingress (secret-token verified)
  app.route('/telegram/webhook', tasks.webhookRoutes)

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
