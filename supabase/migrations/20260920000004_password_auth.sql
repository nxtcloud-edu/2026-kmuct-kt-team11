-- Password sign-in.
--
-- This OVERRIDES D3 in docs/superpowers/specs/2026-09-18-gaja-design.md, which
-- settled that identity is the IG-scoped user id and that "the DM is password
-- reset". Passwords are added at the user's direction; the spec is amended in
-- the same commit so the record and the code agree.
--
-- Passwords sit ALONGSIDE magic links rather than replacing them. That is what
-- gives password reset for free — the magic link already proves the person
-- controls the address — and it is what keeps slice 3 possible, where an
-- Instagram user arrives with an igsid and no email at all.

alter table users
  -- Nullable, and most rows will stay null: every account that exists today was
  -- born from a magic link and has no password. A null here is not a missing
  -- value, it is an account that uses a different way in.
  add column password_hash text,
  add column password_set_at timestamptz;

-- Failed sign-ins, for throttling. Keyed by email rather than user_id because
-- the throttle has to work for addresses that do not exist — otherwise the
-- rate limit itself becomes the enumeration oracle that `POST /auth/magic-link`
-- returning a flat 202 was written to avoid.
create table login_attempts (
  id           uuid primary key default uuidv7(),
  email        text not null,
  succeeded    boolean not null,
  attempted_at timestamptz not null default now()
);

-- Supports "how many failures for this address in the last 15 minutes", which
-- is the only question ever asked of this table.
create index login_attempts_email_time_idx
  on login_attempts (email, attempted_at desc) where not succeeded;

-- Same posture as every other table here: the Data API must not reach it. See
-- 20260920000001. Without this the table would be world-readable, and a table
-- of email addresses plus failure counts is worth more to an attacker than most.
alter table login_attempts enable row level security;
revoke all on login_attempts from anon, authenticated;
