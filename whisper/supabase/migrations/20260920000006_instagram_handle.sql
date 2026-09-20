-- Instagram handle — a claim, never a binding.
--
-- `users.igsid` is the Instagram-Scoped User ID: the identifier Meta itself puts
-- on a signed webhook payload when someone DMs the Gaja account. It is the only
-- proof that a person controls an Instagram account, it is written from that
-- payload and nowhere else, and D3 rests on it.
--
-- `users.instagram_handle` is the opposite kind of thing. A user types it. Anyone
-- can type @koh_min_. It is a HINT: it may narrow a lookup when an unknown igsid
-- arrives, and it may be shown back to its owner so they can check their own
-- typing. It must never, on its own, bind an igsid to an account or route an
-- incoming DM into one.
--
-- That distinction is not theoretical. `users.email` was exactly this shape until
-- 2026-09-20: a column anyone could write with no proof of ownership, which one
-- request could use to pre-claim a stranger's address. lib/social-identity.ts
-- (claimUnverifiedRow) is the repair. This column is the same defect class under
-- a new name, and `instagram_linked_at` below is what keeps the two apart.
--
-- The binding rule is written down in docs/gaja/instagram-binding.md.

alter table users
  -- Stored WITHOUT the leading '@' and lowercased. Instagram treats handles as
  -- case-insensitive, so storing the user's capitalisation would let @KohMin and
  -- @kohmin both exist here while being one account over there.
  --
  -- 1–30 characters of [a-z0-9._] — Instagram's own alphabet, minus the case that
  -- normalisation already removed. The API validates the same shape in zod so a
  -- typo is a 422 naming the field rather than a 500 from a constraint.
  add column instagram_handle text
    constraint users_instagram_handle_shape
    check (instagram_handle ~ '^[a-z0-9._]{1,30}$'),

  -- When an igsid was actually bound to this account, from a signed webhook
  -- payload plus a confirmation made inside a signed-in Gaja session.
  --
  -- NULL is the important value: it means the handle above is still nothing but
  -- a claim. Anything that routes a DM reads igsid; anything that asks "is this
  -- account's Instagram real?" reads this.
  add column instagram_linked_at timestamptz,

  -- The rule, as a database rule rather than a convention someone can forget.
  -- A linked-at timestamp without an igsid would mean "we bound an account we
  -- have no identifier for", which is precisely the state a typed handle must
  -- not be able to reach. The reverse is allowed: an igsid may exist without a
  -- timestamp, because slice 3 may write igsid on accounts that never claimed a
  -- handle at all.
  add constraint users_instagram_linked_requires_igsid
    check (instagram_linked_at is null or igsid is not null);

-- DUPLICATE CLAIMS: REFUSED AT THE DATABASE, not accepted and flagged.
--
-- The case for accept-and-flag is real. Refusing means the first person to type
-- a handle holds it against everyone else, including the person who actually owns
-- it on Instagram — a squatter costs nothing to be and blocks a real user forever.
-- With a flag instead, both rows survive and the eventual igsid decides.
--
-- Refusal wins here for two reasons.
--
-- 1. What a squatter wins is nothing. The handle routes no DM, receives no reel
--    and grants no access; `instagram_linked_at` stays null and `igsid` is still
--    only ever written from a payload Meta signed. Holding a handle here is
--    holding a hint. Holding it in a schema where duplicates are tolerated is
--    worse, because then two accounts are candidates for the same incoming DM and
--    somebody downstream has to pick one — which is the silent resolution this
--    whole design exists to prevent.
--
-- 2. "Forever" is not true, and it is the part to keep true. A claim with
--    `instagram_linked_at is null` has proven nothing and is therefore disposable:
--    when the real owner arrives with a verified igsid, the unbound claim is
--    cleared and theirs is written. A BOUND row is the one that may not be taken.
--    That eviction path is deliberately not built here — it belongs with the
--    webhook, and the doc says so — but the schema is shaped so it stays possible.
--
-- Detection, which the design requires, comes from the refusal itself: the second
-- claimant gets a 409 (lib/route.ts maps this index name), not a silent merge.
--
-- lower() is belt and braces. The CHECK above already forbids uppercase, so today
-- this index and a plain unique on the column are the same thing. It is written
-- this way so that relaxing the CHECK later cannot quietly reopen @KohMin vs
-- @kohmin as two rows.
create unique index users_instagram_handle_lower_idx
  on users (lower(instagram_handle)) where instagram_handle is not null;

-- No RLS or grant statements here. These are columns on `users`, which already
-- has row level security enabled and every anon/authenticated grant revoked by
-- 20260920000001. Columns inherit the table's posture; only a NEW TABLE needs the
-- two lines that migration established.
