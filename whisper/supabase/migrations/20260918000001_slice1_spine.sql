-- Slice 1 — Spine.
-- Source of truth: docs/superpowers/specs/2026-09-18-gaja-design.md §5.1, §5.2
-- Contract: docs/gaja/api-contract.md
--
-- Scope: identity, groups, places, hand-entered saved places.
-- No Instagram, no scraping, no pipeline. place_facts / preference_signals /
-- itineraries belong to slices 2 and 4 and are deliberately absent.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- UUIDv7: time-sortable, keeps index locality, does not leak row counts.
-- A Type 1 decision (api-contract.md §2) — changing it rewrites every FK and URL.
-- Postgres 18 ships uuidv7() natively; this is the portable implementation for 15/16/17.
create or replace function uuidv7() returns uuid
language plpgsql parallel safe as $$
declare
  unix_ts_ms bytea;
  uuid_bytes bytea;
begin
  unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  -- version 7
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  -- variant 10xx
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10'   || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  return encode(uuid_bytes, 'hex')::uuid;
end $$;

-- ── Users ─────────────────────────────────────────────────────────────────────
-- D3: identity is the IG-scoped user ID; igsid is nullable; every account needs
-- at least one recovery channel. The CHECK is what makes that a rule rather than
-- a convention, and it is what DELETE /api/me/email surfaces as a 409.

create table users (
  id                        uuid primary key default uuidv7(),
  display_name              text not null,
  avatar_url                text,
  email                     text unique,
  email_verified_at         timestamptz,
  igsid                     text unique,
  locale                    text not null default 'ko' check (locale in ('ko','en')),
  home_area                 text,
  profile_visible_in_groups boolean not null default true,
  plan                      text not null default 'free',
  created_at                timestamptz not null default now(),
  last_active_at            timestamptz not null default now(),
  constraint users_recovery_channel_required
    check (igsid is not null or email is not null)
);

-- ── Magic links ───────────────────────────────────────────────────────────────
-- Single-use, 15 minute expiry (api-contract.md, open decision #3 resolved).
-- The token is stored hashed: a leaked database read must not yield usable links.
-- `intent` carries the D3 dual semantics; the outcome is still decided at exchange
-- time by whether a session is present.

create table magic_links (
  id         uuid primary key default uuidv7(),
  token_hash text not null unique,
  email      text not null,
  intent     text not null check (intent in ('sign_in','link')),
  user_id    uuid references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index magic_links_email_created_idx on magic_links (email, created_at desc);

create table sessions (
  id          uuid primary key default uuidv7(),
  token_hash  text not null unique,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

-- ── Groups ────────────────────────────────────────────────────────────────────
-- D5: a date itinerary is a two-person artifact. `groups.kind` is deliberately
-- absent — party composition comes from itineraries.for_members in slice 2.

create table groups (
  id         uuid primary key default uuidv7(),
  name       text not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table group_members (
  group_id  uuid not null references groups(id) on delete cascade,
  user_id   uuid not null references users(id)  on delete cascade,
  role      text not null check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on group_members (user_id);

-- A group must always have an owner. `409 last-owner` is the API surface of this.
create unique index group_members_one_owner_idx
  on group_members (group_id) where role = 'owner';

create table group_invites (
  token_hash text primary key,
  group_id   uuid not null references groups(id) on delete cascade,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  used_by    uuid references users(id),
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index group_invites_group_idx on group_invites (group_id);

-- ── Geo helpers ───────────────────────────────────────────────────────────────
-- Plain SQL rather than the earthdistance/cube extensions: two functions are less
-- surface than two extensions, and slice 1 only needs "is this within ~50 m".

create or replace function earth_distance_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision language sql immutable parallel safe as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- Bounding-box prefilter so the index on (lat, lng) can be used before the
-- trigonometry runs. A bare haversine over every row is a sequential scan.
create or replace function earth_box_contains(
  center_lat double precision, center_lng double precision, radius_m double precision,
  lat double precision, lng double precision
) returns boolean language sql immutable parallel safe as $$
  select lat between center_lat - (radius_m / 111320.0)
                 and center_lat + (radius_m / 111320.0)
     and lng between center_lng - (radius_m / (111320.0 * cos(radians(center_lat))))
                 and center_lng + (radius_m / (111320.0 * cos(radians(center_lat))))
     and earth_distance_m(center_lat, center_lng, lat, lng) <= radius_m;
$$;

-- ── Places ────────────────────────────────────────────────────────────────────
-- §5.1: the same café has four identities. If they do not collapse the user sees
-- duplicates and the planner double-books. `area` is client-supplied in slice 1
-- (no geocoder until slice 2's Kakao adapter) and becomes server-resolved later.

create table places (
  id         uuid primary key default uuidv7(),
  name       text not null,
  name_alt   text[] not null default '{}',
  category   text not null check (category in ('cafe','restaurant','exhibition','shop','activity')),
  lat        double precision not null check (lat between -90 and 90),
  lng        double precision not null check (lng between -180 and 180),
  address    text,
  area       text not null,
  created_at timestamptz not null default now()
);
create index places_area_idx on places (area);
-- Supports the ~50 m + fuzzy-name dedupe at the write boundary (POST /api/places).
create index places_name_trgm_idx on places using gin (name gin_trgm_ops);
create index places_latlng_idx on places (lat, lng);

create table place_refs (
  place_id  uuid not null references places(id) on delete cascade,
  source    text not null check (source in ('naver','kakao','google')),
  source_id text not null,
  url       text,
  primary key (source, source_id)
);
create index place_refs_place_idx on place_refs (place_id);

-- ── Saved places ──────────────────────────────────────────────────────────────
-- §5.2: the row is created at ack time with status='pending', before extraction,
-- so a crash in the extractor can never lose a reel the user already sent.
-- Slice 1 has no extractor, so hand-entered rows are born 'resolved'.
-- There is NO review_queue table — the admin queue is status='needs_review'.

create table saved_places (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users(id)  on delete cascade,
  group_id      uuid references groups(id)          on delete set null,
  place_id      uuid references places(id)          on delete set null,
  reel_video_id text,
  source_url    text,
  raw_caption   text,
  extracted     jsonb,
  hook          text,
  status        text not null default 'pending'
                check (status in ('pending','resolved','needs_review','rejected')),
  confirmed     boolean not null default true,
  saved_at      timestamptz not null default now(),
  unique (user_id, reel_video_id)
);

-- Keyset pagination index — (saved_at desc, id desc) is the cursor's sort order.
create index saved_places_user_cursor_idx on saved_places (user_id, saved_at desc, id desc);
create index saved_places_group_cursor_idx on saved_places (group_id, saved_at desc, id desc)
  where group_id is not null;

-- api-contract.md §6.4, open decision #1, resolved here as a database guarantee
-- rather than an application check. `unique (user_id, reel_video_id)` does NOT
-- constrain hand-entered rows because Postgres treats NULLs as distinct, so a
-- user could otherwise save the same place by hand twice. Application-level was
-- enough for one writer; it is not once slice 3 writes concurrently, and adding
-- it now costs nothing.
create unique index saved_places_no_duplicate_idx
  on saved_places (user_id, place_id, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'rejected' and place_id is not null;

-- ── Metering seam ─────────────────────────────────────────────────────────────
-- §13. Nothing meters in slice 1; the table exists so slice 2 does not need a
-- migration on a table that already has rows.

create table usage_counters (
  user_id uuid not null references users(id) on delete cascade,
  period  text not null,
  unit    text not null check (unit in ('extraction','planning_run')),
  count   integer not null default 0,
  primary key (user_id, period, unit)
);

-- ── Idempotency ───────────────────────────────────────────────────────────────
-- api-contract.md §4. One store, 24h retention for client keys. Slice 3's `mid`
-- dedupe and slice 2's planning key reuse this table rather than inventing their
-- own mechanism.

create table idempotency_keys (
  key          text not null,
  user_id      uuid references users(id) on delete cascade,
  fingerprint  text not null,
  status_code  integer not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  primary key (key, user_id)
);
create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);
