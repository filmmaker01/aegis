# 01 — Research: Official Telegram API for a "deleted messages" service

> Scope: everything below is grounded in the **official Telegram Bot API** and MTProto
> documentation as of **Bot API 10.2 (2026‑07‑14)**. Anything not provable from the docs
> is explicitly marked **НЕ ПОДТВЕРЖДЕНО** with a proposed experiment.

## Sources (primary)

- Bot API reference — https://core.telegram.org/bots/api
- Bot API changelog — https://core.telegram.org/bots/api-changelog
- Connected business bots (MTProto) — https://core.telegram.org/api/bots/connected-business-bots
- `businessBotRights` constructor — https://core.telegram.org/constructor/businessBotRights
- Mirrors used to read exact field lists: python-telegram-bot v22.3, aiogram 3.x, grammY "Telegram Business".

## Version timeline (confirmed from changelog)

| Bot API | Date | What was added |
|---|---|---|
| **7.2** | 2024‑03‑31 | `BusinessConnection` + `business_connection` update; `business_message`; `edited_business_message`; `deleted_business_messages` + `BusinessMessagesDeleted` |
| **9.0** | 2025‑04‑11 | `BusinessBotRights` class; replaced `can_reply` with `rights` (BusinessBotRights). `can_reply` kept for backward compatibility but **deprecated** |
| **10.2** | 2026‑07‑14 | latest version at time of research |

---

## Q1 — What do Connected Business Bots give us?

A **connected business bot** is a bot that a *Telegram Premium* user attaches to their
personal account via **Settings → Telegram Business → Chatbots**. Once connected, Telegram
starts pushing the account's **private‑chat** activity to the bot through the Bot API and
grants the bot a set of **owner‑controlled rights**.

Capabilities relevant to us (all confirmed):

- Receive **incoming and outgoing** messages of the owner's private chats as `business_message`
  updates (a normal `Message` object carrying `business_connection_id`).
- Receive **edits** as `edited_business_message`.
- Receive **deletions** as `deleted_business_messages` (`BusinessMessagesDeleted`).
- Receive **connect / disconnect / rights‑change** events as `business_connection`.
- Act on behalf of the account **only within granted rights** (reply within 24h window,
  mark as read, delete, manage gifts/stars/stories, edit profile…). For a *read‑only
  archiver* product we need almost none of these action rights.

Scope limits (confirmed):

- Business features apply to **private 1‑to‑1 chats only** — not groups, not channels.
- The **owner chooses which chats** the bot sees. In the client this is the recipient set;
  at MTProto level it is `InputBusinessBotRecipients` with flags `existing_chats`,
  `new_chats`, `contacts`, `non_contacts`, and **exclude** lists. → "Allowed chats" is
  enforced by Telegram, upstream of us; our app must respect and mirror it, not re‑implement it.

---

## Q2 — Can the bot receive these? (per type)

| Item | Confirmed? | Notes |
|---|---|---|
| New messages (`business_message`) | ✅ Yes | Full `Message` object, incoming + outgoing |
| `edited_business_message` | ✅ Yes | New full version of the message |
| `deleted_business_messages` | ✅ Yes | But **only IDs** — see Q3 |
| Media (photo) | ✅ Yes | `message.photo[]`; download via `getFile` |
| Voice | ✅ Yes | `message.voice` |
| Video / video note | ✅ Yes | `message.video`, `message.video_note` |
| Documents | ✅ Yes | `message.document` |
| Audio / animation / sticker | ✅ Yes | standard `Message` fields |

**Critical media caveat (confirmed by mechanism, flagged for testing):** the delete update
carries no file. To be able to *show* a deleted photo/voice/video later, we must **download
the file to our own storage at arrival time**, because once the message is deleted the file
reference can stop resolving via `getFile`. Practical validity of the file link after
deletion is **НЕ ПОДТВЕРЖДЕНО** in the docs → **experiment E‑4**.

---

## Q3 — What exactly is in `deleted_business_messages`?

`BusinessMessagesDeleted` has **exactly three fields** (confirmed against the reference):

| Field | Type | Present? |
|---|---|---|
| `business_connection_id` | String | ✅ |
| `chat` | Chat | ✅ (the business account's chat; bot may not have direct access to it) |
| `message_ids` | Array of Integer | ✅ (IDs of the deleted messages) |

Against your checklist:

| You asked whether it contains… | Answer |
|---|---|
| `message_id`(s) | ✅ Yes (`message_ids[]`) |
| `chat_id` | ✅ Yes (via `chat.id`) |
| `business_connection_id` | ✅ Yes |
| **initiator of deletion** | ❌ **No field exists** |
| **text of the deleted message** | ❌ **No** — content is never included |
| **time of deletion** | ❌ **No** — no timestamp field |

**Consequence — the load‑bearing design fact of the whole product:** the deletion event is
just "these message IDs are gone." The *only* way to show a user what was deleted is to have
**stored the message ourselves when it first arrived**. The archiver is not optional; it is
the product. Deletion time must be **approximated by our server‑receipt timestamp**.

---

## Q4 — Can we tell WHO deleted, and "for both"? — CRITICAL LIMITATION

**Short answer: No. This is a hard, documented limitation.**

`BusinessMessagesDeleted` contains **no initiator field**. There is no way, from the update
itself, to distinguish:

- the **chat partner** deleted the message, vs
- the **account owner** deleted it, vs
- it was deleted **for both sides**.

What can be reasoned about Telegram's deletion model (mechanism-level, **partially
НЕ ПОДТВЕРЖДЕНО** and marked for experiment):

- The bot observes the **owner's account**. It is notified when a message disappears **from
  the owner's copy** of a private chat.
- **"Delete for everyone"** by either party removes the owner's copy → **bot is notified**.
  Owner‑initiated and partner‑initiated deletions look **identical** in the update.
- **"Delete for me / only for myself"** by the **partner** does *not* remove the owner's copy,
  so the bot most likely receives **nothing** — the "spy" value case. This is
  **НЕ ПОДТВЕРЖДЕНО**.
- **"Delete for me"** by the **owner** removes the owner's copy → bot *is* notified, even
  though nothing was "hidden" from the owner.

### How to verify experimentally (E‑1 … E‑3)

- **E‑1 — Partner deletes for everyone:** from a second account, send a message to the owner,
  then "Delete for everyone." Expect `deleted_business_messages`. Record what arrives.
- **E‑2 — Partner deletes for self only:** repeat but choose "Delete just for me" on the
  partner side. Expected: **no** update reaches the bot. Confirm.
- **E‑3 — Owner deletes (both options):** owner deletes own/partner message, "for everyone"
  and "for me." Compare updates. If all three (E‑1/E‑3 variants) are byte‑identical in shape,
  the **non‑attribution limitation is proven** and must be surfaced in the product.

### Product implication (must be stated to users)

The product can reliably show **"a message that was in your chat was deleted, here is its
saved content."** It **cannot** truthfully claim **"your contact deleted a message from
you"** — attribution is not available. Marketing and UI copy must avoid implying certainty
about *who* deleted. We can only apply **heuristics** (see architecture: if the saved
message was `from_id == partner` and is now deleted while the owner did not issue a delete
through our bot, it was *probably* partner‑side — but this is inference, not fact).

---

## Additional confirmed facts that shape the design

- **`BusinessConnection` object** (fields): `id`, `user` (User — the owner), `user_chat_id`
  (Integer), `date` (Integer, unix), `rights` (BusinessBotRights, optional),
  `is_enabled` (Boolean). `can_reply` deprecated since 9.0.
- **`BusinessBotRights`** booleans: `can_reply`, `can_read_messages` ("mark incoming private
  messages as read"), `can_delete_sent_messages`, `can_delete_all_messages`, `can_edit_name`,
  `can_edit_bio`, `can_edit_profile_photo`, `can_edit_username`, `can_change_gift_settings`,
  `can_view_gifts_and_stars`, `can_convert_gifts_to_stars`, `can_transfer_and_upgrade_gifts`,
  `can_transfer_stars`, `can_manage_stories`.
  → For a read‑only archiver we request the **minimum**: effectively none of the write rights.
  Receiving messages does **not** require `can_read_messages` (that right only lets us mark as
  read). **НЕ ПОДТВЕРЖДЕНО:** whether Telegram delivers `business_message` when the owner
  grants zero rights → **experiment E‑5** (connect with a minimal-rights profile and observe).
- **Message linkage:** `Message.business_connection_id` ties a message to a connection.
  `Message.from`, `Message.date`, `Message.message_id`, `Message.chat` give us sender,
  original time, ID and chat. Outgoing owner messages may carry `sender_business_bot`.
- **Transport:** updates arrive via the **same** `getUpdates`/webhook channel; you must
  opt‑in via `allowed_updates` including `business_connection`, `business_message`,
  `edited_business_message`, `deleted_business_messages` (they are **not** delivered by
  default).
- **Ordering / delivery:** Bot API gives **at‑least‑once**, roughly ordered but **not
  strictly ordered** delivery, with `update_id` monotonic per bot. Design for duplicates and
  out‑of‑order (see webhook doc).

## Open items to confirm by experiment (summary)

| ID | Question | Method |
|---|---|---|
| E‑1 | Does partner "delete for everyone" reach the bot? | 2 test accounts |
| E‑2 | Does partner "delete for me" reach the bot? | 2 test accounts |
| E‑3 | Are owner vs partner deletions distinguishable? | compare payloads |
| E‑4 | Does a `file_id` still resolve via `getFile` **after** deletion? | delete then getFile |
| E‑5 | Are `business_message` updates delivered with zero write rights? | minimal-rights connect |
| E‑6 | Are edits after deletion / rapid edit+delete ordered? | scripted burst |
