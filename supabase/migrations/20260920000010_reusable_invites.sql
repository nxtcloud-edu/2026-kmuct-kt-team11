-- An invite link stops being a ticket and becomes a door.
--
-- 20260918000001 shipped `group_invites` with `used_by`/`used_at` and the accept
-- route guarded on `used_at is null`: the first person through burned the link
-- for everyone behind them. That is the wrong model for how these links are
-- actually moved around. A Gaja invite is pasted into a KakaoTalk 단톡방 with
-- four people in it, and three of them get an error that says the invite was
-- "already used" — by someone standing in the same room. Jakob's Law: every
-- comparable product (KakaoTalk, Discord, Notion, Slack) treats one link as one
-- door that many people walk through, and a user's expectation is built there,
-- not here.
--
-- WHAT STAYS. The table, the 7-day `expires_at`, and — load-bearing — the fact
-- that only `token_hash` is stored. The raw token exists in exactly two places:
-- the creation response, and the URL in the sharer's hands. Nothing added below
-- weakens that, which is also why there is no "show me the group's current
-- link" endpoint: we cannot reconstruct a token we only ever hashed, and adding
-- a column to make it possible would be trading the one property that makes a
-- database read survivable.
--
-- WHAT CHANGES, and why each piece is here:
--
--   `id`          — a public handle. Revoking an invite from a screen needs to
--                   name one, and the name cannot be `token_hash`: a SHA-256 of
--                   the token is not reversible, but handing it out lets anyone
--                   holding a *candidate* token confirm it offline against a
--                   list. A random uuid says nothing about the secret.
--
--   `revoked_at`  — the replacement for single use. Expiry alone is a 7-day
--                   window you cannot close early; a link that got pasted into
--                   the wrong room needs a switch, and "revoke" is the control
--                   that makes a reusable link safe to hand out at all.
--
--   `revoked_by`  — who closed it. Any member may create an invite, so any
--                   member's link may need closing by someone else.
--
--   `group_invite_uses` — the audit trail. Dropping `used_by` without this
--                   would mean a group could gain five members with no record
--                   of which link admitted them, which is strictly less than
--                   the single-use table knew. One row per (invite, joiner)
--                   turns the same fact into a one-to-many, and the composite
--                   primary key makes re-walking through a door a no-op rather
--                   than a duplicate.
--
-- Joining is now an insert into `group_members` that is idempotent for someone
-- already inside, and the invite row itself is never mutated by an accept.

alter table group_invites
  add column id         uuid not null default gen_random_uuid(),
  add column revoked_at timestamptz,
  add column revoked_by uuid references users(id);

-- Unique rather than a second primary key: `token_hash` stays the identity the
-- accept path looks up by, because that path has the token and nothing else.
create unique index group_invites_id_idx on group_invites (id);

-- The invite sheet lists a group's live links on every open, so the predicate
-- it filters by belongs in the index rather than on top of it.
create index group_invites_live_idx
  on group_invites (group_id, created_at desc)
  where revoked_at is null;

create table group_invite_uses (
  token_hash text        not null references group_invites(token_hash) on delete cascade,
  user_id    uuid        not null references users(id) on delete cascade,
  used_at    timestamptz not null default now(),

  -- The idempotency of a join, expressed once, in the only place that can
  -- actually enforce it. A member who reopens the link inserts nothing new.
  primary key (token_hash, user_id)
);

-- "Which invites has this person walked through" — asked when a member is
-- removed and someone wants to know how they got in.
create index group_invite_uses_user_idx on group_invite_uses (user_id);

-- Carry forward what the single-use columns already knew. `used_by` is nullable
-- and `used_at` is set with it, so the filter is on the pair; without it the
-- history of every group that already has a joiner would be erased by the drop
-- two statements below, which is exactly the downgrade this migration exists to
-- avoid.
insert into group_invite_uses (token_hash, user_id, used_at)
select token_hash, used_by, coalesce(used_at, created_at)
  from group_invites
 where used_by is not null
on conflict do nothing;

alter table group_invites
  drop column used_by,
  drop column used_at;

-- Same posture as every other table in this schema — see 20260920000001. The
-- Data API must not reach either of these: one holds the hashes that admit
-- people to a group, the other holds who was admitted.
alter table group_invite_uses enable row level security;
revoke all on group_invite_uses from anon, authenticated;
