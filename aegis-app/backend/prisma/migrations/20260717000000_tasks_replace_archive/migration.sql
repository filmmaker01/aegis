-- Replace the retired Aegis archive with the task planner.
--
-- SAFETY: the archive tables are NOT dropped. They are moved out of `public` into
-- the `retired_aegis` schema, so:
--   * no rows are destroyed and this migration is reversible (see rollback.sql);
--   * Prisma sees exactly what a DROP would have left behind, because it only
--     manages `public` — so there is no schema drift;
--   * Supabase's PostgREST Data API only exposes configured schemas (`public` by
--     default), so the retired tables stop being reachable over the API.
-- Constraints and indexes travel with their tables, so the foreign keys between
-- the archive tables stay intact and no DROP CONSTRAINT is needed.
--
-- Dropping `retired_aegis` for real is a SEPARATE, later migration — run it only
-- once the planner has been verified in production and a backup is confirmed.
--
-- Prisma wraps this file in a transaction: if any statement fails, nothing applies.

CREATE SCHEMA IF NOT EXISTS "retired_aegis";

ALTER TABLE IF EXISTS "public"."media" SET SCHEMA "retired_aegis";
ALTER TABLE IF EXISTS "public"."message_versions" SET SCHEMA "retired_aegis";
ALTER TABLE IF EXISTS "public"."deleted_events" SET SCHEMA "retired_aegis";
ALTER TABLE IF EXISTS "public"."messages" SET SCHEMA "retired_aegis";
ALTER TABLE IF EXISTS "public"."chats" SET SCHEMA "retired_aegis";
ALTER TABLE IF EXISTS "public"."notification_settings" SET SCHEMA "retired_aegis";
ALTER TABLE IF EXISTS "public"."business_connections" SET SCHEMA "retired_aegis";

-- CreateTable
CREATE TABLE "bot_users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "telegram_user_id" BIGINT NOT NULL,
    "timezone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "telegram_user_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "remind_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reminder_state" TEXT NOT NULL DEFAULT 'pending',
    "reminder_attempts" INTEGER NOT NULL DEFAULT 0,
    "reminder_next_attempt_at" TIMESTAMP(3),
    "reminder_sent_at" TIMESTAMP(3),
    "reminder_failed_reason" TEXT,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_drafts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "telegram_user_id" BIGINT NOT NULL,
    "step" TEXT NOT NULL,
    "title" TEXT,
    "task_id" UUID,
    "card_chat_id" BIGINT,
    "card_message_id" INTEGER,
    "remind_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_users_telegram_user_id_key" ON "bot_users"("telegram_user_id");

-- CreateIndex
CREATE INDEX "tasks_user_status_remind_idx" ON "tasks"("telegram_user_id", "status", "remind_at");

-- CreateIndex
CREATE INDEX "tasks_reminder_due_idx" ON "tasks"("reminder_state", "remind_at", "reminder_next_attempt_at");

-- CreateIndex
CREATE INDEX "tasks_reminder_stalled_idx" ON "tasks"("reminder_state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "task_drafts_telegram_user_id_key" ON "task_drafts"("telegram_user_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "bot_users"("telegram_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_telegram_user_id_fkey" FOREIGN KEY ("telegram_user_id") REFERENCES "bot_users"("telegram_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Enable Row Level Security (deny-by-default) on the new planner tables.
--
-- Same posture as the tables they replace: the backend reaches Postgres through a
-- privileged role that bypasses RLS, so no policies are needed for it to work.
-- Enabling RLS with NO policies blocks the Supabase anon/authenticated roles
-- (PostgREST Data API) from reading or writing any row. These tables hold task
-- titles and Telegram user ids and must never be reachable via the anon key.
ALTER TABLE "bot_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_drafts" ENABLE ROW LEVEL SECURITY;
