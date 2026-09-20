-- Close the Data API surface.
--
-- Supabase grants `anon` and `authenticated` full CRUD on every table in
-- `public` by default, and PostgREST publishes that at
-- https://<project-ref>.supabase.co/rest/v1/. The anon key is public by design,
-- so those grants are reachable by anyone.
--
-- Gaja does not use PostgREST. It connects to Postgres directly with `pg` as the
-- owner role (lib/db.ts), so every one of those grants is unearned reach.
--
-- Measured on the hosted project before this migration ran:
--   GET  /rest/v1/users?select=id,email        → 200
--   GET  /rest/v1/sessions?select=token_hash   → 200
--   POST /rest/v1/sessions                     → 409 foreign_key_violation
--
-- The 409 is the important one: the insert cleared the permission check and
-- failed only on referential integrity. An insert naming a real user_id with a
-- chosen token_hash is account takeover, because lib/session.ts authenticates on
-- exactly that column and nothing else. `magic_links` is the same shape.

-- 1. Revoke what is already granted.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines  in schema public from anon, authenticated;
revoke usage on schema public from anon, authenticated;

-- 2. Stop the grants being reapplied to anything created later. Without this,
--    the next `create table` in this schema is public again on creation.
alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on routines  from anon, authenticated;

-- 3. Defence in depth. RLS with zero policies denies every role that does not
--    bypass it, so a future grant — a dashboard click, a CLI reset, someone
--    enabling the Data API — cannot silently reopen the table.
--
--    The application is unaffected: it connects as the tables' owner, and an
--    owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set, which it is not.
--    If Gaja ever moves to a non-owner application role, that role needs
--    explicit policies before it can read anything — which is the point.
alter table users            enable row level security;
alter table magic_links      enable row level security;
alter table sessions         enable row level security;
alter table groups           enable row level security;
alter table group_members    enable row level security;
alter table group_invites    enable row level security;
alter table places           enable row level security;
alter table place_refs       enable row level security;
alter table saved_places     enable row level security;
alter table usage_counters   enable row level security;
alter table idempotency_keys enable row level security;
