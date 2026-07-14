# Telegram Business API — confirmed capabilities (live)

Updated from **real** api-probe captures. Legend: ✅ confirmed live · ❌ disproven live ·
❔ awaiting a live event · ⏳ blocked on a user action.

Bot: `@AegisArchive_bot` · connection established 2026-07-14 21:59:47Z.

| # | Capability / question | Status | Evidence |
|---|-----------------------|--------|----------|
| — | `business_connection` delivered on connect | ✅ | `logs/…business_connection…` — full payload captured |
| — | Connection fields: `id, user{…}, user_chat_id, date, is_enabled, can_reply, rights` | ✅ | see `docs/telegram-live-payloads.md` |
| — | Owner `is_premium: true` required | ✅ | payload shows `user.is_premium: true` |
| — | Rights actually granted at connect | ✅ (finding) | **`rights: {}` empty**, `can_reply: false` — no rights granted |
| E-1 | `business_message` delivered for a normal text | ⏳ | no event yet — needs an in-scope message sent by the user |
| E-1 | Receipt works with **empty rights** | ❔ | official docs: receipt depends on recipient scope, not rights — verify live |
| E-2 | `edited_business_message` on edit | ❔ | pending |
| E-3 | `deleted_business_messages` on "delete for everyone" | ❔ | pending |
| E-3 | delete payload has NO content/initiator/timestamp | ❔ | pending (research says yes) |
| E-4 | partner "delete for me" reaches the bot | ❔ | pending |
| E-5 | photo delivered + `getFile` after delete | ❔ | pending |
| E-6 | voice delivered | ❔ | pending |
| E-7 | video / video_note delivered | ❔ | pending |
| E-8 | document delivered | ❔ | pending |

## Open blocker (needs a user action in Telegram)
No `business_message` has arrived. Pipeline is proven healthy (webhook has no `last_error`,
tunnel returns 200, `business_connection` was received). The bot cannot send messages, so
`business_message` can only be triggered by the account owner or a chat partner **sending a
message in a chat that is inside the connection's recipient scope**.

Two things to verify on the phone (Settings → Telegram Business → Chatbots):
1. **Recipient scope** includes the chat used for testing (not "only new chats" / excluding
   the tested contact).
2. **Permissions** — grant **"read messages"** as a test. Official docs say it isn't required
   for receipt (only for read-receipts), but one reputable third-party source claims read is
   required to see incoming messages. Toggling it is the clean experiment to disambiguate.
