-- Enable Row Level Security (deny-by-default) on all Aegis tables.
--
-- Aegis is accessed exclusively by the backend through a privileged Postgres role
-- (the Prisma direct connection), which bypasses RLS. Enabling RLS with NO policies
-- therefore does not affect the backend, but it blocks the Supabase anon/authenticated
-- roles (PostgREST Data API) from reading or modifying any row. These tables hold
-- message PII and must never be reachable via the anon key.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deleted_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "processed_updates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
