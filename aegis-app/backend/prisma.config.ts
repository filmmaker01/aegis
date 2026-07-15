import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// prisma.config.url is used ONLY by the Prisma CLI (migrate / studio) — the runtime
// app connects with its own pg adapter via env.DATABASE_URL and never reads this.
// So the CLI must use a DIRECT connection (DIRECT_URL) when a pooler fronts Postgres;
// migrations can't run through a transaction pooler. Runtime keeps using the pooled
// DATABASE_URL. Falls back to DATABASE_URL / a local default when DIRECT_URL is unset.
const migrationUrl =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  'postgresql://superuser:superpassword@localhost:54329/web_app_demo?schema=public'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: migrationUrl,
    // Only needed for `prisma migrate dev` / diffing a migrations dir locally.
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
})
