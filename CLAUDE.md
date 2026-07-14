# Aegis — repository development rules

**Aegis** = an **official** Telegram **Business Bot** + **Telegram Mini App** that saves new
messages, records edits, and shows the saved copy after a message-deletion event.

Orchestrate work through the **`aegis-lead`** agent (`.claude/agents/aegis-lead.md`); it routes
to the specialist agents in `.claude/agents/`.

## Non-negotiable constraints
- **Official Telegram surfaces only:** Bot API, Business Connections, Mini Apps.
- **Forbidden:** userbot, Telethon, GramJS-as-user-client, phone-number login, MTProto **user**
  sessions, or any circumvention of Telegram limits. Reject tasks that require these.
- **API-verification gate:** no product code may depend on Telegram behavior that isn't
  confirmed by `api-probe` results. Unconfirmed behavior is marked **НЕ ПОДТВЕРЖДЕНО** and
  routed to `telegram-integration-specialist` + an experiment.
- **Deletion attribution is impossible** (proven by the API): never build features or copy that
  claim to identify *who* deleted a message.

## Repository layout
- `api-probe/` — Phase 1 research tool (raw Telegram payload logger). Standalone; **npm/tsx**.
- `aegis-app/` — the product app (bootstrapped from Vibe, Apache-2.0). **bun** monorepo.
- `docs/` — product research (Telegram findings, architecture, DB, legal, roadmap).
- `.claude/agents/` — the agent team.
- `tooling/` — local upstream checkouts (git-ignored; never mixed into product code).

## Working rules
- **Minimal changes.** Smallest coherent diff; no speculative rewrites or unrequested scope.
- **Tests required.** No feature is done without tests + green lint/typecheck/build.
- **Secrets & PII.** Never log or commit `BOT_TOKEN` / `WEBHOOK_SECRET` / personal message
  content. Only `.env.example` (placeholders) is tracked. gitleaks (`.gitleaks.toml` + CI)
  guards this.
- **Per-package tooling:** `api-probe` uses `npm run …` (see its README); `aegis-app` uses
  `bun run …` (see its README + `aegis-app/CLAUDE.md`).
- Keep a decision log in `aegis-lead.md`; keep `docs/roadmap.md` current.

## Current phase
Foundation complete. Out of scope until API verification + foundation sign-off: message
database, media storage, subscriptions, payments, production webhook, Telegram-based user auth.
