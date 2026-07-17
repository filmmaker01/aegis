# Task planner — app

An **official** Telegram **Bot** for personal task planning: create a task, choose when to be
reminded, and act on the reminder (done / snooze / reschedule) from inline buttons.

> The directory is still named `aegis-app` for historical reasons: this app previously hosted
> **Aegis**, a Business Bot that archived messages and showed the saved copy after deletion. That
> product was retired — its module, tables, media pipeline and Mini App screens are gone.

> **Official Telegram surfaces only.** Bot API (and Mini Apps, if one is added back).
> **Forbidden:** userbot, Telethon, GramJS-as-user-client, phone-number login, MTProto user
> sessions, or any circumvention of Telegram limits.

## Status: planner MVP

Bootstrapped from the **Vibe Coding Template** (Apache-2.0 — see [UPSTREAM.md](UPSTREAM.md)).
What exists now:

- Monorepo: `backend` (Bun/Hono + Prisma — the bot), `webapp` (React CSR), `website` (Astro),
  `packages/contracts` (shared Zod contracts).
- The bot: `backend/src/modules/tasks` (`domain` schedule maths · `application` ports + reminder
  dispatcher · `infrastructure` Prisma/in-memory repos + conversation service · `notification`
  cards and keyboards). The Bot API surface sits behind `modules/telegram`'s public `index.ts`.
- Webhook ingress at `POST /telegram/webhook`, secret-token verified, idempotent per `update_id`.
- Reminder delivery: in-process ticker (`REMINDER_SWEEP_SECONDS`, default 30s), plus a
  `reminders:dispatch` cron task. Claims are atomic, so a reminder is never sent twice.

Commands: `/start` `/new` `/tasks` `/today` `/settings` `/cancel`. All copy is Russian; instants
are stored in UTC and rendered in the user's timezone (picked at `/start`).

## ⚠️ Two required cutover steps

**1. Re-register the webhook.** The bot's live registration still carries the Business-era
`allowed_updates` (`callback_query` + the four `business_*`). **`message` is not in it**, so on the
current registration the planner receives no commands at all — `/start` never arrives and the bot
looks dead. Buttons would work; nothing else would.

```bash
bun run --cwd backend webhook-info                                     # read-only: shows the problem
bun run --cwd backend set-webhook -- --url https://<host>/telegram/webhook --drop-pending
```

**2. Apply the migration.** `20260717000000_tasks_replace_archive` has not been run against
production. It does **not** drop the archive tables — it moves them to the `retired_aegis` schema,
so it is reversible. See that migration's `README.md` and `rollback.sql`.

**Not built** (see [docs/roadmap.md](docs/roadmap.md)): recurring tasks, a Mini App UI,
subscriptions, payments.

## Requirements

- [Bun](https://bun.sh) `1.3.x` (package manager + runtime).
- Docker (only when running the backend against local PostgreSQL — deferred for now).
- Windows/macOS/Linux. Verified on Windows 10 + PowerShell.

## Commands

```bash
bun install                 # install workspaces
bun run --cwd backend dev   # bot backend (webhook + reminder ticker)
bun run typecheck           # typecheck all workspaces
bun run architecture:check  # module/layer boundary check
bun run --cwd backend test:unit     # backend unit tests (the bot)
bun run --cwd backend test:pg:local # boots a throwaway real Postgres, migrates, runs repo tests
bun run --cwd backend test:pg       # repository tests against your own DATABASE_URL
bun run --cwd backend webhook-info  # read-only: what Telegram currently sends us
bun run --cwd webapp test   # webapp unit tests
bun run --cwd webapp lint   # lint the webapp
```

Local dev without Postgres: set `TASKS_STORE=memory` (tasks are lost on restart; rejected in
production).

Full-stack `bun run dev` and backend integration tests need Docker/PostgreSQL — see
[docs/VIBE_TEMPLATE_README.md](docs/VIBE_TEMPLATE_README.md) and `docs/LOCAL_DATABASE.md`.

## Docs

- [Development rules](../CLAUDE.md) (repo-wide) · this app's conventions: [CLAUDE.md](CLAUDE.md)
- [Roadmap](docs/roadmap.md) — current state + what the retired product left behind
- ⚠️ `docs/aegis-architecture.md`, `docs/notification-ux.md`, `docs/telegram-api-findings.md`,
  `docs/media-storage-production.md` describe the **retired** archive product and are stale.
- [Security notes](SECURITY.md)
- [Upstream / license](UPSTREAM.md)
