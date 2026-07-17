-- Manual rollback for 20260717000000_tasks_replace_archive.
--
-- Prisma does NOT run this file (it only executes migration.sql); it is documentation
-- you paste into psql. Run it inside a transaction, against the SAME database the
-- migration was applied to.
--
-- This reverses the migration WITHOUT data loss, because the forward migration only
-- MOVED the archive tables to the `retired_aegis` schema instead of dropping them.
--
--   psql "$DIRECT_URL" -1 -f rollback.sql
--
-- After running it, also remove the migration row so Prisma stops considering it
-- applied (the last statement does this).

BEGIN;

-- 1. Drop the planner tables. Task data created by the planner IS destroyed here —
--    dump it first if you care about it:
--      pg_dump "$DIRECT_URL" -t public.tasks -t public.bot_users -t public.task_drafts -Fc -f planner.dump
DROP TABLE IF EXISTS "public"."task_drafts";
DROP TABLE IF EXISTS "public"."tasks";
DROP TABLE IF EXISTS "public"."bot_users";

-- 2. Move the archive tables back into `public`. Constraints/indexes travel with them.
ALTER TABLE IF EXISTS "retired_aegis"."business_connections" SET SCHEMA "public";
ALTER TABLE IF EXISTS "retired_aegis"."notification_settings" SET SCHEMA "public";
ALTER TABLE IF EXISTS "retired_aegis"."chats" SET SCHEMA "public";
ALTER TABLE IF EXISTS "retired_aegis"."messages" SET SCHEMA "public";
ALTER TABLE IF EXISTS "retired_aegis"."deleted_events" SET SCHEMA "public";
ALTER TABLE IF EXISTS "retired_aegis"."message_versions" SET SCHEMA "public";
ALTER TABLE IF EXISTS "retired_aegis"."media" SET SCHEMA "public";

DROP SCHEMA IF EXISTS "retired_aegis";

-- 3. Forget the migration so `prisma migrate deploy` can re-apply it later.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260717000000_tasks_replace_archive';

COMMIT;

-- 4. Check out the pre-migration commit so schema.prisma matches the restored tables,
--    then `bun run --cwd backend prisma:generate`.
