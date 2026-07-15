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
  // Aegis / Telegram (optional in dev; required to run the webhook + Mini App auth)
  TELEGRAM_BOT_TOKEN: optionalStringSchema,
  TELEGRAM_WEBHOOK_SECRET: optionalStringSchema,
  TELEGRAM_INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().positive().optional(),
  // 'memory' runs the archive in-memory (data is lost on restart) when Postgres is unavailable.
  ARCHIVE_STORE: z.enum(['memory', 'postgres']).optional(),
  // Media storage: 'local' (disk fallback) or 's3' (SPACES_*). Default: s3 if configured else local.
  MEDIA_STORAGE: z.enum(['local', 's3']).optional(),
  MEDIA_LOCAL_DIR: optionalStringSchema,
  // Max bytes we attempt to download from Telegram (Bot API caps ~20MB without a local API server).
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().optional(),
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
  validateAegisProductionEnv(env, ctx)
})

/**
 * Production hard requirements for Aegis. Runs only for production-like runtimes
 * (NODE_ENV=production or COOKIE_SECURE). Fails fast so a misconfigured prod
 * deploy never silently loses data or serves an unauthenticated webhook.
 */
function validateAegisProductionEnv(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (!isProductionLikeRuntime(env)) return

  const require = (cond: boolean, path: string, message: string) => {
    if (!cond) ctx.addIssue({ code: 'custom', path: [path], message })
  }

  require(env.ARCHIVE_STORE !== 'memory', 'ARCHIVE_STORE', 'must not be "memory" in production (data would be lost on restart)')
  require(Boolean(env.TELEGRAM_BOT_TOKEN), 'TELEGRAM_BOT_TOKEN', 'is required in production')
  require(Boolean(env.TELEGRAM_WEBHOOK_SECRET), 'TELEGRAM_WEBHOOK_SECRET', 'is required in production')
  // Containers have ephemeral disks — local media storage would lose files on redeploy.
  require(env.MEDIA_STORAGE !== 'local', 'MEDIA_STORAGE', 'must be "s3" in production (local disk is ephemeral)')
  require(
    /sslmode=require|supabase\.(co|com)|\.pooler\./i.test(env.DATABASE_URL),
    'DATABASE_URL',
    'must use TLS in production (append ?sslmode=require, or use a Supabase/pooler host)',
  )
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
