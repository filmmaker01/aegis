# 20260717000000_tasks_replace_archive

Replaces the retired Aegis archive with the task planner.

## What it touches

**Preserved, not dropped** — moved from `public` to the `retired_aegis` schema:
`business_connections`, `notification_settings`, `chats`, `messages`, `message_versions`,
`deleted_events`, `media`. No rows are destroyed. Constraints and indexes move with the tables,
so the foreign keys between them stay intact.

**Created** in `public`: `bot_users`, `tasks`, `task_drafts` (+ indexes, foreign keys, and RLS
enabled deny-by-default, matching the posture of the tables they replace).

**Untouched** — every table another subsystem needs:

| Table | Used by | Status |
|---|---|---|
| `users`, `auth_sessions` | auth module (`/api/auth`) | untouched |
| `processed_updates` | webhook `update_id` idempotency | untouched |
| `_prisma_migrations` | Prisma | untouched (only the rollback deletes its own row) |

Monitoring is in-process (`src/monitoring.ts`, counters only) and storage is S3/Supabase Storage —
neither has tables here, so neither is affected.

## Safety notes

- Prisma wraps the file in a transaction: a failure applies nothing.
- `ALTER TABLE IF EXISTS` makes the retirement step tolerant of a database where the archive
  tables were already removed by hand.
- Because Prisma only manages `public`, moving the tables out is indistinguishable from dropping
  them as far as schema drift is concerned — but it is reversible.

## Rollback

See `rollback.sql` in this directory (Prisma does not execute it; paste it into psql). It drops
the planner tables, moves the archive tables back into `public`, and deletes this migration's row
from `_prisma_migrations`.

**Planner task data is destroyed by the rollback.** Dump it first if it matters:

```bash
pg_dump "$DIRECT_URL" -t public.tasks -t public.bot_users -t public.task_drafts -Fc -f planner.dump
```

## Restoring from backup instead

If you would rather restore the whole database (Supabase → Database → Backups, or PITR):

1. Note the timestamp **before** the migration ran.
2. Supabase dashboard → Database → Backups → restore to that point (PITR) or the latest daily.
3. Check out the pre-migration commit and run `bun run --cwd backend prisma:generate`.

## Finally dropping the archive

Once the planner is verified in production and a backup is confirmed, retire the data for real
with a **separate** migration:

```sql
DROP SCHEMA "retired_aegis" CASCADE;
```

Do not fold that into this migration — keeping it separate is what makes this one reversible.
