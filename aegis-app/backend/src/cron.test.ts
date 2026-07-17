import { describe, expect, test } from 'bun:test'

import type { DbClient } from './db'
import type { AppEnv } from './env'
import type { BackendRuntime } from './runtime'
import { runCronTask } from './cron'

const runtime = {} as BackendRuntime

/** No bot token + memory store: the sweep runs without Telegram or Postgres. */
const offlineRuntime = {
  env: { TASKS_STORE: 'memory', REMINDER_SWEEP_SECONDS: 30 } as unknown as AppEnv,
  prisma: {} as DbClient,
  close: async () => {},
} satisfies BackendRuntime

describe('runCronTask', () => {
  test('runs the noop task', async () => {
    await expect(runCronTask('noop', runtime)).resolves.toBeUndefined()
  })

  test('rejects unknown tasks', async () => {
    await expect(runCronTask('missing', runtime)).rejects.toThrow('Unknown cron task')
  })

  test('runs the reminder sweep', async () => {
    await expect(runCronTask('reminders:dispatch', offlineRuntime)).resolves.toBeUndefined()
  })
})
