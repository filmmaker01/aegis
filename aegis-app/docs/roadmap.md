# Aegis — roadmap (app)

Mirrors the product roadmap ([`../../docs/07-roadmap.md`](../../docs/07-roadmap.md)) and tracks
where the **app** is. Current position: **end of foundation setup**.

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

Remaining before Phase 2 is "done":
- ⏳ Media archival worker (download `getFile` → storage) — schema/ports exist, worker TBD.
- ⏳ Formal Prisma migrations (currently `db push`) + managed Postgres for production.
- ⏳ Notification polish (quiet hours, batching, mute per chat); optional edit notifications.

## Phase 3 — Beta
- Edited history, Chats/Settings/Subscription screens, billing, retention, legal review.
- Re-run `bun audit`; clear advisories on production paths.

## Phase 4 — Production
- Scale ingest/media/notifier, DR, compliance ops, monitoring.

## Not in the foundation (do not build yet)
Message database, media storage, subscriptions, payments, production webhook, Telegram-based
user auth.
