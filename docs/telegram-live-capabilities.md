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
| E-2 | `edited_business_message` on edit | ❔ | pending (no edit sent yet) |
| E-4 | partner "delete for me" reaches the bot | ❔ | pending |
| E-5 | photo delivered + `getFile` after delete | ❔ | pending |
| E-6 | voice delivered | ❔ | pending |
| E-7 | video / video_note delivered | ❔ | pending |
| E-8 | document delivered | ❔ | pending |

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

## Still pending (need user actions)
E-2 edit · E-4 "delete for me" · E-5 photo · E-6 voice · E-7 video · E-8 document.
