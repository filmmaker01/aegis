# Aegis — architecture (app level)

> The template's own module architecture is in [ARCHITECTURE.md](ARCHITECTURE.md).
> The full **product** architecture (services, data flow, queues, storage) is in the
> repo-level research: [`../../docs/02-architecture.md`](../../docs/02-architecture.md).
> This file records how the **app** is structured today and where product pieces will land.

## Surfaces (from the Vibe template)
- **`webapp`** — React CSR. This is the **Telegram Mini App** surface (behind-login, no SEO).
  Aegis placeholder: `src/features/aegis`, route `/aegis`.
- **`backend`** — Bun + Hono + Prisma. Hexagonal modules under `src/modules/*`
  (`domain` / `application` / `infrastructure` / `transport`). Hosts `/health`; will host the
  webhook ingress + initData-authenticated Mini App API.
- **`website`** — Astro SSG. Public/marketing pages (deferred for Aegis).
- **`packages/contracts`** — shared Zod contracts between webapp and backend.

## Telegram building blocks present now
- `backend/src/modules/telegram/init-data.ts` — pure `initData` HMAC verification (no DB, no
  routes). Wire into a Mini App auth middleware when that phase starts.
- `webapp/src/features/aegis/telegram.ts` — safe reader of `window.Telegram.WebApp` (UI only).

## Planned mapping to the product architecture
| Product service (research doc 02) | Where it will live here |
|---|---|
| webhook-ingress | `backend` route (`/telegram/webhook`), verifies secret token |
| ingest / media / notifier workers | `backend` worker entrypoints (`src/worker.ts` pattern) |
| miniapp-api | `backend` module, guarded by initData verification |
| Mini App UI | `webapp` (`src/features/aegis/*`) |
| system of record / cache / storage | Postgres (Prisma) · Redis · S3 — **deferred** |

## Constraints (non-negotiable)
- Official Telegram surfaces only (Bot API / Business Connections / Mini Apps).
- Store-on-arrival is mandatory — deletion events carry no content.
- Deletion attribution is impossible; UI must not claim who deleted a message.
- Keep the template's hexagonal boundaries; no business rules in routes/UI.
