# Telegram Business API — confirmed capabilities (live)

Updated from **real** api-probe captures. Legend: ✅ confirmed live · ❌ disproven live ·
❔ awaiting a live event.

Bot: `@AegisArchive_bot` · captured 2026-07-14. Anonymized payloads:
[telegram-live-payloads.md](telegram-live-payloads.md).

| # | Capability / question | Status | Evidence (update_id) |
|---|-----------------------|--------|----------------------|
| — | `business_connection` delivered on connect | ✅ | 112926887 |
| — | Connection fields: `id, user{…}, user_chat_id, date, is_enabled, can_reply, rights` | ✅ | 112926887 |
| — | Owner must be Premium (`user.is_premium:true`) | ✅ | 112926887 |
| — | Rights change → **new** `business_connection` update | ✅ | 112926890 |
| — | `rights` lists ONLY granted booleans (ungranted are omitted, not `false`) | ✅ | 112926890 |
| — | `business_connection.date` = connect time (unchanged on rights update) | ✅ | 887 vs 890 same date |
| E-1 | `business_message` delivered for incoming text | ✅ | 112926888 |
| E-1 | **Receipt works with EMPTY rights** (no permission needed to receive) | ✅ | 888 arrived at 22:19:36, before rights granted at 22:20:43 |
| E-1 | Message fields: `business_connection_id, message_id, from{…}, chat{…}, date, text` | ✅ | 112926888 |
| E-1 | `message_id` correlates a message to its later deletion | ✅ | 888 (935359) ↔ 889 |
| E-3 | `deleted_business_messages` on delete | ✅ | 112926889, 112926892 |
| E-3 | delete payload = ONLY `business_connection_id, chat, message_ids[]` | ✅ | 889/892 — no content field |
| E-3 | delete payload has **NO deleted content** | ✅ | confirmed absent |
| E-3 | delete payload has **NO initiator** (who deleted) | ✅ | confirmed absent → attribution impossible |
| E-3 | delete payload has **NO deletion timestamp** | ✅ | confirmed absent → use receipt time |
| E-9 | batch delete = ONE update with `message_ids[]` array | ✅ | 112926901 — 22 ids in one update |
| — | bot gets deletions for messages it NEVER archived (pre-connection history) | ✅ | 894/898/899/900/901 (ids 8xxxxx–9218xx, un-archived) |
| E-2 | `edited_business_message` on edit | ✅ | 112926911, 112926913 |
| E-2 | edit keeps same `message_id`, original `date`, adds `edit_date`, new `text` | ✅ | 935367: len 5→11, edit_date +2s |
| E-4 | "delete for me" produces NO event (invisible to bot) | ✅ | msgs 935369/935370 sent, no `deleted_business_messages` followed (pending:0, no error) |
| E-5 | photo delivered | ✅ | 112926902 (msg 935363) |
| E-5 | `getFile` works AFTER delete + bytes downloadable | ✅ | photo download 200, 215365 B, valid JPEG |
| E-6 | voice delivered (`audio/ogg`) + getFile after delete | ✅ | 112926904 (935364) |
| E-7 | video delivered (`video/mp4`, thumbnail+thumb) + getFile after delete | ✅ | 112926906 (935365) |
| E-8 | document delivered (`file_name`, mime) + getFile after delete | ✅ | 112926908 (935366) |

## Resolved
- **Empty-rights receipt question (was НЕ ПОДТВЕРЖДЕНО):** RESOLVED. `business_message`
  #112926888 was delivered while the connection had `rights: {}`. Receiving incoming messages
  depends on the **recipient scope**, not on any granted right. The read/reply/delete rights
  only gate *actions*.
- **Deletion attribution (H2):** CONFIRMED impossible — no initiator field exists in
  `deleted_business_messages`.

## Product implications confirmed
- **Store-on-arrival is mandatory** — the delete event carries no content, so the only way to
  show a deleted message is our own archive (correlated by `message_id`).
- A **read-only archiver needs no rights** to receive+archive; rights are only needed if we
  later want to reply, mark-as-read, or delete.

## New findings (2nd batch)
- **E-9 confirmed:** a bulk delete arrives as **one** `deleted_business_messages` with all
  ids in `message_ids[]` (observed 22 ids in a single update) — group notifications/idempotency
  must handle arrays, not assume one-id-per-update.
- **Pre-connection deletions:** the bot receives `deleted_business_messages` for messages it
  **never archived** (ids far below the first message we saw — old chat history the partner
  deleted). For those the product can only show "a message was deleted, content not in your
  archive." This is an inherent gap of store-on-arrival.

## E-4 status — NOT proven yet
Every deletion so far produced an event, so "delete for me is invisible" is **unconfirmed**.
Presence of events cannot prove the negative. Clean test needed:
1. Partner (2nd account) sends ONE new message; confirm a `business_message` arrives.
2. Partner deletes it with **"Delete only for me"** (not "for everyone").
3. Expect **NO** `deleted_business_messages`. Wait ~60s; if nothing arrives → E-4 confirmed.
Doing "delete for everyone" (the default) will always produce an event and does not test E-4.

## Media findings (E-5..E-8)
- All four types (photo, voice, video, document) delivered as normal `business_message`.
- **`getFile` resolves AFTER deletion** for all four; the photo's bytes downloaded fully
  (200, exact size, valid JPEG). → archival can even recover a file shortly after deletion,
  though download-at-arrival remains the safe strategy (post-delete longevity untested; Bot API
  ~20 MB download cap without a self-hosted API server).
- video/document carry both `thumbnail` and legacy `thumb`.

## E-2 / E-4 findings
- **E-2 confirmed:** `edited_business_message` keeps the original `message_id` and `date`, adds
  `edit_date`, and carries the new `text` — so a full version history is reconstructable by
  storing each received version.
- **E-4 confirmed:** after two fresh messages (935369, 935370) were deleted "only for me", NO
  `deleted_business_messages` arrived (pipeline healthy: pending:0, no last_error). "Delete for
  me" is invisible to the bot. → the product cannot capture partner-side self-deletions; only
  "delete for everyone" (and anything removing the owner's copy) is observable.

## All planned experiments complete
E-1 ✅ · E-2 ✅ · E-3 ✅ · E-4 ✅ · E-5 ✅ · E-6 ✅ · E-7 ✅ · E-8 ✅ · E-9 ✅.
See `telegram-live-payloads.md` for anonymized evidence.
