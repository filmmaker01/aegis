# Telegram task planner bot

An **official-API-only** Telegram bot for personal task planning: create a task, pick when to be
reminded, and get a reminder with one-tap "done" / "snooze" actions.

Repurposed from an earlier "deleted messages archive" product (Aegis). The archive functionality
and its tables were removed in favour of the planner; the surviving foundation — Bot API client,
webhook ingress with `update_id` idempotency, HTML/keyboard rendering, Prisma/Postgres, auth —
was reused as-is.

## Product

- **Main menu:** ➕ Создать задачу · 📋 Мои задачи
- **Create:** title → when (30 мин / 1 час / сегодня вечером / завтра утром / 📅 другая дата /
  без напоминания) → confirm
- **Task actions:** ✅ Выполнено · ⏰ Перенести · ✏️ Изменить · 🗑 Удалить
- **Reminder actions:** ✅ Выполнено · ⏱ 15 минут · ⏱ 1 час · 📅 Перенести
- **Commands:** `/start` `/new` `/tasks` `/today` `/settings` `/cancel`

All user-facing copy is Russian. Times are stored in UTC and rendered in the user's timezone,
which is chosen at `/start` and changeable via `/settings`.

## Deployment

One VPS, Docker Compose: bot + PostgreSQL 17 + Caddy + a daily backup. No managed
database, no provider SDK. Postgres publishes no port and lives on a network
marked `internal: true`; migrations run as a one-shot service the bot waits on.

Runbook: **[`deploy/README.md`](deploy/README.md)**.

## Layout

- `aegis-app/` — the product app (bootstrapped from Vibe, Apache-2.0). **bun** monorepo.
  The bot lives in `aegis-app/backend/src/modules/tasks`.
- `api-probe/` — Phase 1 research tool (raw Telegram payload logger). Standalone; **npm/tsx**.
  Retained from the previous product; not used by the planner.
- `docs/` — research and architecture notes. **Mostly describes the previous (archive) product
  and is stale.**
- `.claude/agents/` — the agent team.

## Status

Planner MVP implemented: schema + migration, bot conversation flow, reminder dispatch with
at-most-once delivery, 164 backend unit tests green.

The `20260717000000_tasks_replace_archive` migration **drops the archive tables** and has not been
applied to production. Review it before running `prisma migrate deploy`.
