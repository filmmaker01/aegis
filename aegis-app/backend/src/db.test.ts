import { describe, expect, test } from 'bun:test'

import { normalizePgConnectionString } from './db'

describe('normalizePgConnectionString', () => {
  test('adds libpq compatibility for DigitalOcean sslmode=require URLs', () => {
    const result = normalizePgConnectionString(
      'postgresql://user:pass@db.example.com:25060/defaultdb?sslmode=require',
    )

    expect(result).toBe(
      'postgresql://user:pass@db.example.com:25060/defaultdb?sslmode=require&uselibpqcompat=true',
    )
  })

  test('preserves explicit libpq compatibility choice', () => {
    const result = normalizePgConnectionString(
      'postgresql://user:pass@db.example.com:25060/defaultdb?sslmode=require&uselibpqcompat=false',
    )

    expect(result).toBe(
      'postgresql://user:pass@db.example.com:25060/defaultdb?sslmode=require&uselibpqcompat=false',
    )
  })

  test('does not change non-TLS local URLs', () => {
    const result = normalizePgConnectionString(
      'postgresql://superuser:superpassword@localhost:54329/web_app_demo?schema=public',
    )

    expect(result).toBe('postgresql://superuser:superpassword@localhost:54329/web_app_demo?schema=public')
  })
})
