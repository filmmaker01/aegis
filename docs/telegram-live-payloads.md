# Telegram Business API — live payloads (anonymized)

Real payloads captured by api-probe from @AegisArchive_bot. Personal identifiers (ids, names, usernames, message text) are masked; structure and field presence are preserved. Captured 2026-07-14.

## business_connection — at connect (NO rights granted)

`rights: {}` empty, `can_reply:false`. A `business_message` still arrived under this state (see below) — **receipt does not require any right**.

```json
{
  "id": "<obj.id>",
  "user": {
    "id": "<user.id>",
    "is_bot": false,
    "first_name": "<first_name>",
    "last_name": "<last_name>",
    "username": "<username>",
    "language_code": "ru",
    "is_premium": true
  },
  "user_chat_id": "<obj.user_chat_id>",
  "date": 1784066388,
  "is_enabled": true,
  "can_reply": false,
  "rights": {}
}
```

## business_connection — after user granted permissions

New update on settings change. `rights` contains ONLY the granted booleans (ungranted rights are OMITTED, not present as false). `date` is unchanged from the original connect → `date` = connection creation, not update time.

```json
{
  "id": "<obj.id>",
  "user": {
    "id": "<user.id>",
    "is_bot": false,
    "first_name": "<first_name>",
    "last_name": "<last_name>",
    "username": "<username>",
    "language_code": "ru",
    "is_premium": true
  },
  "user_chat_id": "<obj.user_chat_id>",
  "date": 1784066388,
  "is_enabled": true,
  "can_reply": true,
  "rights": {
    "can_reply": true,
    "can_read_messages": true,
    "can_delete_sent_messages": true,
    "can_delete_all_messages": true
  }
}
```

## business_message (E-1) — incoming text

Full Message. `business_connection_id` links it to the connection; `message_id` links it to a later deletion. Arrived while rights were still empty.

```json
{
  "business_connection_id": "gPOd…<len:27>",
  "message_id": 935359,
  "from": {
    "id": "<from.id>",
    "is_bot": false,
    "first_name": "<first_name>",
    "username": "<username>"
  },
  "chat": {
    "id": "<chat.id>",
    "first_name": "<first_name>",
    "username": "<username>",
    "type": "private"
  },
  "date": 1784067576,
  "text": "<text:6 chars>"
}
```

## deleted_business_messages (E-3) — delete

Contains ONLY `business_connection_id`, `chat`, `message_ids[]`. NO content, NO initiator, NO timestamp. `message_ids` matches the message_id above → deletions are correlatable to archived messages only.

```json
{
  "business_connection_id": "gPOd…<len:27>",
  "chat": {
    "id": "<chat.id>",
    "first_name": "<first_name>",
    "username": "<username>",
    "type": "private"
  },
  "message_ids": [
    935359
  ]
}
```

## deleted_business_messages (E-9) — BATCH delete (22 ids in ONE update)

Deleting many messages at once produces a SINGLE update with an array of message_ids (not many updates). Most of these ids were NEVER archived by the bot (they predate the connection) — the bot is notified of deletions it has no saved copy for.

```json
{
  "business_connection_id": "gPOd…<len:27>",
  "chat": {
    "id": "<chat.id>",
    "first_name": "<first_name>",
    "username": "<username>",
    "type": "private"
  },
  "message_ids": [
    831694,
    845455,
    845456,
    887456,
    887457,
    887458,
    887459,
    887460,
    887461,
    887462,
    887463,
    887464,
    887465,
    887466,
    887467,
    887468,
    921803,
    921804,
    921805,
    921806,
    921807,
    921808
  ]
}
```
