# 05 — Telegram Mini App: screens, UX, security of initData

Built with Next.js + React + Tailwind, launched from the bot. Uses
`@telegram-apps/sdk` (or `window.Telegram.WebApp`). Every API call carries `initData`;
the server validates it (see doc 06).

## Screens

### Dashboard
- Connection health card: `active / disabled / revoked`, granted rights, "reconnect" CTA.
- Counters: messages archived, deletions caught (last 24h / 7d), edits tracked, storage used.
- Recent activity feed (mix of deleted + edited, newest first).
- Subscription state + retention window ("keeping 7 days" / "unlimited").

### Deleted messages
- List grouped by chat, newest first. Each item: partner name/avatar, saved text preview,
  media thumbnail if archived, original `sent_at`, `detected_at` ("deleted ~ time").
- **Honest labeling (per Q4):** badge reads **"Deleted"** — never "deleted by them." A tooltip
  explains attribution is not provided by Telegram. If `initiator='owner_via_bot'` we may show
  "removed via this bot."
- Detail view: full saved content + full edit history + media player; "this content was saved
  before deletion."
- Empty/edge states: "message was deleted but not in your archive" when `message_id is null`.

### Edited messages
- List of messages with >1 version. Diff view (before → after), timestamps per version.

### Chats
- All monitored private chats; toggle mute per chat (writes `notification_settings.muted_chat_ids`).
- Shows which chats Telegram is actually feeding us vs excluded by the owner's recipient set
  (read-only; changing the recipient set happens in Telegram Settings, we deep-link to it).

### Settings
- Notification prefs (delete/edit toggles, include media, quiet hours).
- Data controls: export my data, **delete all my data** (irreversible, double-confirm).
- Retention display (tied to plan).
- Connection management: how to disconnect the bot (deep link to Telegram Business settings).

### Subscription
- Tiers (Free / Pro / Business): retention length, media archival, edit history depth,
  multi-account. Pay via **Telegram Stars** (native) and/or card provider.
- Current plan, renewal date, upgrade/downgrade, invoice history.

## UX flows

### 1) Connecting the bot
1. User opens our bot, taps **Connect** → we deep-link to
   **Telegram → Settings → Business → Chatbots**, pre-filled with our bot username.
2. User picks the recipient set (which chats) and grants rights.
3. Telegram fires `business_connection` → we create the connection, then the bot DMs:
   "✅ Connected. I'm now archiving your selected chats. Nothing is shown to anyone but you."
4. Mini App Dashboard now shows `active`.
- **Onboarding honesty:** explicitly tell the user what we can and cannot detect (no
  attribution; "delete for me" by the partner is invisible) — set correct expectations to
  avoid churn and trust issues.

### 2) Receiving a deletion notification
- Bot sends a DM to the owner: partner name, saved text (truncated), "🗑 A message was
  deleted • [Open]". [Open] launches the Mini App straight to that item.
- Respects quiet hours / mute; batches bursts (many `message_ids` at once → one grouped card).

### 3) Opening a deleted message
- Tap notification → Mini App deep-links to the deleted item detail (saved text, media, edit
  history, timestamps). Media served via signed URL from our storage.

### 4) Restoring history
- "Restore/Export": generate a chat transcript (archived messages + versions + deletions) as
  a downloadable file or a re-posted summary the owner can read. This is **reconstruction from
  our archive**, not a Telegram "undelete" (Telegram has no such API).

## Mini App security essentials

- Validate `initData` HMAC on **every** request; reject if `auth_date` is stale (> N minutes).
- Never trust client-sent `user_id`; derive identity from validated `initData`.
- All list endpoints paginate + are scoped server-side to the caller.
- Media via short-lived signed URLs; no public buckets.
