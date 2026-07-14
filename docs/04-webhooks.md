# 04 — Webhook processing

Register with `setWebhook`, passing a **secret token** and an explicit `allowed_updates`:

```
allowed_updates = [
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages"
]
```

(these four are **not** delivered by default). Add `message`/`callback_query` only for the
bot's own onboarding chat.

## Ingress contract (fast path)

1. Verify header `X-Telegram-Bot-Api-Secret-Token` equals our configured secret. Mismatch → `401`, drop.
2. Parse minimal envelope (`update_id`, type, `business_connection_id`).
3. `XADD` the raw update to Redis Stream `stream:conn:{business_connection_id}`
   (fallback stream for `business_connection` events without a chat).
4. Return `200 OK` immediately. **No DB, no getFile inline** (must ack before Telegram's timeout).

If Redis is down, return non-200 so Telegram **retries** (at-least-once is our safety net).

## Idempotency

- **First gate:** `SET update:{update_id} 1 NX EX 86400`. If it already exists → duplicate,
  ack and skip. Backed by the durable `processed_updates` table for the worker (insert
  `on conflict do nothing`; if 0 rows affected → already processed).
- **Second gate (semantic):** all upserts use natural unique keys
  (`(connection_id, chat_id, tg_message_id)`), so even a *replayed* update is a no-op/merge,
  not a duplicate row.

## Ordering & race conditions

- **Per-connection FIFO:** one Redis Stream per `business_connection_id`; a consumer group
  with the stream as the ordering unit. Within a connection, updates are processed in arrival
  order.
- **Per-chat lock:** before mutating a chat's messages, acquire `lock:chat:{chat_id}` (Redis
  `SET NX PX 5000`). Prevents an edit and a delete for the same message racing across workers.
- **Out-of-order across the wire:** Telegram is at-least-once and only *roughly* ordered.
  We tolerate it with **event-sourced merges** rather than assuming sequence:
  - **delete arrives before the message was archived** (message create still in flight or
    lost): insert a `deleted_events` row with `message_id = null` and `tg_message_id` set;
    when/if the `business_message` later arrives, the create handler checks `deleted_events`
    for a matching `tg_message_id` and immediately marks the new `messages` row
    `is_deleted = true`. → "tombstone-first" reconciliation.
  - **edit arrives before create:** upsert the `messages` row from the edit payload
    (it is itself a full `Message`), version_no assigned by count; a later create with the
    same key becomes version 1 by `edit_date`/`date` ordering.
  - **duplicate delete:** unique `(connection, chat, tg_message_id)` on `deleted_events` makes
    it idempotent.

## Handlers

### `business_connection`
```
on business_connection(bc):
  upsert users(bc.user)
  upsert business_connections {
    connection_id: bc.id, owner_user_id, tg_user_chat_id: bc.user_chat_id,
    rights: bc.rights, connected_at: bc.date,
    state: bc.is_enabled ? 'active' : 'disabled'
  }
  if not bc.is_enabled: mark state='disabled'
  if connection removed (is_enabled=false + absent): state='revoked', stop archiving,
     start retention countdown per legal policy
```
Rights changes are snapshotted so the Mini App can show "the bot lost permission to X."

### `business_message`
```
on business_message(msg):
  with lock:chat:{msg.chat.id}:
    upsert chats(connection, msg.chat)
    row = upsert messages by (connection, chat, msg.message_id) {
      direction, from_tg_id, sent_at: msg.date, current_text: text||caption, raw: msg
    }
    insert message_versions(row, version_no=next, raw=msg, text)
    if msg has media: enqueue media job(row, file_id...)
    # tombstone reconciliation:
    if deleted_events exists for this tg_message_id: mark row.is_deleted=true
    update chats.last_message_at
```

### `edited_business_message`
```
on edited_business_message(msg):
  with lock:chat:{msg.chat.id}:
    row = upsert messages by key   # create-if-missing (out-of-order safe)
    if latest stored version text == new text and raw equal: skip (dedupe re-delivery)
    insert message_versions(row, version_no=next, edit_date: msg.edit_date, raw: msg)
    set messages.is_edited=true, current_text=new
    if notify_on_edit: enqueue notify(edit)
```
Guard: Telegram can re-deliver the same edit; compare against last version (hash of raw) to
avoid version spam.

### `deleted_business_messages`
```
on deleted_business_messages(d):   # d = {business_connection_id, chat, message_ids[]}
  with lock:chat:{d.chat.id}:
    for mid in d.message_ids:
      ins = insert deleted_events (connection, chat, tg_message_id=mid,
              message_id = (lookup messages by key) or null,
              initiator = 'unknown', detected_at = now())
            on conflict (connection,chat,tg_message_id) do nothing
      if ins created a row:
        if message row exists: set messages.is_deleted=true
        if notify_on_delete and message row exists and not muted:
           enqueue notify(deleted, saved_content=message.current_text + media refs)
        else if message row missing:
           # we never archived it (started monitoring later, or missed) -> notify "a message
           # was deleted but its content was not in your archive"
```

## Retry policy (our workers)

- Redis consumer group with **pending-entries reclaim** (`XAUTOCLAIM`) for crashed consumers.
- Job-level retry with exponential backoff + jitter; max attempts, then **dead-letter stream**
  `stream:dlq` + alert.
- Telegram `429` handling: honor `retry_after`, use a token-bucket per bot token in Redis.
- `getFile` failures (E‑4): retry a few times fast (file may still be alive), then mark
  `media.state='unavailable'`.

## Never break Telegram's contract

- Ack ingress within the timeout, always.
- Never `setWebhook` on every deploy (rate-limited); guard with a stored config hash.
- One webhook URL per bot token; scale ingress horizontally behind it (stateless).
