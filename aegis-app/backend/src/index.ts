import { createApp, storeFor } from './app'
import { BOT_COMMANDS } from './modules/tasks/infrastructure/bot-service'
import { createTasksModule } from './modules/tasks'
import { createBackendRuntime } from './runtime'

const runtime = createBackendRuntime()
// One shared module: the webhook and the reminder ticker must see the same store.
const tasks = createTasksModule({
  env: runtime.env,
  db: storeFor(runtime.env, runtime.prisma),
})
const app = createApp({ env: runtime.env, prisma: runtime.prisma, tasks })

const server = Bun.serve({
  port: runtime.env.PORT,
  fetch: app.fetch,
})

console.log(`Backend listening on ${server.url}`)

// Publish the command menu on boot (best-effort: a failure here must not stop the
// server, and Telegram keeps the previous list).
if (tasks.client) {
  void tasks.client
    .setMyCommands(BOT_COMMANDS)
    .then((res) => {
      if (!res.ok) console.error(`[bot] setMyCommands rejected status=${res.status}`)
    })
    .catch((err) => console.error(`[bot] setMyCommands failed error=${(err as Error).name}`))
}

/**
 * Reminder ticker. Runs in-process because the deployment is always-on (see
 * fly.toml) and the product needs minute-level accuracy — a platform cron job is
 * capped at 15-minute granularity, which "⏱ Через 15 минут" cannot live with.
 * Sweeps are serialised: a slow sweep never overlaps the next tick.
 */
const sweepMs = runtime.env.REMINDER_SWEEP_SECONDS * 1000
/** The in-flight sweep, so shutdown can drain it instead of killing it. */
let inFlight: Promise<unknown> | null = null

const ticker = setInterval(() => {
  if (inFlight) return
  inFlight = tasks.reminders
    .sweep()
    .catch((err) => console.error(`[reminders] sweep error=${(err as Error).name}`))
    .finally(() => {
      inFlight = null
    })
}, sweepMs)

let shuttingDown = false

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`Backend received ${signal}; shutting down`)
  clearInterval(ticker)
  // Drain the in-flight sweep before closing the DB. Killing it mid-send would
  // strand its claims in `processing` until the reaper's timeout, delaying those
  // reminders; worse, a claim already delivered but not yet marked `sent` would
  // be re-delivered. Waiting here makes a normal deploy lose neither.
  if (inFlight) {
    console.log('Waiting for the in-flight reminder sweep to finish')
    await inFlight
  }
  await server.stop(true)
  await runtime.close()
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
