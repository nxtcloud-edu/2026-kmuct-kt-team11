-- Split the reel out of `saved_places`.
--
-- Source: docs/gaja/reel-extraction-findings.md — "One reel is ten saved places."
-- A real shared reel was observed carrying TEN venues in one caption, each with a
-- name, an address and opening hours. `saved_places` could not represent that:
-- one row carried both the REEL's data (reel_video_id, source_url, raw_caption,
-- extracted) and the PLACE's data (place_id, hook, status), and
-- `unique (user_id, reel_video_id)` therefore allowed exactly one place per reel
-- per user. The listicle was not a hard case for the schema; it was forbidden by it.
--
-- The fix is a parent table rather than a wider index. Widening the index to
-- include place_id would let N rows exist, but it would also keep N copies of the
-- same caption, the same source_url and the same extraction status — and leave no
-- answer to "has this reel been extracted yet?" that did not mean reading ten rows
-- and hoping they agree.

create table reels (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users(id) on delete cascade,
  reel_video_id text not null,
  source_url    text,
  raw_caption   text,
  extracted     jsonb,
  -- The extractor's state machine, not the place's. `saved_places.status` keeps
  -- its own vocabulary (pending/resolved/needs_review/rejected) because a venue
  -- can be rejected by the user while the reel it came from extracted perfectly.
  status        text not null default 'pending'
                check (status in ('pending','extracted','needs_review','failed')),
  shared_at     timestamptz not null default now(),
  -- The constraint that used to sit on saved_places, now on the table it actually
  -- describes: a user shares a given reel once. On saved_places it meant "a user
  -- saves one place per reel", which was never the intent — it was the intent's
  -- shadow, cast by storing two entities in one row.
  unique (user_id, reel_video_id)
);

create index reels_user_idx on reels (user_id, shared_at desc, id desc);

-- Same posture as every other table: the Data API must not reach this. See
-- 20260920000001. Without it, the table created here would be public.
alter table reels enable row level security;
revoke all on reels from anon, authenticated;

-- ── saved_places becomes the child ───────────────────────────────────────────
-- `reel_id` and `ordinal` are DATABASE-ONLY for now. Neither appears in
-- lib/api/types.ts or docs/gaja/openapi.yaml, and deliberately so: nothing
-- consumes them yet, and a field in a published contract is a promise to keep it.
-- They go on the wire when the extractor gives a client a reason to read them.

alter table saved_places
  add column reel_id uuid references reels(id) on delete cascade,
  -- The venue's position in the reel's list, 1-based — `2.📍우이그` is ordinal 2.
  -- Null for hand-entered rows, which have no list to be second in. smallint
  -- because a caption that numbers past 32767 entries is not a caption.
  add column ordinal smallint;

-- BACKFILL IS A NO-OP, and that is measured, not assumed. Before this migration
-- ran: 52 rows in saved_places, and count() over each of the four moving columns
-- returned 0 — every one of them null in every row. Nothing is carried across and
-- nothing is lost by the drops below. Do not read the absence of an UPDATE here as
-- an oversight.

-- The constraint this whole migration exists to remove. Live name confirmed
-- against pg_constraint rather than guessed: Postgres derives it from the column
-- list, so it is stable, but a rename upstream would make this a silent no-op if
-- written with IF EXISTS.
alter table saved_places drop constraint saved_places_user_id_reel_video_id_key;

alter table saved_places
  drop column reel_video_id,
  drop column source_url,
  drop column raw_caption,
  drop column extracted;

-- One row per position in a reel. Partial because hand-entered rows have neither
-- column, and Postgres treats NULLs as distinct — without the predicate the index
-- would be dead weight over 52 all-null rows today and misleading later.
create unique index saved_places_reel_ordinal_idx
  on saved_places (reel_id, ordinal)
  where reel_id is not null and ordinal is not null;

-- "Give me this reel's venues" — the extractor's own read, and the join that
-- SAVED_PLACE_SELECT now makes on every list page to recover source_url.
create index saved_places_reel_idx on saved_places (reel_id)
  where reel_id is not null;

-- `saved_places_no_duplicate_idx` is deliberately untouched. It still stops a user
-- saving the same place into the same group twice, and now also stops the same
-- venue arriving twice from two different reels — which is the more likely
-- duplicate once listicles are being parsed.
