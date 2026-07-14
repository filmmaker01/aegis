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

## Media messages (E-5..E-8) — field shapes & getFile-after-delete

All four media types were delivered as normal `business_message`, then deleted. `getFile`
resolved for ALL of them AFTER deletion, and the photo's bytes downloaded successfully
(200, 215365 bytes, valid JPEG). Media `file_id` values are omitted below (bot-scoped tokens).

- **photo** (msg 935363): `photo[]` (size variants) → `file_id, file_unique_id, file_size, width, height`. 1280x714, 215365 B.
- **voice** (935364): `voice{ duration, mime_type=audio/ogg, file_id, file_unique_id, file_size }`. 3s, 12316 B.
- **video** (935365): `video{ duration, width, height, file_name, mime_type=video/mp4, thumbnail{…}, thumb{…}, file_id, file_unique_id, file_size }`. 9s, 5.1 MB. (both `thumbnail` and legacy `thumb` present)
- **document** (935366): `document{ file_name, mime_type=image/png, thumbnail{…}, thumb{…}, file_id, file_unique_id, file_size }`. 195880 B.

**getFile after delete:** photo/voice/video/document all returned `ok:true` with a `file_path`
seconds–minutes after deletion; photo download returned the full bytes. → media stays
retrievable at least shortly after deletion. Longevity beyond that is untested; Bot API
download cap (~20 MB without a self-hosted API server) still applies to large files.

## edited_business_message (E-2) — edit of msg 935367

Same `message_id` as the original; original `date` preserved; new `edit_date` added; `text` updated. Full version history is reconstructable by keeping each received version.

Original:
```json
{
  "business_connection_id": "gPOd…<len:27>",
  "message_id": 935367,
  "from": {
    "id": "<from.id>",
    "is_bot": false,
    "first_name": "<first>",
    "username": "<username>"
  },
  "chat": {
    "id": "<chat.id>",
    "first_name": "<first>",
    "username": "<username>",
    "type": "private"
  },
  "date": 1784068656,
  "text": "<text:5 chars>"
}
```
Edited:
```json
{
  "business_connection_id": "gPOd…<len:27>",
  "message_id": 935367,
  "from": {
    "id": "<from.id>",
    "is_bot": false,
    "first_name": "<first>",
    "username": "<username>"
  },
  "chat": {
    "id": "<chat.id>",
    "first_name": "<first>",
    "username": "<username>",
    "type": "private"
  },
  "date": 1784068656,
  "edit_date": 1784068658,
  "text": "<text:11 chars>"
}
```
