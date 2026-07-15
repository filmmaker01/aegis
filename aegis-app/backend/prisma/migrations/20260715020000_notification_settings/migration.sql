-- CreateTable
CREATE TABLE "notification_settings" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "connection_id" UUID NOT NULL,
    "notify_deletions" BOOLEAN NOT NULL DEFAULT true,
    "notify_edits" BOOLEAN NOT NULL DEFAULT true,
    "notify_media" BOOLEAN NOT NULL DEFAULT true,
    "group_batches" BOOLEAN NOT NULL DEFAULT true,
    "muted_chats" BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_connection_id_key" ON "notification_settings"("connection_id");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "business_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable Row Level Security (deny-by-default), matching the other Aegis tables.
-- RLS cannot be expressed in schema.prisma, so it lives in the migration (the same
-- escape hatch used by 20260715010000_enable_rls). The backend uses a privileged
-- connection that bypasses RLS; this only blocks the Supabase anon/authenticated roles.
ALTER TABLE "notification_settings" ENABLE ROW LEVEL SECURITY;
