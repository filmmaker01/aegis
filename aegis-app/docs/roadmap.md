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

## Phase 2 — MVP
- Wire `initData` verifier into a Mini App auth middleware.
- Backend webhook ingress (secret-token verified) + idempotent ingestion.
- Minimal message archive + deletion notification with saved content.
- Mini App: Dashboard + Deleted screens.

## Phase 3 — Beta
- Edited history, Chats/Settings/Subscription screens, billing, retention, legal review.
- Re-run `bun audit`; clear advisories on production paths.

## Phase 4 — Production
- Scale ingest/media/notifier, DR, compliance ops, monitoring.

## Not in the foundation (do not build yet)
Message database, media storage, subscriptions, payments, production webhook, Telegram-based
user auth.
