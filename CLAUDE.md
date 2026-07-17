# Telegram task planner — repository development rules

The product is an **official** Telegram **Bot** for personal task planning: create a task, choose
when to be reminded, and act on the reminder (done / snooze / reschedule) from inline buttons.

This repository previously hosted **Aegis**, a Business Bot that archived messages and showed the
saved copy after deletion. That product was retired: its module, tables, media pipeline and Mini
App screens are gone. Directory names (`aegis-app/`, `api-probe/`) still carry the old name.

Orchestrate work through the **`aegis-lead`** agent (`.claude/agents/aegis-lead.md`); it routes
to the specialist agents in `.claude/agents/`. **Note:** that agent's brief still describes the
retired archive product and needs rewriting.

## Non-negotiable constraints
- **Official Telegram surfaces only:** Bot API (and Mini Apps, if one is ever added back).
- **Forbidden:** userbot, Telethon, GramJS-as-user-client, phone-number login, MTProto **user**
  sessions, or any circumvention of Telegram limits. Reject tasks that require these.
- **Users only ever touch their own tasks.** Every id arriving in `callback_data` is resolved
  owner-scoped (`getTaskForUser(id, from.id)`); a foreign or unknown id gets a neutral
  «Недоступно» and nothing else happens, so ids stay non-enumerable.
- **Reminders are never delivered twice.** Delivery runs an explicit state machine
  (`pending → processing → sent | retry | failed`). The claim transitions the row in the SAME
  statement that selects it (`FOR UPDATE SKIP LOCKED`), so concurrent sweeps cannot both take one.
  A crashed sweep's `processing` rows are returned to `retry` by the reaper after
  `REMINDER_STALLED_AFTER_SECONDS`, so a crash delays a reminder instead of losing it.
  Permanent Telegram errors (bot blocked, chat gone) go straight to `failed` — never retried.
- **All instants are stored in UTC.** A timezone is applied only when resolving a wall-clock
  intent («сегодня вечером») or rendering. That logic lives in `tasks/domain/schedule.ts`.

## Product surface
- Main menu: ➕ Создать задачу · 📋 Мои задачи
- Commands — **exactly these**: `/start` `/new` `/tasks` `/today` `/settings` `/cancel`
- All user-facing copy is **Russian**.
- Prefer inline buttons and **edit the existing message** rather than sending a new one.

## Repository layout
- `aegis-app/` — the product app (bootstrapped from Vibe, Apache-2.0). **bun** monorepo.
  The bot lives in `aegis-app/backend/src/modules/tasks` (domain / application / infrastructure /
  notification), with the Bot API surface behind `modules/telegram`'s public `index.ts`.
- `api-probe/` — Phase 1 research tool from the retired product. Standalone; **npm/tsx**. Unused.
- `docs/` — research notes. **Largely stale: describes the retired archive product.**
- `.claude/agents/` — the agent team.
- `tooling/` — local upstream checkouts (git-ignored; never mixed into product code).

## Working rules
- **Minimal changes.** Smallest coherent diff; no speculative rewrites or unrequested scope.
- **Tests required.** No feature is done without tests + green typecheck/build.
- **Architecture boundaries.** Run `bun run architecture:check`; cross-module imports go through
  the target module's `index.ts`, and `domain`/`application` never import infrastructure or env.
- **Secrets & PII.** Never log or commit `BOT_TOKEN` / `WEBHOOK_SECRET` / task titles / user ids.
  Only `.env.example` (placeholders) is tracked. gitleaks (`.gitleaks.toml` + CI) guards this.
- **Per-package tooling:** `api-probe` uses `npm run …`; `aegis-app` uses `bun run …` (see its
  README + `aegis-app/CLAUDE.md`).
- **Migrations are generated, never hand-written** (`prisma migrate dev`, or `prisma migrate diff`
  from two schemas when no database is reachable).

## Current phase
Planner MVP implemented, unit-tested, and verified against a real PostgreSQL.

Two cutover steps are outstanding, both documented in `aegis-app/README.md`:
1. **`setWebhook` must be re-run** (`bun run --cwd backend set-webhook`). The live registration
   lacks `message`, so the bot currently cannot receive a single command.
2. **The migration has not been applied.** It moves the archive tables to `retired_aegis` rather
   than dropping them, so it is reversible (`rollback.sql` sits next to it).

Out of scope: subscriptions, payments, recurring tasks, a Mini App UI.
