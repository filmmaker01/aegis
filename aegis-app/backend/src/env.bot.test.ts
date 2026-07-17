import { describe, expect, test } from 'bun:test'

import { loadEnv } from './env'

const STRONG_JWT = 'a'.repeat(20) + 'B7x' + 'q'.repeat(20)

function base(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    // The production topology: Postgres on a private Docker network, no TLS.
    DATABASE_URL: 'postgresql://planner:s3cret@postgres:5432/planner?schema=public',
    JWT_SECRET: STRONG_JWT,
    CORS_ORIGINS: 'https://app.example.com',
    TASKS_STORE: 'postgres',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_SECRET: 'whsec',
    ...overrides,
  }
}

/** Does this DATABASE_URL survive the production transport check? */
function accepts(databaseUrl: string): boolean {
  try {
    loadEnv(base({ DATABASE_URL: databaseUrl }))
    return true
  } catch {
    return false
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

  test('accepts a TLS URL to a managed provider', () => {
    expect(accepts('postgresql://u:p@db.pooler.supabase.com:5432/postgres?sslmode=require')).toBe(true)
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

/**
 * The rule: a production database must not be reached over an untrusted network
 * in the clear. Either TLS is on, or the host is unreachable from outside the
 * machine / its private network.
 */
describe('DATABASE_URL transport in production', () => {
  describe('private hosts — no TLS needed, the network is the control', () => {
    test('a Docker service name', () => {
      expect(accepts('postgresql://planner:s3cret@postgres:5432/planner')).toBe(true)
      expect(accepts('postgresql://planner:s3cret@db:5432/planner')).toBe(true)
    })

    test('loopback', () => {
      expect(accepts('postgresql://u:p@localhost:5432/db')).toBe(true)
      expect(accepts('postgresql://u:p@127.0.0.1:5432/db')).toBe(true)
      expect(accepts('postgresql://u:p@[::1]:5432/db')).toBe(true)
    })

    test('RFC1918 ranges', () => {
      expect(accepts('postgresql://u:p@10.0.0.5:5432/db')).toBe(true)
      expect(accepts('postgresql://u:p@172.16.0.5:5432/db')).toBe(true)
      expect(accepts('postgresql://u:p@172.31.255.254:5432/db')).toBe(true)
      expect(accepts('postgresql://u:p@192.168.1.10:5432/db')).toBe(true)
    })
  })

  describe('public hosts — TLS required', () => {
    test('a public hostname without TLS is rejected', () => {
      expect(accepts('postgresql://u:p@db.example.com:5432/x')).toBe(false)
    })

    test('a public IP without TLS is rejected', () => {
      expect(accepts('postgresql://u:p@203.0.113.10:5432/x')).toBe(false)
    })

    test('a public hostname with sslmode=require is accepted', () => {
      expect(accepts('postgresql://u:p@db.example.com:5432/x?sslmode=require')).toBe(true)
    })

    test('verify-ca and verify-full are accepted too', () => {
      expect(accepts('postgresql://u:p@db.example.com:5432/x?sslmode=verify-ca')).toBe(true)
      expect(accepts('postgresql://u:p@db.example.com:5432/x?sslmode=verify-full')).toBe(true)
    })

    test('sslmode=disable on a public host is rejected', () => {
      expect(accepts('postgresql://u:p@db.example.com:5432/x?sslmode=disable')).toBe(false)
    })

    test('an address just outside RFC1918 is public', () => {
      // 172.15/172.32 bracket the private block and must not be mistaken for it.
      expect(accepts('postgresql://u:p@172.15.0.1:5432/db')).toBe(false)
      expect(accepts('postgresql://u:p@172.32.0.1:5432/db')).toBe(false)
      expect(accepts('postgresql://u:p@11.0.0.1:5432/db')).toBe(false)
    })

    test('a non-loopback IPv6 literal is public', () => {
      // Guards the "no dot means a container name" branch: an IPv6 host has no dots.
      expect(accepts('postgresql://u:p@[2001:db8::1]:5432/db')).toBe(false)
    })
  })

  describe('the decision comes from the parsed URL, not from substrings', () => {
    test('supabase.co in the password does not grant a pass', () => {
      // The old rule regex-matched the whole URL, so this string alone satisfied it.
      expect(accepts('postgresql://u:supabase.co@db.example.com:5432/x')).toBe(false)
    })

    test('sslmode=require inside the password does not grant a pass', () => {
      expect(accepts('postgresql://u:sslmode%3Drequire@db.example.com:5432/x')).toBe(false)
    })

    test('supabase.co in the database name does not grant a pass', () => {
      expect(accepts('postgresql://u:p@db.example.com:5432/supabase.co')).toBe(false)
    })

    test('an unparseable URL fails closed', () => {
      expect(accepts('not-a-url')).toBe(false)
    })
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
