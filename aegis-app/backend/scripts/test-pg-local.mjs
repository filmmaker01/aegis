/**
 * Runs the repository integration tests against a REAL PostgreSQL, with no Docker
 * and no cloud database: boots a throwaway embedded Postgres, applies the
 * migrations, runs `test:pg`, then stops and deletes it.
 *
 *   bun run --cwd backend test:pg:local
 *
 * Nothing here touches production. The data directory is temporary and removed on
 * exit (pass --keep to leave the server running for poking at it by hand).
 *
 * Note: this is a convenience for local verification. CI still uses the
 * docker-compose Postgres via `test:integration`.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import EmbeddedPostgres from 'embedded-postgres'

const backendRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const keep = process.argv.includes('--keep')

const PORT = Number(process.env.LOCAL_PG_PORT ?? 54399)
const USER = 'planner_test'
const PASSWORD = 'planner_test'
const DATABASE = 'planner_test'

const dataDir = mkdtempSync(join(tmpdir(), 'planner-pg-'))
const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: false,
})

let exitCode = 0

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status ?? 1
}

try {
  console.log(`Booting a throwaway PostgreSQL on port ${PORT}…`)
  await pg.initialise()
  await pg.start()
  await pg.createDatabase(DATABASE)

  // DIRECT_URL is what prisma.config.ts hands the CLI; DATABASE_URL is what the
  // tests connect with. They are the same server here (no pooler in front).
  const env = { DATABASE_URL: url, DIRECT_URL: url }

  console.log('\nApplying migrations…')
  exitCode = run('bunx', ['prisma', 'migrate', 'deploy'], env)
  if (exitCode !== 0) throw new Error('migrate deploy failed')

  console.log('\nGenerating the client…')
  exitCode = run('bun', ['run', 'prisma:generate'], env)
  if (exitCode !== 0) throw new Error('prisma generate failed')

  console.log('\nRunning repository integration tests…')
  exitCode = run('bun', ['test', 'src/modules/tasks/infrastructure/prisma-task-repository.integration.test.ts'], {
    ...env,
    PG_INTEGRATION: '1',
  })
} catch (err) {
  console.error(String(err))
  exitCode = exitCode === 0 ? 1 : exitCode
} finally {
  if (keep) {
    console.log(`\nLeaving Postgres running (--keep): ${url}`)
  } else {
    await pg.stop().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
}

process.exit(exitCode)
