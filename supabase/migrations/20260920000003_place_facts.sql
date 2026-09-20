-- Slice 2 — Research cache (partial).
-- Source of truth: docs/superpowers/specs/2026-09-18-gaja-design.md §5.3
--
-- The output side of place research: one row per place holding the fused facts
-- layer 2 produced from one or more `SourceFacts` (lib/research/source-facts.ts).
--
-- Scope of THIS migration: the table only. The PlaceSource adapters, the fusion
-- code, and the LLM digest are application code, not schema.

-- ── Research cache ──────────────────────────────────────────────────────────
-- One row per place. `place_id` is the PK: research is cached per resolved place,
-- not per source — provenance lives inside the row (`rating` per source,
-- `source_trace`), so a place never has two competing place_facts rows.

create table place_facts (
  place_id      uuid primary key references places(id) on delete cascade,
  fetched_at    timestamptz not null default now(),
  -- Re-fetch boundary. Layer 2 skips a place whose ttl_until is still in the
  -- future; a background refresh renews it. Hours change rarely, so this keeps
  -- us off the source most of the time.
  ttl_until     timestamptz not null,

  -- Per-weekday hours incl. break time and last order. Shape: WeeklyHours.
  hours         jsonb,
  -- Regular + irregular (공휴일, 임시휴무). Shape: ClosedDays.
  closed_days   jsonb,
  -- ₩ | ₩₩ | ₩₩₩ + typical per-person KRW. Graded by layer 2 from price hints.
  price_band    text,

  -- Rating PER SOURCE, never averaged across sources (§5.3):
  --   { "naver": 4.49, "google": 4.5 }
  -- Averaging would erase that naver and google measure different populations.
  rating        jsonb,

  -- LLM-produced digest. Shape in §5.3: { wait, vibe, warnings }.
  review_digest jsonb,

  -- True when at least one intended source failed or a field could not be
  -- filled — the UI shows partial data honestly rather than pretending.
  degraded      boolean not null default false,

  -- A product requirement, not bookkeeping (§5.3): which source asserted which
  -- field, and when. Powers "영업시간 네이버 기준, 2시간 전 확인" in the UI and
  -- tells the validator which value it trusted.
  --   { "hours": { "source": "naver", "at": "2026-09-20T02:30:25Z" }, ... }
  source_trace  jsonb not null default '{}'::jsonb,

  updated_at    timestamptz not null default now()
);

-- Background refresh scans for expired rows; this keeps that a range scan.
create index place_facts_ttl_idx on place_facts (ttl_until);

-- Lock down the Data API surface exactly as 20260920000001 does for every other
-- table: this table is reached only through lib/db.ts as the owner role, so anon
-- / authenticated get nothing, and RLS-with-no-policies stops a future grant
-- from silently reopening it.
revoke all on place_facts from anon, authenticated;
alter table place_facts enable row level security;
