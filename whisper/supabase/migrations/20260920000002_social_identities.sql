-- Social sign-in identities.
--
-- Supabase Auth is used as an identity provider only: it verifies that the
-- person controls a Google or Kakao account and hands back a stable subject id.
-- Gaja's own `sessions` table still issues the session, so `lib/session.ts`,
-- the __Host- cookie and every route's authorization are untouched.
--
-- Shaped like `place_refs`: an external (source, source_id) pair resolving to a
-- local row, so one Gaja account can accumulate several ways in — Instagram,
-- email, Google, Kakao — which is exactly D3's recovery-channel model.

create table auth_identities (
  provider     text not null check (provider in ('google', 'kakao', 'apple')),
  provider_uid text not null,
  user_id      uuid not null references users (id) on delete cascade,
  -- The address the provider asserted at link time, kept for support and for
  -- noticing when someone's provider email later diverges from users.email.
  email        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  -- One identity resolves to exactly one account. Re-authenticating with the
  -- same Google account can therefore never fork into a second Gaja user.
  primary key (provider, provider_uid)
);

create index auth_identities_user_idx on auth_identities (user_id);

-- A user may link a provider only once, so "sign in with Google" is never
-- ambiguous about which identity it should update.
create unique index auth_identities_one_per_provider_idx
  on auth_identities (user_id, provider);

-- Same posture as every other table: the Data API must not reach this. See
-- 20260920000001. Without it, the table created here would be public.
alter table auth_identities enable row level security;
revoke all on auth_identities from anon, authenticated;
