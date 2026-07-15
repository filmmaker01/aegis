import 'dotenv/config'
import { defineConfig } from 'prisma/config'

const localDatabaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://superuser:superpassword@localhost:54329/web_app_demo?schema=public'

// Runtime uses the (pooled) DATABASE_URL. Migrations use a direct connection
// (DIRECT_URL) when connection pooling is in front of Postgres; falls back to
// DATABASE_URL when no separate direct URL is configured (e.g. local dev).
const directUrl = process.env.DIRECT_URL ?? localDatabaseUrl

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: localDatabaseUrl,
    directUrl,
    // Only needed for `prisma migrate dev` / diffing a migrations dir locally.
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
})
