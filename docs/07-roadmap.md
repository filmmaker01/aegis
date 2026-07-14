# 07 — Roadmap

## Phase 1 — Technical Prototype
**Goal: prove the Telegram mechanics before building product.** Run experiments E‑1…E‑6 (doc 01).

Tasks
- Minimal bot: `setWebhook` with the four business `allowed_updates` + secret token.
- Log raw `business_connection / business_message / edited_business_message /
  deleted_business_messages` to a table. No UI.
- Two real test accounts (owner + partner, owner needs Telegram Premium).
- Execute E‑1…E‑6; record exact payloads; write findings back into doc 01.

Risks
- E‑2/E‑4 could invalidate core value (partner "delete for me" invisible; files die on delete).
- Owner must be Premium; business features region/rollout differences.

Done when
- Every research question in doc 01 is answered with real payloads (confirmed / disproven).
- We have a written verdict: is "catch deletions + show content + archive media" actually
  deliverable? Go/no-go gate.

## Phase 2 — MVP
**Goal: one owner can connect, get delete notifications with saved content, browse a basic archive.**

Tasks
- ingress + ingest-worker with idempotency, per-connection ordering, tombstone reconciliation.
- Postgres schema (doc 03) + Redis; media-worker → storage.
- notifier-worker: delete notifications with saved content.
- Mini App: Dashboard + Deleted screen; initData validation; onboarding/connect flow.
- App-level encryption of message content; basic retention purge.

Risks
- Ordering/idempotency bugs → wrong/duplicate notifications.
- Media download window (E‑4) failures → "unavailable" placeholders.
- Getting the honesty/labeling right to avoid over-promising (Q4).

Done when
- End-to-end: connect → partner deletes → owner gets notification with saved text/media →
  visible in Mini App. Stable for a handful of pilot users. Idempotent under duplicate/replayed
  updates (tested).

## Phase 3 — Beta
**Goal: multi-user, paid, hardened, legally reviewed.**

Tasks
- Edited screen + full version history; Chats + Settings + Subscription screens.
- Billing (Telegram Stars + card provider); tiers + retention enforcement.
- Data export + "delete my data"; GDPR/DSAR workflow; DPAs with Supabase/S3.
- Observability: metrics, DLQ alerts, rate-limit dashboards; load test.
- **Completed external legal review** for target markets (doc 06). Positioning finalized.

Risks
- Legal/platform-policy pushback (third-party data, ToS). Could force feature/market changes.
- Scale: many connections → webhook/worker throughput, Telegram 429s.
- Billing/refund/abuse handling.

Done when
- Paying beta cohort; SLA for notification latency; documented legal position & privacy policy;
  no P0 data/security issues open; retention + deletion verified against backups.

## Phase 4 — Production
**Goal: scale, reliability, compliance operations.**

Tasks
- Autoscaling ingest/media/notifier; multi-region storage; DR runbook + tested restores.
- SOC2-style controls, audit logging, key rotation, incident response.
- Anti-abuse, fraud/chargeback handling, support tooling.
- Jurisdiction gating; per-region retention policies; periodic re-verification of Telegram
  API behavior (business features change — re-run E‑tests on major Bot API bumps).

Risks
- Telegram changes business-bot semantics (breaking) → continuous monitoring of changelog.
- Regulatory action in strict-consent markets.

Done when
- Meets availability/latency SLOs; passes a security + privacy audit; documented, monitored,
  on-call; sustainable unit economics.
