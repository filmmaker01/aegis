# 03 — Database schema (PostgreSQL / Supabase)

Conventions: `uuid` PKs (except where Telegram IDs are natural), `bigint` for Telegram IDs,
`timestamptz` everywhere, soft-delete via flags (never hard-delete content we must show).
Row-Level Security on every user-facing table, scoped by `owner_user_id`.

## Enums

```sql
create type connection_state as enum ('active','disabled','revoked');
create type message_direction as enum ('incoming','outgoing');
create type media_type as enum ('photo','video','video_note','voice','audio','document','animation','sticker');
create type media_state as enum ('pending','stored','unavailable','purged');
create type delete_initiator as enum ('unknown','owner_via_bot'); -- see Q4: real attribution impossible
create type sub_tier as enum ('free','pro','business');
create type sub_status as enum ('active','past_due','canceled','trialing');
```

> `delete_initiator` deliberately has only `unknown` and `owner_via_bot`. We can mark a
> deletion as `owner_via_bot` **only** when our own bot issued the delete; every other
> deletion is `unknown`. There is no honest third value (research Q4).

## Tables

### users
The Telegram user who installed our service (the business account owner).
```sql
create table users (
  id            uuid primary key default gen_random_uuid(),
  tg_user_id    bigint unique not null,
  username      text,
  first_name    text,
  last_name     text,
  language_code text,
  is_premium    boolean,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
```

### business_connections
One row per bot↔account connection. Mirrors `BusinessConnection`.
```sql
create table business_connections (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      text unique not null,          -- Telegram business_connection_id
  owner_user_id      uuid not null references users(id) on delete cascade,
  tg_user_chat_id    bigint not null,               -- BusinessConnection.user_chat_id
  state              connection_state not null default 'active',
  rights             jsonb not null default '{}',   -- snapshot of BusinessBotRights
  connected_at       timestamptz not null,          -- BusinessConnection.date
  disconnected_at    timestamptz,
  updated_at         timestamptz not null default now()
);
create index on business_connections (owner_user_id);
```

### chats
Private chats seen through a connection (the partner).
```sql
create table chats (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references business_connections(id) on delete cascade,
  tg_chat_id     bigint not null,                   -- BusinessMessagesDeleted.chat.id / Message.chat.id
  peer_user_id   bigint,                            -- partner's user id if known
  title          text,                              -- display name of partner
  username       text,
  is_monitored   boolean not null default true,     -- mirrors owner's recipient set
  first_seen_at  timestamptz not null default now(),
  last_message_at timestamptz,
  unique (connection_id, tg_chat_id)
);
create index on chats (connection_id, last_message_at desc);
```

### messages
The archive. **The core table.** One row per Telegram message we ever saw.
```sql
create table messages (
  id              uuid primary key default gen_random_uuid(),
  connection_id   uuid not null references business_connections(id) on delete cascade,
  chat_id         uuid not null references chats(id) on delete cascade,
  tg_message_id   bigint not null,                  -- Message.message_id
  direction       message_direction not null,
  from_tg_id      bigint,                           -- Message.from.id
  sent_at         timestamptz not null,             -- Message.date (original)
  current_text    text,                             -- latest known text/caption
  has_media       boolean not null default false,
  is_edited       boolean not null default false,
  is_deleted      boolean not null default false,
  received_at     timestamptz not null default now(),
  raw             jsonb,                             -- full latest Message payload (audited)
  unique (connection_id, chat_id, tg_message_id)
);
create index on messages (chat_id, sent_at desc);
create index on messages (connection_id) where is_deleted;
```

### message_versions
Full edit history — every version we ever received (edits Q2).
```sql
create table message_versions (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references messages(id) on delete cascade,
  version_no   int not null,                        -- 1 = original, 2..n edits
  text         text,
  raw          jsonb not null,                      -- full Message at this version
  edit_date    timestamptz,                         -- Message.edit_date if present
  captured_at  timestamptz not null default now(),
  unique (message_id, version_no)
);
```

### deleted_events
One row per delete notification we processed. Note: no honest initiator/time from Telegram.
```sql
create table deleted_events (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references business_connections(id) on delete cascade,
  chat_id           uuid not null references chats(id) on delete cascade,
  message_id        uuid references messages(id) on delete set null,   -- null if never archived
  tg_message_id     bigint not null,
  initiator         delete_initiator not null default 'unknown',
  detected_at       timestamptz not null default now(),   -- our receipt time ≈ deletion time
  notified_at       timestamptz,
  unique (connection_id, chat_id, tg_message_id)
);
create index on deleted_events (connection_id, detected_at desc);
```

### media
Copied blobs. `state` records the E‑4 outcome.
```sql
create table media (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references messages(id) on delete cascade,
  type          media_type not null,
  tg_file_id    text not null,
  tg_file_unique_id text,
  mime_type     text,
  size_bytes    bigint,
  storage_key   text,                               -- S3/Supabase object key, null until stored
  state         media_state not null default 'pending',
  sha256        text,
  created_at    timestamptz not null default now(),
  stored_at     timestamptz
);
create index on media (state) where state = 'pending';
```

### notification_settings
```sql
create table notification_settings (
  owner_user_id      uuid primary key references users(id) on delete cascade,
  notify_on_delete   boolean not null default true,
  notify_on_edit     boolean not null default false,
  include_media      boolean not null default true,
  quiet_hours        int4range,                     -- e.g. [23,7)
  muted_chat_ids     bigint[] not null default '{}',
  updated_at         timestamptz not null default now()
);
```

### subscriptions
```sql
create table subscriptions (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references users(id) on delete cascade,
  tier            sub_tier not null default 'free',
  status          sub_status not null default 'active',
  provider        text,                              -- 'telegram_stars' | 'stripe' | ...
  provider_ref    text,                              -- charge/subscription id
  retention_days  int not null default 7,            -- free tier caps archive window
  current_period_end timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on subscriptions (owner_user_id, status);
```

### processed_updates (idempotency ledger)
```sql
create table processed_updates (
  update_id     bigint primary key,                  -- Telegram Update.update_id
  processed_at  timestamptz not null default now()
);
```

## RLS sketch

```sql
alter table messages enable row level security;
create policy owner_read on messages
  for select using (
    connection_id in (
      select id from business_connections
      where owner_user_id = auth.uid()  -- or a claim set from validated initData
    )
  );
```

Reads from **miniapp-api** run under the caller's identity (mapped from validated `initData`
→ `users.id`); writes come only from the trusted **ingest-worker** service role.

## Retention

`scheduler` deletes `messages` / `message_versions` / `media` older than
`subscriptions.retention_days` (media blobs purged first → `media.state='purged'`), and honors
user-initiated "delete my data" (legal doc 06).
