import { z } from 'zod'

const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const knownWeakJwtSecrets = new Set(['replace-with-at-least-32-random-characters'])

const optionalStringSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().min(1).optional())

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().url().optional())

const stringWithDefault = (defaultValue: string) =>
  z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }, z.string().min(1).default(defaultValue))

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // Direct (non-pooled) connection for Prisma migrations behind a pooler. CLI-only.
  DIRECT_URL: optionalStringSchema,
  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173,http://localhost:8081,http://localhost:19006')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Telegram (optional in dev; required to run the webhook)
  TELEGRAM_BOT_TOKEN: optionalStringSchema,
  TELEGRAM_WEBHOOK_SECRET: optionalStringSchema,
  // 'memory' runs the planner in-memory (data is lost on restart) when Postgres is unavailable.
  TASKS_STORE: z.enum(['memory', 'postgres']).optional(),
  // How often the in-process ticker scans for due reminders.
  REMINDER_SWEEP_SECONDS: z.coerce.number().int().positive().max(900).default(30),
  // Delivery attempts before a reminder is given up on (state -> failed).
  REMINDER_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  // How long a `processing` claim may sit before the reaper assumes the sweep that
  // took it died and returns it to `retry`. Must comfortably exceed a real send;
  // too low risks re-delivering a slow-but-alive attempt.
  REMINDER_STALLED_AFTER_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  // Optional error tracking (e.g. Sentry). Empty disables it.
  SENTRY_DSN: optionalStringSchema,
  COOKIE_SECURE: booleanStringSchema,
  SPACES_REGION: optionalStringSchema,
  SPACES_BUCKET: optionalStringSchema,
  SPACES_ENDPOINT: optionalUrlSchema,
  SPACES_CDN_BASE_URL: optionalUrlSchema,
  SPACES_ACCESS_KEY_ID: optionalStringSchema,
  SPACES_SECRET_ACCESS_KEY: optionalStringSchema,
  SPACES_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SPACES_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(15 * 60),
  SPACES_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(7 * 24 * 60 * 60).default(5 * 60),
  SPACES_PUBLIC_CACHE_CONTROL: stringWithDefault('public, max-age=31536000, immutable'),
}).superRefine((env, ctx) => {
  validateJwtSecret(env, ctx)
  validateCorsOrigins(env, ctx)
  validateStorageEnv(env, ctx)
  validateBotProductionEnv(env, ctx)
})

/**
 * Production hard requirements for the bot. Runs only for production-like
 * runtimes (NODE_ENV=production or COOKIE_SECURE). Fails fast so a misconfigured
 * prod deploy never silently loses data or serves an unauthenticated webhook.
 */
function validateBotProductionEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!isProductionLikeRuntime(env)) return

  const require = (cond: boolean, path: string, message: string) => {
    if (!cond) ctx.addIssue({ code: 'custom', path: [path], message })
  }

  require(env.TASKS_STORE !== 'memory', 'TASKS_STORE', 'must not be "memory" in production (tasks would be lost on restart)')
  require(Boolean(env.TELEGRAM_BOT_TOKEN), 'TELEGRAM_BOT_TOKEN', 'is required in production')
  require(Boolean(env.TELEGRAM_WEBHOOK_SECRET), 'TELEGRAM_WEBHOOK_SECRET', 'is required in production')
  validateDatabaseUrlTransport(env, ctx)
}

/**
 * The database connection must never cross an untrusted network in the clear.
 *
 * Two shapes satisfy that, and the check accepts exactly those:
 *   1. TLS is on (sslmode=require | verify-ca | verify-full);
 *   2. the host is unreachable from outside the machine or its private network —
 *      loopback, an RFC1918 address, or a bare hostname, which can only be a
 *      container/service name on a private Docker network.
 *
 * Anything else — a public DNS name or a public IP without TLS — is rejected.
 *
 * The URL is PARSED rather than pattern-matched. The previous rule ran a regex
 * over the whole DATABASE_URL looking for `sslmode=require|supabase\.(co|com)`,
 * which passed on a mere substring: a password containing "supabase.co" was
 * enough to satisfy it, and it tied production to one hosting provider. Parsing
 * the URL is both stricter and provider-agnostic.
 */
function validateDatabaseUrlTransport(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  let url: URL
  try {
    url = new URL(env.DATABASE_URL)
  } catch {
    // Fail closed: an unparseable URL is never assumed safe.
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'must be a valid connection URL so its transport can be verified in production',
    })
    return
  }

  const sslmode = url.searchParams.get('sslmode')?.toLowerCase()
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') return
  if (isPrivateDbHost(url.hostname)) return

  ctx.addIssue({
    code: 'custom',
    path: ['DATABASE_URL'],
    message:
      'must not reach a public database host without TLS in production. ' +
      'Use sslmode=require (or verify-ca/verify-full), or keep the database on a private network ' +
      '(loopback, an RFC1918 address, or a Docker service name).',
  })
}

/**
 * Is this host confined to the machine or a private network?
 *
 * `hostname` comes from the URL parser, so an IPv6 literal arrives bracketed.
 * Only ::1 is accepted among IPv6 addresses: any other IPv6 literal is treated
 * as public, because a colon-bearing host would otherwise slip through the
 * "no dot means a container name" rule below.
 */
function isPrivateDbHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')

  if (host === 'localhost') return true
  if (host === '::1') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true

  // Any remaining IPv6 literal is public.
  if (host.includes(':')) return false
  // A name with no dot is not resolvable on the public internet: on this stack it
  // is a Docker service name (`postgres`, `db`) on a network marked internal.
  if (!host.includes('.')) return true

  return false
}

export type AppEnv = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>) {
  return envSchema.parse(source)
}

function validateJwtSecret(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!isProductionLikeRuntime(env)) return

  if (isWeakJwtSecret(env.JWT_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'JWT_SECRET must be a non-placeholder random secret in production',
    })
  }
}

function isProductionLikeRuntime(env: z.infer<typeof envSchema>) {
  return env.NODE_ENV === 'production' || env.COOKIE_SECURE
}

function isWeakJwtSecret(secret: string) {
  const normalized = secret.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    knownWeakJwtSecrets.has(normalized) ||
    new Set(normalized).size === 1
  )
}

function validateCorsOrigins(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.CORS_ORIGINS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ORIGINS'],
      message: 'CORS_ORIGINS must contain at least one allowed browser origin',
    })
    return
  }

  for (const origin of env.CORS_ORIGINS) {
    if (origin === '*') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not use wildcard origins when credentials are enabled',
      })
      continue
    }

    let url: URL
    try {
      url = new URL(origin)
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS contains an invalid URL: ${origin}`,
      })
      continue
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use http or https origins: ${origin}`,
      })
    }

    if (url.origin !== origin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must contain origins only, not paths: ${origin}`,
      })
    }

    if (env.COOKIE_SECURE && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use HTTPS when COOKIE_SECURE=true: ${origin}`,
      })
    }
  }
}

function validateStorageEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  const requiredStorageKeys = [
    'SPACES_REGION',
    'SPACES_BUCKET',
    'SPACES_ENDPOINT',
    'SPACES_ACCESS_KEY_ID',
    'SPACES_SECRET_ACCESS_KEY',
  ] as const
  const storageConfigured =
    requiredStorageKeys.some((key) => env[key] !== undefined) || env.SPACES_CDN_BASE_URL !== undefined

  if (!storageConfigured) return

  for (const key of requiredStorageKeys) {
    if (env[key] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when DigitalOcean Spaces storage is configured`,
      })
    }
  }
}
