# Telegram API findings (summary + links)

Aegis depends on exactly what the **official** Telegram Bot API guarantees for Business
connections. The authoritative research and the experiment harness live in the repo:

- **Full research:** [`../../docs/01-research-telegram-api.md`](../../docs/01-research-telegram-api.md)
  (grounded in the Bot API reference, verified against Bot API 10.2).
- **Experiment harness (raw payloads):** [`../../api-probe`](../../api-probe) — run
  `npm run dev` + `npm run set-webhook`, then follow
  [`../../api-probe/TEST_PLAN.md`](../../api-probe/TEST_PLAN.md) (E-1 … E-10).

## Load-bearing facts (confirmed against the reference)
- Four business updates exist and are **not delivered by default** (must be in
  `allowed_updates`): `business_connection`, `business_message`, `edited_business_message`,
  `deleted_business_messages`.
- **`deleted_business_messages` (`BusinessMessagesDeleted`) contains only**
  `business_connection_id`, `chat`, `message_ids[]` — **no content, no initiator, no
  timestamp.** → Messages must be archived on arrival; deletion time ≈ our receipt time.
- **Deletion attribution is impossible** — cannot tell whether the partner, the owner, or
  "for both" deleted a message. Product copy must not claim otherwise.
- Business features apply to **private 1:1 chats only**.
- Since Bot API 9.0, `BusinessConnection.rights` (`BusinessBotRights`) replaces `can_reply`.
  A read-only archiver needs **no write rights**.
- Mini App auth = validate `initData` HMAC server-side (implemented in
  `backend/src/modules/telegram/init-data.ts`).

## Still to confirm by experiment (blocking before real ingestion)
| ID | Question |
|----|----------|
| E-3 | Partner vs owner "delete for everyone" — indistinguishable? |
| E-4 | Partner "delete for me" — does the bot get nothing? |
| E-5..E-8 | Does `getFile` still resolve **after** deletion (media archival)? |
| E-9 | Batched deletes: one update with an array vs many updates? |
| E-10 | Disconnect / rights change payload shape |

**Gate:** no product code may depend on any unconfirmed behavior above until the probe
confirms it. Update this file (and doc 01) with real log evidence as experiments complete.
