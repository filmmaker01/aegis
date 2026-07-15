# Aegis — production deployment

Moves Aegis off the local portable Postgres, temporary Cloudflare tunnel, and local disk to
permanent infrastructure: **managed Supabase Postgres + Supabase Storage** and an **always-on
backend** with a permanent HTTPS URL. (Template's generic guide: `DEPLOYMENT.md`.)

> **Do not touch the existing Banana Studio project.** Everything below uses a **separate**
> Supabase project, database, bucket, and keys created specifically for Aegis.

## Architecture

```
Telegram ──webhook──▶  Backend (always-on Docker: Railway/Fly)  ──▶ Supabase Postgres (archive)
                        │  in-process media worker  ──getFile──▶     Supabase Storage (private bucket)
Mini App (Vercel, static) ──initData API──▶ Backend
```

- **Backend**: one always-on container (webhook + in-process media worker + retries).
- **Postgres**: Supabase — pooled URL at runtime, direct URL for migrations, TLS.
- **Storage**: Supabase Storage, **private** bucket, via the S3-compatible adapter; all media
  I/O goes through the backend. Service/S3 keys live only in the backend host.
- **Mini App**: static, deployed separately (Vercel), no secrets.

---

## STOP POINT — what you do in web UIs (I can't create accounts or handle secrets)

Do these, then paste the **non-secret** value back to me (the permanent backend URL). Put all
**secret** values only into the deploy host's secret manager — never into chat, terminal, or git.

### 1. Supabase project (separate from Banana Studio)
1. https://supabase.com → **New project** → name `aegis` (a NEW project, not Banana Studio).
   Pick a region and a strong DB password.
2. **Project Settings → Database → Connection string**:
   - **Session pooler** URI → `DATABASE_URL` (ensure `?sslmode=require`).
   - **Direct connection** URI → `DIRECT_URL`.
3. **Storage → New bucket** → name `aegis-media`, **Public = OFF** (private).
4. **Storage → S3 Connection** → create **Access keys** → gives `SPACES_ACCESS_KEY_ID` +
   `SPACES_SECRET_ACCESS_KEY`, the **endpoint** (`https://<ref>.supabase.co/storage/v1/s3`),
   and a **region**.

### 2. Backend host — Railway (recommended) or Fly.io
**Railway:** https://railway.app → New Project → **Deploy from GitHub repo** (push this repo
first) → set **Root Directory** to `aegis-app` → it builds `backend/Dockerfile`. In **Variables**,
paste everything from [`backend/.env.production.example`](../backend/.env.production.example)
with real values. Railway gives a permanent `https://<app>.up.railway.app` URL.

**Fly.io (alt):** `fly launch --config aegis-app/fly.toml --no-deploy`, then
`fly secrets set DATABASE_URL=... DIRECT_URL=... TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=...
SPACES_...=... JWT_SECRET=... CORS_ORIGINS=...`, then `fly deploy`.

On first boot the container runs `prisma migrate deploy` automatically (creates all tables +
`uuidv7()`), then serves.

### 3. Mini App (Vercel)
https://vercel.com → New Project → import repo → **Root Directory** `aegis-app/webapp` →
framework **Vite** → set env `VITE_API_URL=https://<your-backend-url>` → Deploy. Put the
resulting URL into the backend's `CORS_ORIGINS`.

### 4. Give me the backend URL
Paste the permanent backend URL (not a secret). I will re-register the Telegram webhook to
`<backend-url>/telegram/webhook` and run the production live e2e.

---

## Migrations
`prisma migrate deploy` runs on container start (`start:prod`). To run manually:
```bash
cd aegis-app/backend
DIRECT_URL="<supabase direct url>" bun run prisma:deploy
```
Migrations use `DIRECT_URL` (a pooler can't run migration DDL). Runtime uses `DATABASE_URL`.

## Health / readiness
- `GET /health` — liveness (no deps); platform health check.
- `GET /ready` — DB ping + error metrics; `503` if the DB is unreachable.

## Monitoring
`/ready` returns counters: `webhookErrors`, `mediaFailures`, `notifyFailures`, `lastErrorAt`.
Logs are structured and safe (`[ingest]/[media]/[notify]/[fetch-conn]` — no bytes, tokens, or
PII). Set `SENTRY_DSN` to wire an external tracker later. Also watch `getWebhookInfo`
(`last_error`, `pending_update_count`).

## Backups & rollback
- **Database:** Supabase takes automatic daily backups; enable **PITR** on a paid plan for
  point-in-time restore. Restore from the Supabase dashboard.
- **Media:** Supabase Storage is durable; objects private. (Optional: bucket versioning.)
- **Rollback (app):** Railway/Fly keep previous releases — redeploy the prior image
  (`fly releases` / Railway → Deployments → Redeploy). Migrations are **forward-only**; roll
  back code only. A schema change that must be reverted needs a new forward migration, so keep
  schema changes backward-compatible with the previous deploy.
- **Secrets rotation:** rotate `TELEGRAM_WEBHOOK_SECRET` / DB password / S3 keys in the host +
  Supabase; re-run `setWebhook` after changing the webhook secret.

## Security checklist
- Bucket **private**; media served only through the backend.
- Service/S3 keys + DB URLs live **only** in the host secret manager — never in git, logs, or
  the frontend. Only `*.example` placeholder templates are committed.
- Production env validation fails fast on `ARCHIVE_STORE=memory`, `MEDIA_STORAGE=local`,
  missing Telegram secrets, or a non-TLS `DATABASE_URL`.
- Webhook verifies `X-Telegram-Bot-Api-Secret-Token`; Mini App API verifies `initData` HMAC.
