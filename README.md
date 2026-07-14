# Telegram "deleted messages" service — research & architecture

Official-API-only design for a commercial service similar to Not Spy (@notspybot), built on
Telegram's **Connected Business Bots**. **Research first, no product code yet.**

## The one fact that defines this product
Telegram's `deleted_business_messages` update contains **only** `business_connection_id`,
`chat`, and `message_ids[]` — **no content, no initiator, no timestamp**. So:
1. We must **archive every message on arrival** to be able to show deleted content.
2. We **cannot** know *who* deleted a message (partner vs owner vs "for both"). This is a hard,
   documented limitation — the product must be honest about it.

## Docs
- [01 — Telegram API research & limitations](docs/01-research-telegram-api.md)
- [02 — Architecture](docs/02-architecture.md)
- [03 — Database schema](docs/03-database.md)
- [04 — Webhook processing](docs/04-webhooks.md)
- [05 — Mini App & UX](docs/05-miniapp-ux.md)
- [06 — Security & Legal](docs/06-security-legal.md)
- [07 — Roadmap](docs/07-roadmap.md)
- [08 — Repository structure](docs/08-repo-structure.md)

## Status
Research complete against Bot API 10.2 (2026-07-14). Six experiments (E-1…E-6) defined to
confirm behavior the docs leave ambiguous — run them in Phase 1 before building.
