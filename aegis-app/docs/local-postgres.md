# Local Postgres (dev) + persistence

Phase 2 persistence runs the archive on Postgres via the Prisma repository. Verified on
Postgres 16 (portable EDB binaries) since Docker was unavailable.

## What was set up
- Portable Postgres binaries run **directly** (`postgres.exe -D <data> -p 54329`), not via
  `pg_ctl` — `pg_ctl` start crashed with `0xC0000142` (fork/DLL-init) in this sandbox, while
  a direct start works. Data dir and binaries live on an **ASCII path** (the project path
  contains Cyrillic, which broke `initdb`/server startup with UTF8 encoding errors).
- Schema applied with `prisma db push`. Postgres 16 lacks the PG18 `uuidv7()` builtin used by
  the schema defaults, so a `uuidv7()` SQL function was created first:

```sql
create or replace function uuidv7() returns uuid as $$
select encode(set_bit(set_bit(
  overlay(uuid_send(gen_random_uuid())
    placing substring(int8send((extract(epoch from clock_timestamp())*1000)::bigint) from 3)
    from 1 for 6), 52, 1), 53, 1), 'hex')::uuid;
$$ language sql volatile;
```

## Reproduce
```bash
# start postgres (adjust paths); trust auth on localhost
postgres.exe -D <ascii-data-dir> -p 54329            # runs in foreground; background it
createdb -h 127.0.0.1 -p 54329 -U postgres aegis
psql "postgresql://postgres@127.0.0.1:54329/aegis" -f uuidv7.sql

cd aegis-app/backend
export DATABASE_URL="postgresql://postgres@127.0.0.1:54329/aegis?schema=public"
bun run prisma db push --accept-data-loss     # creates all tables
bun run test:pg                                # Prisma repo integration tests (5)
```

Backend on Postgres: set `ARCHIVE_STORE=postgres` (default) + `DATABASE_URL` in
`backend/.env`, then start the backend.

## Verified
- `prisma db push` created all 9 tables (7 archive + auth).
- **Prisma repo integration tests: 5 pass** (`bun run test:pg`) — idempotency, edit versioning,
  deletion → notification to owner `user_chat_id` with saved content, duplicate-delete dedup,
  owner-scoped queries.
- **Durability:** a message written via the webhook survived a **full backend restart**
  (present in Postgres afterwards) — proving the archive is no longer ephemeral.

## Note (production)
For production use a managed Postgres (the template targets Supabase / DO Managed Postgres).
Generate real migrations (`prisma migrate`) instead of `db push`, and provide `uuidv7()` via
the DB (PG18 builtin, the `pg_uuidv7` extension, or the SQL function above) before migrating.
