// Asserts the safety invariants of deploy/compose.prod.yml by parsing the file.
//
// `docker compose config` validates syntax and needs Docker; this validates the
// things that actually keep production safe, and needs nothing. Both run in CI:
// this one on every push, the Docker one only where a daemon exists.
//
//   bun scripts/compose-check.mjs
//
// The checks below are the ones whose absence is silent: a published database
// port, a network that lost `internal: true`, a volume mounted on the postgres:18
// path under a 17 server. None of these break a test — they break production,
// later, quietly.

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const composePath = path.resolve(repositoryRoot, '..', 'deploy', 'compose.prod.yml')

export function checkProductionCompose(doc) {
  const violations = []
  const fail = (rule, message) => violations.push({ rule, message })

  const services = doc?.services ?? {}
  const networks = doc?.networks ?? {}
  const volumes = doc?.volumes ?? {}

  for (const name of ['postgres', 'migrate', 'backend', 'caddy', 'backup']) {
    if (!services[name]) fail('services', `service "${name}" is missing`)
  }

  // --- postgres ---------------------------------------------------------------
  const postgres = services.postgres
  if (postgres) {
    if (postgres.ports) {
      fail(
        'postgres-no-published-ports',
        'postgres must not publish ports: that would expose the database on the public interface of the VPS',
      )
    }
    if (!/^postgres:17(\b|-)/.test(String(postgres.image ?? ''))) {
      fail('postgres-image', `postgres must run image postgres:17*, got "${postgres.image}"`)
    }
    const mounts = (postgres.volumes ?? []).map(String)
    if (!mounts.some((v) => v.endsWith(':/var/lib/postgresql/data'))) {
      fail(
        'postgres-volume-path',
        'the postgres volume must mount /var/lib/postgresql/data (the PGDATA of postgres:17). ' +
          'Mounting the parent is the postgres:18 layout and loses data on recreate',
      )
    }
    const named = mounts.some((v) => /^[a-z0-9_-]+:/i.test(v) && !v.startsWith('.') && !v.startsWith('/'))
    if (!named) fail('postgres-named-volume', 'postgres data must live in a named volume, not a bind mount')
    if (!postgres.healthcheck) fail('postgres-healthcheck', 'postgres must define a healthcheck')
    if (postgres.restart !== 'unless-stopped') {
      fail('postgres-restart', `postgres restart must be "unless-stopped", got "${postgres.restart}"`)
    }
    if (!(postgres.networks ?? []).includes('internal')) {
      fail('postgres-network', 'postgres must be on the internal network only')
    }
    if ((postgres.networks ?? []).includes('edge')) {
      fail('postgres-network', 'postgres must NOT be on the edge network')
    }
  }

  // --- backend ----------------------------------------------------------------
  const backend = services.backend
  if (backend) {
    if (backend.ports) {
      fail('backend-no-published-ports', 'backend must not publish ports: caddy reaches it over the edge network')
    }
    if (!backend.healthcheck) fail('backend-healthcheck', 'backend must define a healthcheck')
    if (backend.restart !== 'unless-stopped') {
      fail('backend-restart', `backend restart must be "unless-stopped", got "${backend.restart}"`)
    }
    const deps = backend.depends_on ?? {}
    if (deps.migrate?.condition !== 'service_completed_successfully') {
      fail(
        'backend-depends-migrate',
        'backend must depend on migrate with condition: service_completed_successfully, so it never serves against an un-migrated schema',
      )
    }
    if (deps.postgres?.condition !== 'service_healthy') {
      fail('backend-depends-postgres', 'backend must depend on postgres with condition: service_healthy')
    }
    // The healthcheck must hit /health, not /ready: /ready reports database state,
    // and restarting the bot cannot fix a dead database.
    const probe = JSON.stringify(backend.healthcheck?.test ?? '')
    if (probe.includes('/ready')) {
      fail('backend-healthcheck-endpoint', 'the backend healthcheck must probe /health, not /ready')
    }
    if (!probe.includes('/health')) {
      fail('backend-healthcheck-endpoint', 'the backend healthcheck must probe /health')
    }
  }

  // --- migrate ----------------------------------------------------------------
  const migrate = services.migrate
  if (migrate) {
    if (migrate.depends_on?.postgres?.condition !== 'service_healthy') {
      fail('migrate-depends-postgres', 'migrate must depend on postgres with condition: service_healthy')
    }
    if (migrate.restart && migrate.restart !== 'no') {
      fail('migrate-restart', `migrate is one-shot and must not restart, got "${migrate.restart}"`)
    }
    if (!JSON.stringify(migrate.command ?? '').includes('prisma:deploy')) {
      fail('migrate-command', 'migrate must run prisma:deploy')
    }
    if (!(migrate.networks ?? []).includes('internal')) {
      fail('migrate-network', 'migrate must be on the internal network')
    }
  }

  // --- caddy ------------------------------------------------------------------
  const caddy = services.caddy
  if (caddy) {
    const published = (caddy.ports ?? []).map(String)
    const exposed = published.map((p) => p.split(':')[0].replace(/"/g, ''))
    const unexpected = exposed.filter((p) => p !== '80' && p !== '443')
    if (unexpected.length > 0) {
      fail('caddy-ports', `caddy may publish only 80 and 443, also found: ${unexpected.join(', ')}`)
    }
    if (!caddy.healthcheck) fail('caddy-healthcheck', 'caddy must define a healthcheck')
    if (caddy.restart !== 'unless-stopped') {
      fail('caddy-restart', `caddy restart must be "unless-stopped", got "${caddy.restart}"`)
    }
    if ((caddy.networks ?? []).includes('internal')) {
      fail('caddy-network', 'caddy must not reach the internal network: it only needs the backend')
    }
  }

  // --- backup -----------------------------------------------------------------
  const backup = services.backup
  if (backup) {
    if (!/^postgres:17(\b|-)/.test(String(backup.image ?? ''))) {
      fail('backup-image', `backup must use postgres:17* so pg_dump matches the server, got "${backup.image}"`)
    }
    if (backup.ports) fail('backup-no-published-ports', 'backup must not publish ports')
  }

  // --- networks ---------------------------------------------------------------
  if (networks.internal?.internal !== true) {
    fail(
      'internal-network-isolated',
      'the internal network must set `internal: true`. Without it the database network gets a gateway, ' +
        'and the plaintext DATABASE_URL that env.ts allows for a private host is no longer private',
    )
  }
  if (!networks.edge) fail('edge-network', 'the edge network is missing')

  // --- volumes ----------------------------------------------------------------
  for (const name of ['pgdata', 'backups']) {
    if (!(name in volumes)) fail('named-volumes', `named volume "${name}" is missing`)
  }

  // --- secrets ----------------------------------------------------------------
  // Every secret must arrive by interpolation from the server-side .env. A literal
  // here would be a secret in git.
  for (const [name, service] of Object.entries(services)) {
    for (const [key, value] of Object.entries(service.environment ?? {})) {
      if (!/PASSWORD|SECRET|TOKEN|DATABASE_URL|JWT/i.test(key)) continue
      if (!String(value).includes('${')) {
        fail('no-inline-secrets', `${name}.environment.${key} must come from the environment, not be written inline`)
      }
    }
  }

  return violations
}

/**
 * When Docker is installed, also run the real `docker compose config`: it judges
 * syntax and interpolation, which the parser cannot. Skipped (not failed) when
 * Docker is absent, so this stays runnable everywhere — the parser checks above
 * are the invariants that always run. Dummy values render the file without
 * starting anything.
 */
function dockerComposeConfig() {
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' })
  if (probe.status !== 0) {
    console.log('docker compose not available — skipping `docker compose config` (parser checks still ran).')
    return true
  }

  const result = spawnSync(
    'docker',
    ['compose', '-f', composePath, 'config', '--quiet'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        POSTGRES_USER: 'ci',
        POSTGRES_PASSWORD: 'compose-check-not-real',
        POSTGRES_DB: 'ci',
        DATABASE_URL: 'postgresql://ci:compose-check-not-real@postgres:5432/ci',
        JWT_SECRET: 'compose-check-jwt-at-least-thirty-two-chars',
        CORS_ORIGINS: 'https://ci.example.com',
        TELEGRAM_BOT_TOKEN: '000000:compose-check-not-a-real-token',
        TELEGRAM_WEBHOOK_SECRET: 'compose-check-webhook-secret-not-real',
        DOMAIN: 'ci.example.com',
        ACME_EMAIL: 'ci@example.com',
      },
    },
  )
  if (result.status === 0) {
    console.log('`docker compose config` OK.')
    return true
  }
  console.error('`docker compose config` failed:')
  console.error((result.stderr || result.stdout || '').trim())
  return false
}

async function main() {
  const raw = await readFile(composePath, 'utf8')
  const doc = YAML.parse(raw)
  const violations = checkProductionCompose(doc)

  if (violations.length > 0) {
    for (const v of violations) console.error(`[${v.rule}] ${v.message}`)
    process.exitCode = 1
    return
  }
  console.log(`Production compose check passed (${Object.keys(doc.services ?? {}).length} services).`)

  if (!dockerComposeConfig()) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
}
