# 08 — Repository structure & project architecture

Monorepo (pnpm + Turborepo). Next.js app on Vercel; long-running workers deployed separately.

```
.
├─ apps/
│  ├─ miniapp/                 # Next.js (App Router) — Mini App UI + miniapp-api routes
│  │  ├─ app/
│  │  │  ├─ (dashboard)/       # Dashboard, Deleted, Edited, Chats, Settings, Subscription
│  │  │  └─ api/               # Route Handlers: validated initData, reads, billing webhooks
│  │  ├─ components/           # React + Tailwind UI
│  │  └─ lib/                  # initData validation, api client, telegram sdk wrapper
│  │
│  ├─ webhook-ingress/         # tiny Node service: verify secret, enqueue to Redis, 200 fast
│  │
│  └─ workers/                 # long-running Node consumers
│     ├─ ingest/               # routing, idempotency, ordering, persistence
│     ├─ media/                # getFile → storage
│     └─ notifier/             # delete/edit notifications to owner
│
├─ packages/
│  ├─ db/                      # Drizzle/Prisma schema (doc 03), migrations, typed client, RLS
│  ├─ telegram/                # Bot API client, update types, initData verify, rights parsing
│  ├─ queue/                   # Redis Streams helpers: consumer groups, locks, rate limiter, DLQ
│  ├─ core/                    # domain logic: reconcilers, version diffing, retention policy
│  ├─ storage/                 # S3/Supabase Storage adapter, signed URLs, envelope encryption
│  ├─ config/                  # env schema (zod), secrets loading
│  └─ shared/                  # types, logging, errors, telemetry
│
├─ infra/
│  ├─ migrations/              # SQL migrations
│  ├─ docker/                  # worker Dockerfiles
│  └─ deploy/                  # Vercel (miniapp) + Fly/Railway (workers) config
│
├─ tools/
│  └─ api-probe/               # Phase-1 experiment harness (E-1…E-6), raw-update logger
│
├─ docs/                       # this research (01…08)
├─ turbo.json
├─ pnpm-workspace.yaml
└─ package.json
```

## Boundaries
- **`webhook-ingress`** is the only public Telegram endpoint; stateless; horizontally scalable.
- **`workers/*`** are the only writers to Postgres/storage (service role). Never on the request path.
- **`apps/miniapp`** only reads (RLS-scoped) + writes user settings/billing; validates initData.
- **`packages/telegram`** centralizes all Bot API knowledge so a Bot API version bump is one place.
- **`packages/queue`** owns idempotency + ordering + rate limiting so every worker inherits it.

## Runtime split (why)
- Next.js (Mini App + read API) → Vercel Fluid Compute, Node runtime (needs Node crypto for HMAC).
- Ingress → small always-warm Node service near Redis.
- Workers → always-on containers (Redis consumer groups); not Vercel functions.
- Postgres/Redis/Storage → managed (Supabase / Upstash / S3-compatible).

## Config / env (validated by `packages/config`)
`BOT_TOKEN`, `WEBHOOK_SECRET`, `DATABASE_URL`, `REDIS_URL`, `STORAGE_*`, `KMS_KEY_ID`,
`APP_ENC_KEY`, `TELEGRAM_API_ROOT` (self-hosted Bot API server optional for large files),
billing provider keys. All required keys fail fast at boot.
```
