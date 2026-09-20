# Gaja — discovery design

**Status:** design · 2026-09-20
**Scope:** browse-by-area recommendations, sourced from Instagram reels and enriched
by Naver blogs, crawled in response to what users save.
**Parent spec:** `docs/superpowers/specs/2026-09-18-gaja-design.md`. Decisions there are
inherited, not re-litigated. The course generator is a **separate spec** and is out of
scope here; this one stops at "places worth showing, grouped by area".

## 1. Problem

Ingestion works. A reel shared to the account is routed to its sender's account, its
caption is parsed, its venues are geocoded and resolved to `places` rows, and its
thumbnail is stored. Verified end to end on two real reels: eleven venues, correct
coordinates, correct 동.

Every one of those venues arrived because **a user personally shared a reel about it**.
That is the whole catalogue. A user who has saved two places has a two-place app, and a
user who has saved none has an empty one. Nothing in the product can suggest a venue
the user did not already know about.

Discovery is the answer to "what else is around here", and it is what makes the app
useful before the user has done any work.

## 2. What this is not

**Not the course generator.** This spec produces *places grouped by area*. Sequencing
them into a day — opening hours, travel time, budget, companion fit — is a different
problem with different failure modes, and it gets its own spec.

**Not a ranking system.** Order is recency plus `place_facts` confidence. No
personalisation, no MBTI weighting, no learned relevance. Those are course-generator
concerns and adding them here would couple two specs that should stay separable.

**Not a general web crawler.** The crawl is bounded by what users save (§5) and by an
explicit budget (§8). It does not attempt coverage of Seoul.

## 3. Settled decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Browse by area is a standalone surface**, crawled ahead of demand | Chosen over gap-filling-only. The app has to be worth opening before a user has saved anything, and a discovery screen is the only thing in the product that works on day one. |
| D2 | **The crawl is triggered by what a user saves**, never by geography | A user who saves a 강남 reel makes 강남 worth crawling. This keeps the Apify bill proportional to real users instead of to Seoul's 25 구, and — critically — the work happens at ingest, when nobody is waiting. Crawling on first *view* would put a multi-second Apify run on the exact screen meant to sell the product. |
| D3 | **상권 is the unit**, with a `동 → 상권` map and `구` as fallback | The geocoder already returns 동 (`망원동`, `후암동`) for free, but a single 동 is too thin to fill a screen and a 구 spans 6km, which breaks the walkability the course generator will later need. 상권 (`망원`, `성수`, `홍대`) is how Seoul is actually talked about and how reels are captioned. |
| D4 | **Reels are the source; blogs enrich** | The caption parser exists, is proven on real data, and produced ten venues with addresses and hours from one caption. A second extraction path for blog prose is a second thing to maintain and a second thing to break. Blogs add wait times and vibe to places already found, which is exactly what `place_facts` and the wait-digest spec were built for. |
| D5 | **Discovered places go into `places`**, not a new table | `places` is already the canonical venue record, already carries `area`, and already has the ~50m + fuzzy-name dedupe in `findOrCreatePlace`. A venue discovered in 성수 and later saved by a user must be **one row**. Provenance lives in `place_facts`. |
| D6 | **`saved_places` is untouched** | A discovered place has no user. Browse reads `places` directly; saving one goes through the existing path and creates the join row then. |
| D7 | **The crawl source sits behind an interface**, like `InboxSource` | Apify actors are community-maintained and will break when Naver or Instagram change. The failure must be swappable and contained, not spread through the crawler. |
| D8 | **Creator attribution is stored and displayed** | These are strangers' reels shown to users who never asked for them. The `@handle` travels with the thumbnail and appears on the card. A discovery feed that strips attribution is laundering, not curating. |

## 4. Architecture

Discovery is the ingest pipeline pointed at a different source. Almost none of it is
new code.

```
 user saves a reel
        │
        ├─ resolve places → geocoder returns area (망원동)          [EXISTS]
        │                          │
        │                   동 → 상권  (망원)                        [NEW]
        │                          │
        │                   enqueue crawl for 망원                   [NEW]
        ▼
 crawl worker (cron)
        │
        ├─ Apify Instagram by 상권 hashtag + location               [NEW]
        ├─ reel captions  → lib/extract/caption.ts                   [EXISTS]
        ├─ addresses      → lib/research/geocode.ts                  [EXISTS]
        ├─ dedupe + write → lib/places.ts findOrCreatePlace          [EXISTS]
        └─ provenance     → place_facts                              [EXISTS]
        ▼
 /discover/[area]  →  select from places where area in (…)           [NEW]
```

```
lib/discovery/
  areas.ts        동 → 상권 map, 구 fallback, 상권 → 동[] reverse lookup
  source.ts       DiscoverySource interface  (the D7 seam)
  apify.ts        ApifyInstagramSource — the only code that knows Apify exists
  crawl.ts        orchestration: source → extract → geocode → resolve → facts
  queue.ts        enqueue / claim / complete, over area_crawls
supabase/migrations/
  …_area_crawls.sql
app/(app)/discover/[area]/page.tsx
app/api/internal/discover/crawl/route.ts   CRON_SECRET-guarded, like the poller
```

**Boundaries.** `crawl.ts` owns sequencing and nothing else, the same way `ladder.ts`
owns rung order — changing what a crawl does is a one-file change. `apify.ts` is the
only module that imports the Apify client or knows an actor id, so replacing the vendor
touches one file. `areas.ts` is pure data plus two lookups and is testable with no
network and no database.

## 5. The trigger

At the end of a successful ingest, every resolved place contributes its `area` (a 동).
Each distinct 동 maps to a 상권; each distinct 상권 is enqueued.

This runs **after** `saveReel` commits and in its own failure domain, exactly like
thumbnail capture. A queue write that fails must not cost the user their reel.

Enqueue is idempotent and respects a cooldown (§8): a 상권 already crawled inside the
cooldown window is not re-enqueued, so a user saving five 망원 reels in a row produces
one crawl, not five.

## 6. Areas

`areas.ts` holds a hand-written `동 → 상권` map covering the areas reels actually
feature — roughly forty entries to start. It is data, not logic, and is expected to be
edited often.

Rules, in order:

1. A 동 present in the map resolves to its 상권.
2. A 동 absent from the map falls back to its 구, used as a 상권 of last resort.
3. A place outside Seoul (기로띠, verified, resolves to `남동` in 용인) has no 상권 and
   is **not** enqueued. Discovery is Seoul-first; a 경기 venue still saves and still
   shows on the user's own list, it just does not trigger a crawl.

Edge 동 genuinely belong to two 상권 (연남동 reads as both 연남 and 홍대). The map
assigns exactly one, because a place appearing in two discovery feeds is more confusing
than a place appearing in the less obvious of the two.

## 7. The crawl

```ts
interface DiscoverySource {
  findReels(area: Area, limit: number): Promise<DiscoveredReel[]>;
}

type DiscoveredReel = {
  shortcode: string;
  caption: string | null;
  ownerHandle: string | null;   // D8 — travels to the card
  thumb: { url: string; width: number; height: number } | null;
  postedAt: Date | null;
};
```

Each reel's caption goes through `extractPlacesFromCaption`, each candidate through
`resolvePlaceCandidates`, each resolved place through `findOrCreatePlace`. That is the
same chain the DM path runs, which is the point: one extraction path, one dedupe, one
set of bugs.

**Category.** `places.category` is NOT NULL with a five-value CHECK and a caption never
states one. The extraction call classifies it and returns a confidence; a low-confidence
classification lands the place in `needs_review` rather than forcing a guess into a
column that reads as fact. This is the same rule the DM path uses and the same reason
`hours_raw` is stored unparsed.

**Attribution.** `ownerHandle` is recorded with the place's provenance in `place_facts`
and rendered on the discovery card.

## 8. Cost and failure

The two ways this goes wrong are an unbounded bill and a silently dead scraper. Both get
explicit state in `area_crawls`, following the pattern `ingest_state` already
established for the poller.

| Control | Rule |
|---|---|
| **Cooldown** | A 상권 crawled within N days is not re-crawled. Enqueue is a no-op inside the window. |
| **Per-crawl cap** | A hard maximum of reels examined per crawl. A 상권 with a thousand reels costs the same as one with fifty. |
| **Daily budget** | The worker checks a global daily crawl count before starting and stops when spent. Without this, "browse by area" is an open-ended Apify bill. |
| **Circuit breaker** | Repeated actor failures trip a breaker that must be cleared by hand — same posture as the poller, and for the same reason: an automated system retrying into a broken vendor is how a bill or a ban happens. |
| **Empty-result alarm** | A crawl that returns zero reels for a 상권 that previously returned many is the signature of actor rot, not of a quiet neighbourhood. It records a distinct outcome rather than a success with no rows, because "succeeded, found nothing" is how a dead scraper looks from the outside. |

A crawl failure degrades the discovery screen to whatever is already stored. It never
affects ingestion, and it never affects a user's own saved places.

## 9. The browse surface

`/discover/[area]` renders places in the requested 상권, ordered by recency and
`place_facts` confidence. Each card carries the venue name, its thumbnail, the source
creator's `@handle`, and whatever `place_facts` knows (wait estimate, vibe tags).

Three states have to be designed, not discovered:

- **Warm** — the area has been crawled and has places.
- **Queued** — the area is enqueued but the crawl has not run. Show what exists and say
  more is coming; do not show a spinner for work that may be hours away.
- **Cold** — the area has never been enqueued because no user has saved anything there.
  This is a real state under D2 and needs an honest empty screen, not a fake one.

## 10. Testing

- `areas.ts` is pure: 동 → 상권, unmapped 동 → 구, non-Seoul → none. No network.
- `ApifyInstagramSource` is tested against a committed fixture of the actor's response
  shape. **No real Instagram media is committed** — fixtures are synthesised, and the
  URLs point at an invalid host so a test that starts fetching fails loudly.
- The crawl orchestration is tested with a stub `DiscoverySource`, which is the whole
  reason D7 exists.
- Budget, cooldown and breaker each get a test that proves the crawl *does not run*.
  Those are the assertions that matter; a control nobody tested is a control nobody has.

## 11. Open questions

- **Cooldown, cap and budget values.** Deliberately not fixed here. They are tuning
  data and belong in a table, per the extraction spec's H4. Initial values should be set
  deliberately low and raised once crawl quality is measured.
- **The `동 → 상권` map's initial contents.** Needs a pass over real reel captions to
  see which areas actually appear, rather than being written from memory of Seoul.
- **Whether discovered places should be visibly distinguished from saved ones** in any
  shared surface. D5 makes them the same row; the UI may still want to say where a place
  came from.

## 12. External assumptions

This section exists because the parent spec's §12 caught a false assumption before it
was built on, and the same discipline applies here.

- **Apify's Instagram actors keep working.** They are community-maintained against an
  unsupported surface. §8's empty-result alarm exists because this assumption will fail
  quietly rather than loudly.
- **Reels carry parseable captions outside the listicle format.** Measured: one listicle
  caption yielded ten venues at high confidence; one single-venue caption using `✅`
  instead of `📍` yielded one venue at **low** confidence and was flagged
  `needs_review`. The grammar is one creator's convention, and discovery will meet many
  creators. Expect a higher `needs_review` rate here than on the DM path.
- **Hashtag and location search return venue-bearing reels.** Untested. A 상권 hashtag
  may return mostly selfies. This is the assumption most likely to be wrong and the
  cheapest to check first — do that before building the queue.
