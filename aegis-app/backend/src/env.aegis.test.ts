import { describe, expect, test } from 'bun:test'

import { loadEnv } from './env'

const STRONG_JWT = 'a'.repeat(20) + 'B7x' + 'q'.repeat(20)

function base(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.pooler.supabase.com:5432/postgres?sslmode=require',
    JWT_SECRET: STRONG_JWT,
    CORS_ORIGINS: 'https://app.example.com',
    ARCHIVE_STORE: 'postgres',
    MEDIA_STORAGE: 's3',
    SPACES_REGION: 'eu-central-1',
    SPACES_BUCKET: 'aegis-media',
    SPACES_ENDPOINT: 'https://ref.supabase.co/storage/v1/s3',
    SPACES_ACCESS_KEY_ID: 'key',
    SPACES_SECRET_ACCESS_KEY: 'secret',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_SECRET: 'whsec',
    ...overrides,
  }
}

describe('Aegis production env validation', () => {
  test('accepts a fully-configured production env', () => {
    expect(() => loadEnv(base())).not.toThrow()
  })

  test('rejects ARCHIVE_STORE=memory in production', () => {
    expect(() => loadEnv(base({ ARCHIVE_STORE: 'memory' }))).toThrow()
  })

  test('rejects MEDIA_STORAGE=local in production (ephemeral disk)', () => {
    expect(() => loadEnv(base({ MEDIA_STORAGE: 'local' }))).toThrow()
  })

  test('rejects missing TELEGRAM_BOT_TOKEN / WEBHOOK_SECRET in production', () => {
    expect(() => loadEnv(base({ TELEGRAM_BOT_TOKEN: undefined }))).toThrow()
    expect(() => loadEnv(base({ TELEGRAM_WEBHOOK_SECRET: undefined }))).toThrow()
  })

  test('rejects a non-TLS DATABASE_URL in production', () => {
    expect(() => loadEnv(base({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }))).toThrow()
  })

  test('does NOT enforce production rules for non-production runtimes', () => {
    // local dev: memory + local disk are allowed
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://localhost:5432/db',
        JWT_SECRET: STRONG_JWT,
        CORS_ORIGINS: 'http://localhost:5173',
        ARCHIVE_STORE: 'memory',
        MEDIA_STORAGE: 'local',
      }),
    ).not.toThrow()
  })
})
