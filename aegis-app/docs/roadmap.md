# Roadmap (app)

## Current product: Telegram task planner

The repository was **repurposed** from Aegis (a Business Bot archiving deleted messages) into a
personal **task planner bot**. Everything under "Retired product — Aegis" below is history: that
code, its tables, its media pipeline and its Mini App screens no longer exist.

### Done — planner MVP
- ✅ **Schema + migration** (`20260717000000_tasks_replace_archive`): `bot_users`, `tasks`,
  `task_drafts` (+ RLS, deny-by-default). Drops all archive tables. Instants stored in UTC.
- ✅ **Bot conversation** (`backend/src/modules/tasks`): `/start` timezone onboarding, create
  wizard (title → slot → confirm), task list/detail, done / snooze / edit / delete, `/today`.
  Cards are edited in place; every task id is resolved owner-scoped (anti-enumeration).
- ✅ **Reminders**: in-process ticker (`REMINDER_SWEEP_SECONDS`, default 30s) + a
  `reminders:dispatch` cron task as a safety net. Atomic claim before send ⇒ never delivered
  twice; a failed send is released and retried.
- ✅ **Timezones**: chosen at `/start`, changeable via `/settings`; wall-clock slots resolved via
  Intl (DST-correct), no new dependency.
- ✅ **Reused** from Aegis: webhook ingress + `update_id` idempotency, Bot API client, HTML
  escaping / length limits / `callback_data` codec, the owner-check callback pattern, module
  layering.
- ✅ **Tested**: 164 backend unit tests + 37 webapp; typecheck and `architecture:check` green
  (the latter went from 21 pre-existing violations to 0).

### Next
- ⚠️ **Apply the migration.** `20260717000000_tasks_replace_archive` **drops the archive tables**
  and has NOT been run against production Supabase. Review, back up, then `prisma migrate deploy`.
- Set the production webhook to `/telegram/webhook` and verify `setMyCommands` published the list.
- Integration test against real Postgres: `bun run --cwd backend test:pg`.
- Doc drift: `aegis-architecture.md`, `notification-ux.md`, `telegram-api-findings.md`,
  `media-storage-production.md`, `../../docs/*` and `.claude/agents/aegis-lead.md` still describe
  the retired product.
- Not planned yet: recurring tasks, a Mini App UI, subscriptions/payments.

---

# Retired product — Aegis (history)

> Kept for context only. None of the code described below remains in the tree.

Mirrored the product roadmap ([`../../docs/07-roadmap.md`](../../docs/07-roadmap.md)).

## Phase 0 — Foundation ✅ (this stage)
- Research tool (`api-probe`) fixed and runnable.
- Agent team installed; `aegis-lead` orchestrator in place.
- `aegis-app` bootstrapped from Vibe; clean install/lint/typecheck/build/dev on Windows.
- Aegis Mini App placeholder; isolated `initData` verifier + tests; `/health` present.
- Secret handling rules + gitleaks; dependency audit baseline recorded.

## Phase 1 — Technical prototype (next)
- Run `api-probe` experiments E-1…E-10 with a real Business-Mode bot + Premium account.
- Record real payloads; confirm/deny H1–H4; update findings docs.
- **Gate:** decide go/no-go for "catch deletions + show saved content".

## Phase 2 — MVP (in progress)
Done:
- ✅ `initData` verifier wired into a Mini App auth middleware (`/api/archive/*`).
- ✅ Webhook ingress (secret-token verified) + idempotent, order-tolerant ingestion
  (update_id claim, natural-key upserts, tombstone-first reconciliation).
- ✅ Message archive (Prisma schema + Prisma repo + in-memory repo) with edit versioning.
- ✅ Deletion notification with saved content (TelegramNotifier via Bot API sendMessage).
- ✅ Mini App: Dashboard (overview counts) + Deleted (saved content) screens + API client.
- ✅ Tested: 49 backend + 38 webapp tests; typecheck/lint/build green.

Done (continued):
- ✅ **Live e2e** against the bot: text deleted "for everyone" → owner received the DM with the
  saved copy (self-heal via `getBusinessConnection`). Evidence: `../../docs/live-mvp-e2e.md`.
- ✅ **PostgreSQL persistence**: Prisma repo integration-tested against real Postgres (5 tests,
  `bun run test:pg`); backend switched to `ARCHIVE_STORE=postgres`; durability verified
  (data survives a full backend restart). See `local-postgres.md`.

Done (continued):
- ✅ **Media archival worker**: download-on-arrival via `getFile` (checksum, max-size cap,
  retry, idempotency), local-disk + S3 storage; deletion re-sends the saved copy via
  sendPhoto/sendVoice/sendVideo/sendDocument to the owner's `user_chat_id`, honest text
  fallback. **Live e2e passed** for photo/voice/video/document — see `../../docs/live-media-e2e.md`.
  Production S3/Supabase config: `media-storage-production.md`.
- ✅ Connection self-heal (`getBusinessConnection`) in all handlers (fixed a Postgres-only 500).

Done (continued):
- ✅ **Formal Prisma migrations** (squashed init: `uuidv7()` + all tables), verified via
  `migrate deploy` on a clean DB; `directUrl` for pooled setups. Replaces `db push`.
- ✅ **Production config**: fail-fast env validation (no memory/local/non-TLS in prod),
  `.env.production.example` (Supabase pooled + direct + Storage), `/health` + `/ready` (DB ping
  + error metrics), `start:prod` (migrate deploy → serve), Dockerfile + `fly.toml`.
- ✅ **Deployment guide**: `aegis-deployment.md` (Supabase project/bucket/keys, Railway/Fly,
  Vercel Mini App, backups/PITR, rollback, security).

Done (continued):
- ✅ **Owner notification UX in the bot chat** (the primary surface): Russian HTML cards with inline
  buttons (Restore / History / Open archive), edit notifications (before/after), bulk deletes grouped
  into one batch card, and a security-critical callback service (owner-only, anti-enumeration, safe
  repeat-Restore). Per-connection settings (notifyDeletions/Edits/Media, groupBatches, mutedChats),
  all-on by default. See `notification-ux.md`. ⚠️ The `notification_settings` Prisma **migration is
  pending** — `migrate dev` is blocked by the RLS migration's `_prisma_migrations` line failing in the
  shadow DB; generate it once that's fixed.

## Phase 3 — Production deploy (in progress)
Prepared and awaiting the user's web-UI actions (create Supabase project/bucket/keys, deploy
backend host + Mini App). Then: re-register webhook to the permanent URL and run the production
live e2e (text/photo/voice + persistence across restart).

Remaining:
- ⏳ Execute the deploy (user creates Supabase + host; I re-register webhook + run e2e).
- ⏳ Media retention/GC (delete bucket object with the row); background sweeper for pending media.
- ✅ Notification polish: batching, mute per chat, edit notifications (done — see `notification-ux.md`).
- ⏳ Generate + apply the `notification_settings` migration (blocked on the RLS/shadow-DB defect).
- ⏳ Notification polish (remaining): quiet hours; Mini App settings UI; in-place history edit.

## Phase 3 — Beta
- Edited history, Chats/Settings/Subscription screens, billing, retention, legal review.
- Re-run `bun audit`; clear advisories on production paths.

## Phase 4 — Production
- Scale ingest/media/notifier, DR, compliance ops, monitoring.

## Not in the foundation (do not build yet)
Message database, media storage, subscriptions, payments, production webhook, Telegram-based
user auth.
