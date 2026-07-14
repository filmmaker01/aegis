# Telegram Business API — live payloads (anonymized)

Real payloads captured by api-probe. Personal identifiers (ids, names, usernames, message text) are masked; structure and field presence are preserved.

## business_connection (first capture, 2026-07-14T21:59:47.349Z)

Field list:

```
id
user.id
user.is_bot
user.first_name
user.last_name
user.username
user.language_code
user.is_premium
user_chat_id
date
is_enabled
can_reply
rights (object, EMPTY)
```

Anonymized payload:

```json
{
  "id": "gPOd…<len:27>",
  "user": {
    "id": "<user_id>",
    "is_bot": false,
    "first_name": "<first>",
    "last_name": "<last>",
    "username": "<username>",
    "language_code": "ru",
    "is_premium": true
  },
  "user_chat_id": "<user_chat_id>",
  "date": 1784066388,
  "is_enabled": true,
  "can_reply": false,
  "rights": {}
}
```

**Key finding:** `rights: {}` is empty and `can_reply: false` — the user granted the bot **no rights**. Per the official docs, receiving `business_message` depends on the connection **recipient scope**, not on rights; rights only gate actions (reply / read-receipt / delete). This is flagged for live confirmation (E-1).
