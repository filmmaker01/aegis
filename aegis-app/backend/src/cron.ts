import { storeFor } from './app'
import { createTasksModule } from './modules/tasks'
import { createBackendRuntime, type BackendRuntime } from './runtime'

type CronTask = (runtime: BackendRuntime) => Promise<void>

const cronTasks = {
  noop: async () => {
    console.log('Cron noop task completed.')
  },
  'db:ping': async ({ prisma }) => {
    await prisma.$queryRaw`SELECT 1`
    console.log('Cron db:ping task completed.')
  },
  /**
   * One reminder sweep. The always-on server already sweeps every
   * REMINDER_SWEEP_SECONDS; this exists as a safety net for hosts that scale the
   * web process to zero. Claiming is atomic, so running both is safe — the two
   * can never deliver the same reminder twice.
   */
  'reminders:dispatch': async (runtime) => {
    const tasks = createTasksModule({ env: runtime.env, db: storeFor(runtime.env, runtime.prisma) })
    const report = await tasks.reminders.sweep()
    console.log(
      `Cron reminders:dispatch task completed (sent=${report.sent} retried=${report.retried} ` +
        `failed=${report.failed} reclaimed=${report.reclaimed}).`,
    )
  },
} satisfies Record<string, CronTask>

export type CronTaskName = keyof typeof cronTasks

export async function runCronTask(taskName: string, runtime: BackendRuntime) {
  const task = cronTasks[taskName as CronTaskName]

  if (!task) {
    throw new Error(`Unknown cron task "${taskName}". Available tasks: ${Object.keys(cronTasks).join(', ')}`)
  }

  await task(runtime)
}

export async function main(argv: string[] = Bun.argv.slice(2)) {
  const [taskName] = argv

  if (!taskName) {
    console.error(`Cron task name is required. Available tasks: ${Object.keys(cronTasks).join(', ')}`)
    process.exit(1)
  }

  const runtime = createBackendRuntime()

  try {
    await runCronTask(taskName, runtime)
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) {
  await main()
}
