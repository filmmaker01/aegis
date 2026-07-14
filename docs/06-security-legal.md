# 06 — Security & Legal

## Security requirements

### initData validation (Telegram Mini App auth)
- Compute the HMAC-SHA256 per Telegram's spec: `secret_key = HMAC_SHA256("WebAppData", bot_token)`,
  then verify `hash` over the sorted `data_check_string`. Reject on mismatch.
- Enforce `auth_date` freshness (e.g. reject if older than 15 min) to stop replay.
- Do this **server-side on every request**, not once at load. Map `initData.user.id` → our
  `users.id`; ignore any client-supplied identity.
- For long sessions, issue our own short-lived signed JWT after initData validation; refresh
  by re-validating initData.

### Webhook protection
- Secret token via `setWebhook(secret_token=…)`, verified on the `X-Telegram-Bot-Api-Secret-Token`
  header. Optionally allowlist Telegram's published IP ranges at the edge.
- HTTPS only; HSTS; reject non-POST; body size limit; per-IP rate limit at the edge.
- The webhook does no privileged DB work inline — a forged request that passes the secret can
  at most enqueue a malformed update, which the worker validates/discards.

### Encryption
- **In transit:** TLS 1.2+ everywhere (client↔app, app↔Postgres/Redis/S3).
- **At rest:** DB encryption (Supabase/managed), encrypted S3 buckets. Consider
  **application-level encryption** of `messages.current_text`, `message_versions.text/raw`,
  and media blobs with a per-user data key (envelope encryption; KMS-held master key). This
  limits blast radius: a DB dump alone doesn't expose message content.
- Secrets (bot token, service keys) in a secret manager, never in code/env files committed.

### Message storage hardening
- Least-privilege DB roles: ingest-worker writes, miniapp-api reads via RLS, no shared
  superuser in app code.
- Media in private buckets; access only via short-lived signed URLs bound to the authenticated
  owner.
- Full audit log of admin/data-export/data-deletion actions.

### Data deletion
- User "delete all my data" → hard-purge `messages`, `message_versions`, `media` (blobs first),
  `deleted_events`, `chats`; keep minimal billing records as legally required.
- On `business_connection` revoke → stop ingest, start a retention countdown, then purge.
- Retention limits by plan enforced by `scheduler` (doc 03).

### Backups
- Automated encrypted Postgres backups (PITR), encrypted at rest, access-controlled, tested
  restores. **Backups must also honor deletion** — a user erasure means content ages out of
  backups within the documented backup window; state this window in the privacy policy.
- Media store versioning/backups likewise encrypted and access-limited.

---

## Legal constraints — storing third parties' messages (READ CAREFULLY)

This is the highest-risk area of the product. The bot archives messages authored by **the
owner's chat partners**, who did **not** consent to our service.

### The core issue
- The owner has lawful access to their own conversations. But **persisting a third party's
  messages on our servers** and processing them makes **us a data controller/processor of the
  partner's personal data**, who is a non-consenting data subject.
- Under **GDPR**, message content is personal data (sometimes special-category). Lawful basis
  is hard: the partner never consented; "legitimate interest" is weak against their privacy
  rights; the owner cannot consent on the partner's behalf. A "household/personal use"
  exemption may cover the owner personally but **does not cover us** operating a commercial
  cloud service.
- Similar exposure under ePrivacy (confidentiality of communications), and comparable regimes
  elsewhere (e.g. some jurisdictions criminalize covert interception/recording of comms).

### Telegram platform rules
- Telegram's Bot ToS / Business bot terms govern acceptable use. A product framed as covert
  **surveillance of third parties** risks violating platform terms and getting the bot banned.
  The same primitives are legitimate for **personal backup / CRM / self-archiving**; framing
  and consent are what separate compliant from non-compliant.
- **НЕ ПОДТВЕРЖДЕНО** here: the exact clause status — verify against the current Bot Terms and
  Telegram Business terms before launch (legal review), and confirm whether "monitoring
  others' deletions" is expressly disallowed.

### Practical mitigations (design, not legal advice)
- **Position as self-archiving / personal message backup**, not "spy on your contacts."
- **Minimize + short retention** by default; make attribution honesty explicit (Q4).
- **Transparency:** a realistic option is having the owner's account signal to partners that a
  bot is connected (Telegram itself surfaces business-bot presence in some UIs — verify).
- **Data-subject rights:** provide deletion/export; define a controller and DPA with Supabase/S3.
- **Jurisdiction gating:** consider restricting availability in strict-consent jurisdictions.
- **Get a real lawyer.** Two-party-consent and interception laws vary widely; this is a
  launch-blocking review, not a checkbox.

> Bottom line: technically feasible with official APIs; the binding constraint is **legal**,
> not technical. The product must be built and marketed as **personal archival with honest
> capabilities**, with retention minimization and a genuine legal review per target market.
