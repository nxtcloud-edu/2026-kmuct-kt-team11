-- One Instagram id, many Gaja accounts.
--
-- WHAT THIS UNDOES. Migration 20260920000006 made `lower(instagram_handle)`
-- UNIQUE, and lib/ingest/route-sender.ts leaned on that: at most one account
-- could claim a handle, so a DM never had two candidates and routing never had
-- a choice to make.
--
-- WHY IT GOES. The uniqueness was refusing real people. A tester who had never
-- signed up typed their own id and got back `다른 계정에서 이미 연결해 둔
-- 인스타그램 아이디예요` — a 409 from an index, about an account they had no way
-- to see or reach. With several people sharing one test Instagram account, and
-- one person signing in from more than one Gaja account, the constraint models
-- a world this product does not have.
--
-- WHAT IT COSTS, AND IT IS NOT SMALL. A handle is now a claim anybody can make,
-- including about somebody else's account, and `resolveSenderToUser` delivers a
-- shared reel to EVERY account claiming the sender's handle. So a person who
-- types a stranger's id receives that stranger's shared reels — captions,
-- links and all — and nothing warns either of them. Under the old index the
-- squatter at least had to get there first and the victim got an error; now
-- both simply succeed and both get the reels.
--
-- That is accepted deliberately, to make ingestion work for a group of testers
-- sharing accounts. If this product ever has users who are strangers to each
-- other, this migration is the first thing to revisit, and the replacement is
-- the confirmation step docs/gaja/instagram-binding.md describes rather than a
-- return to uniqueness — uniqueness never proved ownership, it only rationed
-- the claim.
drop index if exists users_instagram_handle_lower_idx;

-- Still indexed, just not unique. Every DM does a `lower(instagram_handle) = $1`
-- lookup on this, once per clip, so it is a hot read path and not optional.
create index if not exists users_instagram_handle_lower_idx
  on users (lower(instagram_handle)) where instagram_handle is not null;
