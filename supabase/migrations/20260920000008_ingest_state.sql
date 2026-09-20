-- Where an ingest source left off, and whether it is allowed to run at all.
--
-- One row per source, keyed by the source's own name. The swappable seam in
-- lib/ingest/inbox/index.ts means there will be more than one: the Instagram
-- poller today, a Meta Messaging API webhook later. They do not share a cursor —
-- a webhook has nothing to resume from — so the key is the source, not the
-- product.
--
-- WHY A CURSOR, GIVEN `reels` ALREADY HAS `unique (user_id, reel_video_id)`.
-- That index dedups WRITES, and only writes. The ingest path drops a clip from a
-- sender it cannot route (lib/ingest/route-sender.ts: unrecognised sender = drop,
-- nothing is stored), so a dropped clip leaves no row for the index to match
-- against. The inbox keeps returning it, the poller keeps dropping it, forever,
-- and every pass re-reads and re-drops the same backlog — at a fixed per-pass
-- cost that only grows. The cursor is the only record that a clip was *seen*,
-- which is a different fact from a clip being *saved*.

create table ingest_state (
  source              text primary key,

  -- The high-water mark: every clip shared at or before this instant has been
  -- through a pass. Advanced only after a pass with zero failures, so a transient
  -- error replays its clips rather than skipping them — `unique (user_id,
  -- reel_video_id)` on `reels` is what makes that replay harmless.
  cursor_at           timestamptz,

  -- CIRCUIT BREAKER. Non-null means the source is refusing to run and will keep
  -- refusing until a human clears this column. There is no expiry and no
  -- automatic reset on purpose: the states that trip it — 401, 429,
  -- challenge_required, checkpoint_required — are Instagram telling us the
  -- account is already under scrutiny, and an automatic retry after a challenge
  -- is the behaviour that gets a real account banned. A tripped breaker is a
  -- page, not a backoff.
  breaker_tripped_at  timestamptz,
  breaker_reason      text,

  -- When a pass last completed without failing a clip. Diagnostics only; nothing
  -- branches on it.
  last_ok_at          timestamptz,
  last_error          text,

  -- Every attempt, including ones that failed, which is why this is not
  -- `last_ok_at`. The poller enforces its minimum interval against this column,
  -- and a floor measured from the last SUCCESS would let a failing source retry
  -- without limit — precisely the tight loop the interval exists to prevent.
  -- Persisted rather than held in memory because each serverless invocation is a
  -- fresh process and an in-process timer would reset on every cold start.
  last_attempt_at     timestamptz
);

-- Same posture as every other table: the Data API must not reach this. See
-- 20260920000001. Without it, the table created here would be public — and this
-- one holds the switch that decides whether we talk to Instagram at all.
alter table ingest_state enable row level security;
revoke all on ingest_state from anon, authenticated;
