# Security notes (foundation)

## Secret handling rules
- **Never** commit `.env`. Only `.env.example` (placeholders) is tracked.
- **Never** log `BOT_TOKEN`, `WEBHOOK_SECRET`, or personal message content to shared/unsafe
  logs. Diagnostics may show at most: token length, first 5 / last 4 chars.
- Telegram `initData` is verified **server-side** (`backend/src/modules/telegram/init-data.ts`)
  with HMAC + `auth_date` freshness; client-side Telegram fields are UI-only and never trusted
  for authorization.
- Secret scanning is enforced via **gitleaks** (`.gitleaks.toml` + CI workflow). Run locally
  with `gitleaks detect` (or the Docker image) before pushing.

## Dependency audit (bun audit) — baseline at bootstrap
`bun audit` reported advisories after a clean install. Policy: **do not blind-update**
(`bun update --latest` would introduce breaking major bumps). Actions taken:

| Package | Severity | Action |
|---------|----------|--------|
| `hono` (backend) | high + moderate | **Fixed** — bumped to `4.12.30` (patch within 4.x) |
| `astro`/`devalue` (`website`) | high/moderate | **Deferred** — `website` is not an active Aegis surface; needs a major bump, revisit before beta |
| `vite` fs.deny (dev only) | high | **Deferred** — dev-server-only on Windows; not a production path |
| `yaml`, `@babel/core`, `launch-editor` | moderate/low | **Deferred** — transitive/dev-only; tracked |

Re-run `bun audit` and reassess before Beta (see roadmap). Any dependency touching the
production webhook or Mini App auth path must be clean before that phase.

## Out of scope for the foundation (do not implement yet)
Message database, media storage, subscriptions, payments, production webhook, and
Telegram-based user auth — these arrive in later phases with their own security review.
