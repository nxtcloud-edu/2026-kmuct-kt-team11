-- A global events feed: popups and performances that are the same for everyone.
--
-- WHY THIS IS NOT `places`, AND NOT `saved_places`.
--
-- `places` has no concept of a period. A café is open until it closes down; a
-- popup runs 9.12–10.11 and then it is over, and a row that cannot say so would
-- keep recommending a shop that no longer exists. `saved_places` is the opposite
-- problem: every row there is owned by a `user_id`, and these listings are not
-- owned by anybody — the same five popups are shown to every account, scraped
-- once a week, and nobody's copy differs. Hanging them off a user would store
-- the same five rows once per account and make "what is on this week" a query
-- per user instead of a query.
--
-- So: a third thing. Global, periodic, read-only to the app, and joined to
-- `places` by a nullable `place_id` when — and only when — we could work out
-- where it actually is.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TERMS OF SERVICE, STATED PLAINLY BECAUSE THE TWO SOURCES ARE NOT ALIKE.
--
--   popga (https://popga.co.kr/api/spots/search) is a PUBLIC JSON API. No auth,
--   no cookie, no signature; it is the same endpoint the site's own pages call,
--   used the way it is meant to be used, at one request a week. Nothing about
--   this is adversarial.
--
--   yanolja (https://nol.yanolja.com/ticket/genre/*) has NO API. The listings
--   are read out of the React Server Components flight payload embedded in the
--   page — a framework's private serialisation format, parsed without
--   permission. It is not authorised, it is not a contract, and it will break
--   the next time they deploy. It is here because the product needs 공연
--   listings and there is no other way in; whoever maintains this should know
--   that the popga half is durable and the yanolja half is borrowed.
--
-- That asymmetry is why `source` is a column and not an implementation detail:
-- when the yanolja half rots, the query that finds out is `where source =
-- 'yanolja'`, and the popup feed is unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

create table events (
  id         uuid primary key default uuidv7(),

  -- Which scraper wrote this, and that scraper's own id for the listing. The
  -- pair is the identity: popga numbers its spots and yanolja numbers its
  -- products, and the two sequences are unrelated. `source_id` is text rather
  -- than an integer because yanolja's is `26007505:25001547` — a product id and
  -- a place id joined by a colon — and coercing that to a number loses half.
  source     text not null check (source in ('popga', 'yanolja')),
  source_id  text not null,

  -- SIX CATEGORIES, and they are not `places.category`. These describe what KIND
  -- OF OUTING this is, which is the axis a person browsing on a Friday actually
  -- sorts by; `places.category` describes what kind of PREMISES the venue is,
  -- which is the axis a map sorts by. `popup` comes from popga, the other five
  -- are one yanolja genre page each. The mapping between the two vocabularies is
  -- lib/events/types.ts `PLACE_CATEGORY_FOR_EVENT`, and it is lossy on purpose —
  -- see the comment there.
  category   text not null check (
               category in ('popup', 'exhibition', 'play', 'musical', 'concert', 'sports')),

  title      text not null,

  -- The venue as the SOURCE names it: `NOL 유니플렉스 1관`, `충무아트센터 갤러리`.
  -- Kept verbatim and kept even when `place_id` is set, because the source's
  -- name is the one printed on the ticket and `places.name` is whatever Naver
  -- called the building.
  venue      text,

  -- popga gives a street address. yanolja gives a venue name and nothing else —
  -- see `place_status` below for what that costs.
  address    text,

  -- The neighbourhood, for the one line under the title that says WHERE. Taken
  -- from the geocode when the event resolved (`망원동`, `마포구`) and from the
  -- source's own area label when it did not (popga says `성수`, `여의도`). Not
  -- `places.area`'s twin: that column is NOT NULL because a place without a
  -- location is not a place, and this one is nullable because an event without a
  -- location is ordinary — most yanolja records have nothing to put here.
  area       text,

  -- A URL, never an image. Posters are third-party artwork and this repo does
  -- not hold copies of other people's pictures; `next.config.ts` allowlists the
  -- two CDN hosts so `next/image` may fetch them at render time.
  poster_url text,

  -- Where 예매하기 goes. NOT NULL: an event you cannot act on is a dead card, and
  -- a scraper that cannot produce this link should drop the record instead.
  book_url   text not null,

  -- THE RUN. `date`, not `timestamptz`: a popup that closes on the 11th closes
  -- at the end of the 11th in Seoul, and there is no instant to be precise
  -- about. Both nullable because a source occasionally omits one — a permanent
  -- venue with no close date, a listing whose dates have not been announced —
  -- and a missing end date must read as "no known end", never as "ended".
  opens_on   date,
  closes_on  date,

  -- The position this listing held in the source's own ordering when it was
  -- scraped. The feed renders in this order rather than by date, because the
  -- source is already ranking by what it thinks is worth seeing and we have
  -- nothing better; re-sorting by opening date would put every year-round
  -- exhibition above everything happening this weekend.
  rank       integer not null default 0,

  -- ───────────────────────────────────────────────────────────────────────────
  -- THE SAVE PATH, AND WHY IT IS ALLOWED TO BE NULL.
  --
  -- Browsing is global; SAVING IS PERSONAL. Tapping 저장 writes a `saved_places`
  -- row for that user so the event joins their map and their list beside the
  -- places that came out of reels — which means the event has to be a `places`
  -- row first, and `saved_places.place_id` is the only join there is.
  --
  -- Resolution happens ONCE, here, at scrape time, not per user at save time.
  -- Five hundred people saving the same popup must not be five hundred geocodes.
  --
  -- popga carries a street address, so it goes through the same
  -- lib/research/geocode.ts → lib/places.ts `findOrCreatePlace` the reel
  -- pipeline uses. Not a second geocoder and not a second dedupe: design §5.1
  -- calls place identity the highest-bug-density area of the model, and a second
  -- answer to "is this the same venue?" is how a user ends up with one popup
  -- pinned twice. The concrete win is across TIME — this scrape runs weekly and
  -- re-resolves the same listings, so without a shared find-or-create a popup
  -- that runs for six weeks becomes six `places` rows.
  --
  -- YANOLJA EVENTS OFTEN HAVE NO ADDRESS AT ALL — `NOL 유니플렉스 1관` is a hall,
  -- not a location — so many of them will never resolve. That is a designed-for
  -- state, not a failure: an unresolved event still appears in the feed and
  -- still links out to book. It just cannot be pinned on a map, and the screen
  -- says so rather than pretending. Fabricating coordinates to make the save
  -- button light up would put a wrong pin on a user's map forever.
  -- ───────────────────────────────────────────────────────────────────────────
  place_id   uuid references places(id) on delete set null,

  -- WHY there is or is not a `place_id`, kept as a value rather than inferred
  -- from `place_id is null`. "We never tried", "the source gave no address",
  -- "Naver could not find it" and "the geocoder was down" are four different
  -- facts with four different remedies, and collapsing them into one null is how
  -- a transient outage becomes indistinguishable from a venue that genuinely has
  -- no street address. The values are lib/research/resolve-place.ts's
  -- `ResolveFailure` plus the two terminal ones, deliberately spelled the same
  -- so the two paths can be read side by side.
  place_status text not null default 'unresolved' check (
                 place_status in ('unresolved', 'resolved', 'no-address',
                                  'not-found', 'geocode-failed', 'no-area')),

  first_seen_at timestamptz not null default now(),

  -- Advanced by every pass that sees the listing again. The pruner deletes rows
  -- a successful pass did NOT see, so this is what separates "gone from the
  -- source" from "the pass never ran".
  last_seen_at  timestamptz not null default now(),

  unique (source, source_id)
);

-- The one query the feed makes: a category's live listings in source order. The
-- partial predicate cannot live in the index because `current_date` is not
-- immutable, so the date filter is applied on top — at five rows a category the
-- planner has nothing to complain about either way.
create index events_feed_idx on events (category, rank, first_seen_at);

-- The pruner, and "which of these still need geocoding".
create index events_source_seen_idx on events (source, category, last_seen_at);

-- ─────────────────────────────────────────────────────────────────────────────

-- Per-category worker state. Deliberately the SHAPE of `ingest_state`
-- (20260920000008) rather than rows inside it: that table is keyed by `source`
-- and its cursor means "clips shared before this instant are done", which is a
-- high-water mark over an append-only stream. A scrape has no stream and no
-- cursor — it re-reads the same top-N every time — and the thing it must
-- remember instead is whether a category that used to return listings has
-- stopped returning them. Different fact, different table.
--
-- Keyed by CATEGORY and not by source, because that is the granularity that
-- rots: yanolja's five genre pages are five separate scrapes of five separate
-- HTML documents, and /genre/sports going quiet says nothing about
-- /genre/musical. Measured while building this — sports returns zero listings
-- through the same parser that finds 41 musicals, because that page renders a
-- different payload shape entirely. A per-source breaker would have taken the
-- whole of yanolja down over it.
create table event_sources (
  category            text primary key check (
                        category in ('popup', 'exhibition', 'play',
                                     'musical', 'concert', 'sports')),
  source              text not null check (source in ('popga', 'yanolja')),

  -- Stamped BEFORE the request leaves, for the reason lib/ingest/state.ts gives
  -- for `markAttempt`: a cooldown enforced from a timestamp written on the way
  -- OUT is not a cooldown — a pass that hangs or is killed leaves the previous
  -- attempt's time in place and the next invocation is free to go again.
  last_attempt_at     timestamptz,

  -- The last pass that came back with at least one listing. THE 7-DAY COOLDOWN
  -- IS MEASURED AGAINST `last_attempt_at`, not this; see lib/events/state.ts.
  last_ok_at          timestamptz,

  -- ───────────────────────────────────────────────────────────────────────────
  -- "SUCCEEDED, FOUND NOTHING" IS WHAT ROT LOOKS LIKE FROM OUTSIDE.
  --
  -- Design §8: a scrape that returns zero where it previously returned many is
  -- the signature of a dead parser, not of a quiet week, and it must record a
  -- DISTINCT outcome rather than a success with no rows. `empty_after_rows` is
  -- that outcome. It is decidable only because `peak_count` below is durable —
  -- the events themselves are pruned and replaced, so counting rows would say
  -- zero on exactly the pass where zero is the thing under suspicion.
  --
  --   ok                — listings came back.
  --   empty             — zero, and zero is all this category has ever returned.
  --                       True of /genre/sports from the first run.
  --   empty_after_rows  — zero, and this category HAS returned listings before.
  --                       The parser is broken or the page moved. Loud.
  --   failed            — the request itself did not complete.
  --   null              — a pass started and did not finish. Distinct from all
  --                       four above, and the reason the attempt stamp clears
  --                       this column: an interrupted pass must not leave `ok`
  --                       behind and suppress the retry for a week.
  -- ───────────────────────────────────────────────────────────────────────────
  last_outcome        text check (
                        last_outcome in ('ok', 'empty', 'empty_after_rows', 'failed')),
  last_count          integer,
  last_error          text,

  -- The most listings this category has EVER yielded in one pass. Monotonic —
  -- it is the memory that makes `empty_after_rows` distinguishable from `empty`,
  -- and a pass that finds fewer than before must not lower it or the alarm
  -- disarms itself one bad pass at a time.
  peak_count          integer not null default 0,

  -- CIRCUIT BREAKER, same posture as `ingest_state` and for the same reason:
  -- non-null means this category refuses to run until a human clears the column
  -- by hand. There is no expiry and no automatic reset. It trips on the states
  -- that mean a source is refusing us on purpose — 401, 403, 429 — never on a
  -- timeout or a 5xx, which are the vendor having a bad minute. An automated
  -- retry into a source that has just said "no" is how an IP gets blocked.
  breaker_tripped_at  timestamptz,
  breaker_reason      text
);

-- Six rows, seeded, because unlike `ingest_state` this table's key set is fixed
-- and known: six categories, and a seventh would be a migration. Seeding here
-- rather than upserting at runtime means `select * from event_sources` answers
-- "what is the feed made of" on a database where the cron has never run.
insert into event_sources (category, source) values
  ('popup',      'popga'),
  ('exhibition', 'yanolja'),
  ('play',       'yanolja'),
  ('musical',    'yanolja'),
  ('concert',    'yanolja'),
  ('sports',     'yanolja');

-- Same posture as every other table in this schema — see 20260920000001. The
-- Data API must not reach either of these. `events` is globally readable
-- *through the app*, which is not the same as being readable by `anon` over
-- PostgREST: the app decides what a listing looks like on the wire, and an open
-- table is a second, undocumented contract that nothing maintains.
alter table events enable row level security;
revoke all on events from anon, authenticated;

alter table event_sources enable row level security;
revoke all on event_sources from anon, authenticated;
