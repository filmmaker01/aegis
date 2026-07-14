# Aegis — app

**Aegis** is an **official** Telegram **Business Bot** + **Telegram Mini App** that saves new
messages, records edits, and shows the saved copy after a message-deletion event.

> **Official Telegram surfaces only.** Bot API, Business Connections, Mini Apps.
> **Forbidden:** userbot, Telethon, GramJS-as-user-client, phone-number login, MTProto user
> sessions, or any circumvention of Telegram limits.

This package is the product application. The API research and the raw-payload probe live
alongside it in the repo:

- `../api-probe` — Phase 1 research tool (captures real Telegram Business updates).
- `../docs` — product research (API findings, architecture, DB, legal, roadmap).
- `../.claude/agents` — the Aegis agent team (orchestrated by `aegis-lead`).

## Status: foundation only

Bootstrapped from the **Vibe Coding Template** (Apache-2.0 — see [UPSTREAM.md](UPSTREAM.md)).
What exists now:

- Monorepo: `webapp` (React CSR — the Mini App surface), `website` (Astro), `backend`
  (Bun/Hono + Prisma), `packages/contracts` (shared Zod contracts).
- Aegis Mini App placeholder at route `/aegis` (`webapp/src/features/aegis`).
- Isolated Telegram `initData` verification module (`backend/src/modules/telegram`) with unit
  tests — **not yet wired into routes/auth**.
- Backend `/health` endpoint (ships with the template).

**Deliberately NOT built yet** (see [docs/roadmap.md](docs/roadmap.md)): message database,
media storage, subscriptions, payments, production webhook, and Telegram-based user auth.

## Requirements

- [Bun](https://bun.sh) `1.3.x` (package manager + runtime).
- Docker (only when running the backend against local PostgreSQL — deferred for now).
- Windows/macOS/Linux. Verified on Windows 10 + PowerShell.

## Commands

```bash
bun install                 # install workspaces
bun run --cwd webapp dev    # Mini App dev server (http://localhost:5173)
bun run --cwd webapp build  # build the Mini App
bun run typecheck           # typecheck all workspaces
bun run --cwd webapp lint   # lint the webapp
bun run --cwd webapp test   # webapp unit tests
bun run --cwd backend test:unit   # backend unit tests (incl. telegram/init-data)
```

Full-stack `bun run dev` and backend integration tests need Docker/PostgreSQL — see
[docs/VIBE_TEMPLATE_README.md](docs/VIBE_TEMPLATE_README.md) and `docs/LOCAL_DATABASE.md`.

## Docs

- [Development rules](../CLAUDE.md) (repo-wide) · this app's conventions: [CLAUDE.md](CLAUDE.md)
- [Architecture](docs/architecture.md)
- [Telegram API findings](docs/telegram-api-findings.md)
- [Roadmap](docs/roadmap.md)
- [Security notes](SECURITY.md)
- [Upstream / license](UPSTREAM.md)
