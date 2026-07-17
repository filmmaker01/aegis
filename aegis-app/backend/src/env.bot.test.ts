import { describe, expect, test } from 'bun:test'

import { loadEnv } from './env'

const STRONG_JWT = 'a'.repeat(20) + 'B7x' + 'q'.repeat(20)

function base(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db.pooler.supabase.com:5432/postgres?sslmode=require',
    JWT_SECRET: STRONG_JWT,
    CORS_ORIGINS: 'https://app.example.com',
    TASKS_STORE: 'postgres',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_SECRET: 'whsec',
    ...overrides,
  }
}

describe('bot production env validation', () => {
  test('accepts a fully-configured production env', () => {
    expect(() => loadEnv(base())).not.toThrow()
  })

  test('rejects TASKS_STORE=memory in production', () => {
    expect(() => loadEnv(base({ TASKS_STORE: 'memory' }))).toThrow()
  })

  test('rejects missing TELEGRAM_BOT_TOKEN / WEBHOOK_SECRET in production', () => {
    expect(() => loadEnv(base({ TELEGRAM_BOT_TOKEN: undefined }))).toThrow()
    expect(() => loadEnv(base({ TELEGRAM_WEBHOOK_SECRET: undefined }))).toThrow()
  })

  test('rejects a non-TLS DATABASE_URL in production', () => {
    expect(() => loadEnv(base({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }))).toThrow()
  })

  test('does NOT enforce production rules for non-production runtimes', () => {
    // local dev: the in-memory store is allowed
    expect(() =>
      loadEnv({
        DATABASE_URL: 'postgresql://localhost:5432/db',
        JWT_SECRET: STRONG_JWT,
        CORS_ORIGINS: 'http://localhost:5173',
        TASKS_STORE: 'memory',
      }),
    ).not.toThrow()
  })
})

describe('reminder sweep interval', () => {
  test('defaults to 30s', () => {
    expect(loadEnv(base()).REMINDER_SWEEP_SECONDS).toBe(30)
  })

  test('accepts an override', () => {
    expect(loadEnv(base({ REMINDER_SWEEP_SECONDS: '10' })).REMINDER_SWEEP_SECONDS).toBe(10)
  })

  test('rejects a nonsensical interval', () => {
    // 0/negative would busy-loop; >15min would make "через 15 минут" arrive late.
    expect(() => loadEnv(base({ REMINDER_SWEEP_SECONDS: '0' }))).toThrow()
    expect(() => loadEnv(base({ REMINDER_SWEEP_SECONDS: '-5' }))).toThrow()
    expect(() => loadEnv(base({ REMINDER_SWEEP_SECONDS: '5000' }))).toThrow()
  })
})
