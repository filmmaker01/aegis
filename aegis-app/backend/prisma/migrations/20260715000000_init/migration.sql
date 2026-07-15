-- Aegis initial migration.
-- Postgres < 18 lacks the uuidv7() builtin used by table id defaults, so define it
-- first (in the public schema). On Postgres 18+ this simply shadows the builtin.
CREATE OR REPLACE FUNCTION public.uuidv7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
          PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_connections" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "connection_id" TEXT NOT NULL,
    "owner_tg_user_id" BIGINT NOT NULL,
    "tg_user_chat_id" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "rights" JSONB NOT NULL DEFAULT '{}',
    "connected_at" TIMESTAMP(3) NOT NULL,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "connection_id" UUID NOT NULL,
    "tg_chat_id" BIGINT NOT NULL,
    "peer_title" TEXT,
    "peer_username" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMP(3),

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "connection_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "tg_message_id" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "from_tg_id" BIGINT,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "current_text" TEXT,
    "has_media" BOOLEAN NOT NULL DEFAULT false,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "text" TEXT,
    "edit_date" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB NOT NULL,

    CONSTRAINT "message_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deleted_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "connection_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "message_id" UUID,
    "tg_message_id" INTEGER NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "deleted_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "tg_file_id" TEXT NOT NULL,
    "tg_file_unique_id" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "storage_key" TEXT,
    "checksum" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failed_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stored_at" TIMESTAMP(3),

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_updates" (
    "update_id" BIGINT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_updates_pkey" PRIMARY KEY ("update_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "business_connections_connection_id_key" ON "business_connections"("connection_id");

-- CreateIndex
CREATE INDEX "business_connections_owner_idx" ON "business_connections"("owner_tg_user_id");

-- CreateIndex
CREATE INDEX "chats_connection_last_msg_idx" ON "chats"("connection_id", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "chats_connection_chat_key" ON "chats"("connection_id", "tg_chat_id");

-- CreateIndex
CREATE INDEX "messages_chat_sent_idx" ON "messages"("chat_id", "sent_at");

-- CreateIndex
CREATE INDEX "messages_conn_deleted_idx" ON "messages"("connection_id", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conn_chat_msg_key" ON "messages"("connection_id", "chat_id", "tg_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_versions_msg_version_key" ON "message_versions"("message_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "deleted_events_message_id_key" ON "deleted_events"("message_id");

-- CreateIndex
CREATE INDEX "deleted_events_conn_detected_idx" ON "deleted_events"("connection_id", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "deleted_events_conn_chat_msg_key" ON "deleted_events"("connection_id", "chat_id", "tg_message_id");

-- CreateIndex
CREATE INDEX "media_state_idx" ON "media"("state");

-- CreateIndex
CREATE UNIQUE INDEX "media_message_file_key" ON "media"("message_id", "tg_file_id");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "business_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "business_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_events" ADD CONSTRAINT "deleted_events_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "business_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_events" ADD CONSTRAINT "deleted_events_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deleted_events" ADD CONSTRAINT "deleted_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

