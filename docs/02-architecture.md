# 02 — Production Architecture

Stack: TypeScript · Next.js (App Router) · React · Tailwind · Telegram Mini Apps ·
Node.js · PostgreSQL (Supabase) · Redis · S3 / Supabase Storage.

## Design principles derived from research

1. **Store-on-arrival is mandatory.** Deletion events carry no content (Q3), so every
   incoming/outgoing message must be persisted immediately, before any delete can occur.
2. **No deletion attribution.** UI/notifications must not assert *who* deleted (Q4).
3. **Media must be copied to our own storage at arrival** — file references may die with the
   message (E‑4).
4. **Idempotent, at-least-once ingestion.** The webhook path must tolerate duplicates and
   out-of-order updates (Q on transport).
5. **Least privilege at Telegram level.** Request minimal `BusinessBotRights`.

## Services / components

```
                          ┌────────────────────────────────────────────┐
   Telegram Bot API  ──▶  │  (1) webhook-ingress  (Next.js route/Node)   │
   (business_* updates)   │   - verify X-Telegram-Bot-Api-Secret-Token   │
                          │   - minimal validation, enqueue raw update   │
                          └───────────────┬──────────────────────────────┘
                                          │ push raw update (Redis Stream)
                                          ▼
                          ┌────────────────────────────────────────────┐
                          │  (2) ingest-worker (Node consumer group)    │
                          │   - idempotency (update_id dedupe)          │
                          │   - route by update type                    │
                          │   - persist message / version / delete event │
                          │   - enqueue media download + notification   │
                          └───────┬───────────────┬─────────────────────┘
                                  │               │
                 media job ▼      │               ▼ notify job
        ┌───────────────────────┐ │   ┌──────────────────────────────┐
        │ (3) media-worker      │ │   │ (4) notifier-worker          │
        │  getFile → download   │ │   │  sendMessage to owner with   │
        │  → S3/Supabase Storage│ │   │  saved content of deleted msg│
        └───────────┬───────────┘ │   └──────────────────────────────┘
                    │             │
                    ▼             ▼
        ┌──────────────────────────────────────────────────────────┐
        │  PostgreSQL (Supabase)     Redis          S3 / Storage    │
        │  system of record          queues/locks   media blobs     │
        └──────────────────────────────────────────────────────────┘
                    ▲
                    │ RLS-scoped reads
        ┌───────────┴───────────────────────────────────────────────┐
        │ (5) miniapp-api (Next.js Route Handlers / tRPC)            │
        │  - validates Telegram initData (HMAC)                      │
        │  - serves dashboard/deleted/edited/chats/settings/billing  │
        └───────────┬───────────────────────────────────────────────┘
                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │ (6) Telegram Mini App (Next.js + React + Tailwind)        │
        └──────────────────────────────────────────────────────────┘

        (7) billing-service  — Telegram Stars / provider payments, subscription state
        (8) scheduler        — retention/GDPR purges, media GC, connection health checks
```

### Service responsibilities

- **(1) webhook-ingress** — the *only* public Telegram endpoint. Verifies the secret token,
  does O(1) work: enqueue the raw update onto a Redis Stream keyed by
  `business_connection_id` (to preserve per-connection order), returns `200` fast. Never does
  DB writes or media downloads inline (webhook must ack within Telegram's timeout).
- **(2) ingest-worker** — the brain. Redis consumer group; **per-connection ordered**
  processing via stream key + a short Redis lock per `(connection, chat)`. Applies
  idempotency, writes to Postgres, spawns media + notification jobs. Horizontally scalable
  (one partition per connection).
- **(3) media-worker** — resolves `getFile`, downloads within Telegram's file window, streams
  to S3/Supabase Storage, records `media` row + checksum. Retries with backoff; marks
  `media.state = unavailable` if the file already died (proves E‑4 in prod telemetry).
- **(4) notifier-worker** — on a delete event, composes the "message deleted" notification to
  the owner using the **saved** content, respecting `notification_settings`. Rate-limited.
- **(5) miniapp-api** — authenticated read/config API for the Mini App. Validates `initData`
  on every request; all queries scoped to the caller's `user_id` (defense in depth over RLS).
- **(6) Mini App** — the UI (see doc 05).
- **(7) billing-service** — subscription lifecycle; gates retention length / feature access.
- **(8) scheduler** — cron (Supabase cron / a Node cron): data retention purges, media GC for
  orphaned blobs, `business_connection` health re-check, re-`setWebhook` guard.

## Data flow (happy path, a deleted message)

1. Partner sends "see you at 8" → Telegram → `business_message` → **ingress** → Redis Stream.
2. **ingest-worker** upserts `chats`, inserts `messages` (+ first `message_versions` row),
   enqueues media job if any.
3. Partner deletes for everyone → `deleted_business_messages` (only `message_ids`) → ingress → stream.
4. **ingest-worker** finds the stored `messages` rows by `(connection, chat, tg_message_id)`,
   writes a `deleted_events` row (deletion_time = now, initiator = `unknown`), flips
   `messages.is_deleted = true`, enqueues a notify job.
5. **notifier-worker** sends the owner: *"A message in your chat with X was deleted:"* + saved
   text/media reference.
6. Owner opens Mini App → **miniapp-api** → "Deleted" screen shows the archived content.

## Why Redis (not just Postgres)

- **Ordering + backpressure:** Streams give per-connection FIFO and replay.
- **Idempotency & locks:** `SETNX update:{update_id}` dedupe; per-chat processing lock.
- **Rate limiting:** notifier + Telegram API 429 budget per bot token.
- **Ephemeral cache:** initData validation, connection→user lookups.

## Deployment notes

- Next.js app (Mini App + miniapp-api) on Vercel (Fluid Compute; Node runtime for HMAC crypto).
- Workers (ingest/media/notifier) as long-running Node services (Fly.io / Railway / a VM) —
  Vercel functions are not ideal for always-on Redis consumers; keep them off the request path.
- Single Postgres (Supabase) as system of record; Redis (Upstash/managed); S3-compatible store.
