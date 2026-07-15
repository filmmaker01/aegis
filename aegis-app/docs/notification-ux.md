# Owner notification UX (the bot chat)

The **primary surface for Aegis is the ordinary Telegram chat** between the owner and
[@AegisArchive_bot](https://t.me/AegisArchive_bot) — not the Mini App. When something happens in
a monitored business chat, the bot sends the owner a **card** (a Russian, HTML-formatted message)
with **inline action buttons**. The Mini App remains the place for the full archive; the chat is
where the owner sees and acts on events in the moment.

All copy, HTML escaping, length limits, RU plurals and the `callback_data` codec live in one pure,
unit-tested module: [`backend/src/modules/archive/notification/format.ts`](../backend/src/modules/archive/notification/format.ts).
Nothing else re-invents wording — the notifier and callback service only compose its exports.

> Aegis never claims **who** deleted a message: the Bot API does not report the initiator. Cards say
> "message deleted", never "X deleted a message".

## Cards

| Situation | Builder | Shape |
|---|---|---|
| Deleted text message | `deletedTextCard` | 🗑 header, peer + time, the saved text (or an honest "copy not saved" note when it predates monitoring). |
| Deleted message with media | `mediaLeadCard` + the stored files | A lead card (peer, media type, action buttons), then each stored file re-sent; the caption rides on the first file (`mediaCaption`). If a file can't be re-sent, an honest `mediaFailedNote` is sent instead. |
| Edited message | `editedCard` | ✏️ header, peer + time, **Было / Стало** (before/after from the last two versions). |
| Bulk delete | `batchCard` | One card summarising the count (RU plural) with the first ≤5 previews — **not** N separate messages. |
| Edit history | `historyView` | Paginated version list (5 per page), newest pages reachable via nav buttons. |

Timestamps are UTC for now (`HH:MM` same day, else `DD.MM · HH:MM`); per-owner timezone is a future
setting centralised in the format module.

## Buttons and callback actions

Buttons carry a compact `callback_data` payload encoded by `encodeCallback(action, …parts)` and kept
**≤ 64 bytes** (Telegram's hard limit; the codec throws if exceeded). Three actions exist:

| `callback_data` | Meaning |
|---|---|
| `restore:<eventId\|messageId>` | Re-send the saved copy (deletion) or the previous version (edit) to the owner's chat. |
| `history:<eventId\|messageId>[:page]` | Show a page of the edit history. |
| `archive:<eventId>` | Point to the Mini App (full archive — upcoming). |

`restore`/`history` accept **either** a deletion event id **or** an internal message id: the callback
service tries `getEventForCallback` first, then `getMessageForCallback`. Deletion cards carry the
event id; edit cards carry the message id.

Handler: [`backend/src/modules/archive/infrastructure/callback-service.ts`](../backend/src/modules/archive/infrastructure/callback-service.ts).
Parsing/routing: [`updates.ts`](../backend/src/modules/telegram/updates.ts) →
[`webhook-routes.ts`](../backend/src/modules/telegram/transport/webhook-routes.ts) (still behind the
`x-telegram-bot-api-secret-token` gate).

## Security: ownership + anti-enumeration

Every `restore`/`history` press is authorised before anything happens:

1. Resolve the opaque id → its business connection → `ownerTgUserId`.
2. Require `callback_query.from.id === ownerTgUserId`.
3. **Foreign or unknown id → answer a neutral `Недоступно` and do nothing else.** The bot never
   reveals whether an id exists, so ids can't be enumerated. Invalid (non-uuid) ids resolve to the
   same neutral answer.

`archive` reveals no data (it only points to the Mini App), so it answers without an ownership check.

## Restore mechanics (MVP)

- Restore re-sends to the **callback chat** (the owner's chat with the bot) — never back into the
  original foreign chat.
- Saved text is re-sent as **plain text** (no parse mode) so stored content can never be
  re-interpreted as markup or injected formatting. Stored media is re-sent with the caption
  (escaped HTML) on the first file.
- A deletion restore re-sends the saved copy + media; an edit restore re-sends the **previous**
  version's text.

### Idempotency

Repeat `restore` presses are **safe**. The callback service keeps a best-effort in-process guard
(`del:<eventId>` / `msg:<messageId>`): the first press restores and answers `Восстановлено`; a repeat
answers `Уже восстановлено` without re-sending. A process restart at worst allows one more safe,
repeatable re-send (restore has no side effect that can't be repeated). Durable restore-state is a
possible future refinement.

## History pagination

5 versions per page. `history` sends a **new** message for the requested page with nav buttons
(‹ Назад / Дальше ›); the full, unbounded history lives in the Mini App. In-place text editing was
intentionally left out for the MVP.

## Notification settings

Per business connection, stored in `notification_settings`
([`settings-ports.ts`](../backend/src/modules/archive/application/settings-ports.ts); model in
[`schema.prisma`](../backend/prisma/schema.prisma)). Defaults are **all on**, so behaviour is
unchanged until an owner opts out.

| Field | Default | Effect when off / set |
|---|---|---|
| `notifyDeletions` | `true` | No deletion cards. |
| `notifyEdits` | `true` | No edit cards. |
| `notifyMedia` | `true` | Deletion cards omit the re-sent media (text card only); still honestly reports the message had media. |
| `groupBatches` | `true` | A bulk delete sends one full card per message instead of a grouped card. |
| `mutedChats` | `[]` | tgChatIds in this list get **no** deletion/edit notifications. |

`IngestService` consults these before every notification. Usable now directly via the DB; ready for
a Mini App settings UI. When no settings source is wired (e.g. the in-memory dev repo without an
explicit override), everything is treated as on.

## Limits

- Message text: **4096** chars (`MESSAGE_TEXT_LIMIT`). Cards are bounded well under this; `splitText`
  is a safety net that splits on line/space boundaries and attaches the keyboard to the final chunk.
- Caption: **1024** chars (`CAPTION_LIMIT`), applied by `mediaCaption`.
- `callback_data`: **64** bytes (`CALLBACK_DATA_LIMIT`), enforced by `encodeCallback`.

## Privacy

Logs contain only ids, types and counts — never message text, tokens, storage keys, `callback_data`,
or personal data.

## Migration status

The `notification_settings` model is defined declaratively in `schema.prisma`, but its Prisma
migration is **not yet generated**. `prisma migrate dev` (the sanctioned workflow) currently fails in
any environment because the pre-existing `20260715010000_enable_rls` migration runs
`ALTER TABLE "_prisma_migrations" …`, which does not exist inside Prisma's shadow database. Once that
defect is resolved, run `bun run prisma:migrate --name notification_settings`. Until then, the Prisma
settings repository degrades to defaults if the table is absent; the in-memory path is fully tested.
The new table should also get `ENABLE ROW LEVEL SECURITY` to match the repo's deny-by-default posture.
