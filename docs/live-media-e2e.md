# Live media end-to-end — download → delete → resend saved copy (PASSED)

Date: 2026-07-15 · Bot: `@AegisArchive_bot` · Backend: `aegis-app` on Postgres, media on
**local disk** (`MEDIA_STORAGE=local`). Official Bot API only.

Proves: a media message is downloaded on arrival and stored; when deleted "for everyone" the
bot re-sends the saved copy to the owner's `user_chat_id` via the type-appropriate method.

## Result — all four types PASSED

| Type | msg_id | downloaded | state | size (bytes) | checksum | deletion notified | media sent |
|------|--------|-----------|-------|--------------|----------|-------------------|------------|
| photo | 935390 | ✅ | stored | 215365 | `5aa326f70c1b0765…` | ✅ | 1/1 (sendPhoto) |
| voice | 935393 | ✅ | stored | 23942 | `e2b0b44794d541c6…` | ✅ | 1/1 (sendVoice) |
| video | 935396 | ✅ | stored | 10869096 | `04da6dba85ebc23e…` | ✅ | 1/1 (sendVideo) |
| document | 935397 | ✅ | stored | 195880 | `54a923bcc5e7d8d6…` | ✅ | 1/1 (sendDocument) |

## Backend logs (anonymized — no bytes/tokens/PII/storage URLs)
```
[ingest] type=business_message message_id=935390
[fetch-conn] gPOd… resolved=true
[media] media_id=…caf1… type=photo    result=stored bytes=215365
[ingest] type=deleted_business_messages message_ids=[935390]
[notify] message_id=935390 archived=true media=1 sent=1
… (voice 935393, video 935396, document 935397 identical shape) …
```

## DB confirmation (Postgres)
- All 4 `media` rows: `state=stored`, `checksum` set, `storage_key` set, `file_name` set.
- All 4 `deleted_events`: `notified_at` set exactly once (no duplicate notification).
- Notification target = `business_connection.user_chat_id` (`<owner_user_chat_id>`), which is
  **different** from the monitored `chat.id` (`<monitored_chat_id>`) — the saved copy went to
  the owner's DM with the bot, not the partner chat.

## Files on disk (local storage)
```
media/<conn>/935390/<mediaId>-file_0.jpg   (photo)
media/<conn>/935393/<mediaId>-file_4.oga   (voice)
media/<conn>/935396/<mediaId>-file_5.mp4   (video, 10.4 MB)
media/<conn>/935397/<mediaId>-file_6.png   (document)
```

## Checkpoints (all ✅)
business_message received · worker downloaded · state=stored · checksum saved ·
deleted_business_messages received · archived record found · notification to owner user_chat_id ·
sendPhoto/sendVoice/sendVideo/sendDocument succeeded · no duplicate notifications.

## Fix that made it pass
On Postgres, storing a message requires the business connection to exist, but the
`business_connection` event was never delivered (Telegram doesn't resend it on webhook change).
Fixed by running the `getBusinessConnection` self-heal at the start of **every** handler
(message/edit/delete), not only during notification. Unknown-and-unfetchable connections are
skipped gracefully (never a 500). See commit `9cb065a`.

**Acceptance criterion for this stage: MET.**
