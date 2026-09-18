# Gaja — design

**Date:** 2026-09-18 · **Status:** approved design, not yet built
**Path:** `docs/superpowers/specs/2026-09-18-gaja-design.md`

---

## 1. Problem

People discover places on Instagram Reels and TikTok and save them. When they later want to
actually go, the saved post is only the first step: they re-find the post, search the place on
Naver, read reviews, check prices and hours, then repeat the whole loop for every other stop in
the day — *where after this, is there food nearby, which café, aren't these two too far apart.*

The work is not finding one place. It is the chain of small decisions that turns several places
into a day that works. Gaja does that chain.

**In one line:** an AI agent that replaces the hours people spend jumping between Instagram,
Naver, maps, blogs and review sites when planning a date or a trip.

## 2. What this is not

Not a travel chatbot. The distinguishing behaviour is that the system searches, compares, tests
candidates against the user's constraints, **searches again when a candidate fails**, and only
then produces an itinerary. A chatbot answers; this commits to a plan and defends it.

Not a recommender over a public place database. The user's own saved places are the anchor, and
their accumulated saving behaviour is the preference signal.

## 3. Settled decisions

Each of these was decided during design; the rationale is load-bearing and should not be
re-litigated without a reason.

| # | Decision | Why |
|---|---|---|
| D1 | **Architecture B** — fixed pipeline, LLM inside each stage, bounded repair loop | The agent order never varies; an LLM router pays nondeterminism for a settled question. Reproducibility matters when demoing live. |
| D2 | **DM is inbox and notify only.** No planning conversation in DM | A DM thread has no rendering and no state. Keeping it dumb keeps the integration we control least as small as possible. |
| D3 | **Identity is the IG-scoped user ID; `igsid` is nullable; every account needs ≥1 recovery channel** | Preserves "no signup form" for IG users (DM *is* password reset) while group-invite joiners, who have no IGSID, still have a way back in. |
| D4 | **Seoul now, `PlaceSource` adapter from day one** | Tokyo becomes a second adapter rather than a rewrite of the research agent. |
| D5 | **Groups, with union-and-attribution planning** | A date itinerary is a two-person artifact. Plan from both profiles, attribute each stop, balance across the day rather than per stop. |
| D6 | **Explainable JSON profiles, not embeddings** | Attribution requires saying *why*; an embedding can score but not explain. Also honest about cold start. |
| D7 | **Optimistic extraction** — medium-confidence places save with a 확인 필요 badge | A wrong row is annoying and self-correcting; a silently unsaved place breaks the product's only promise. |
| D8 | **Anchors with a floor** — pinned places mandatory, ≥1 saved place per day guaranteed, everything else competes on merit | The floor makes the day feel like *yours*; open competition stops a thin saved list producing a bad Saturday. |
| D9 | **`WAIT_TOO_LONG` is confidence-gated** — high → hard violation, medium/low → soft warning with dated evidence | The signature feature rests on the least reliable data. Gating keeps it on the product's spine: show your work, don't overclaim. |
| D10 | **Degrade loudly, never silently** | The product's only asset is being trusted. A confident wrong answer costs more than a visible gap. |

## 4. Architecture

Two independent halves sharing exactly one table.

```
INSTAGRAM ─────────────────────────────────────────────────────────
  @gaja.official  ◀── user shares a reel (DM)
        │ webhook
        ▼
  [ ingest ]      verify sig · dedupe on mid · ACK (<5s)
        │            └─ waitUntil(download video → storage) ─▶ enqueue
        │         ──▶ DM: "받았어요 👀"
        ▼
  [ extractor ]   reel → PlaceCandidate → resolve → place + place_ref
        ├── confident ──▶ saved_places ──▶ DM: "Saved 📍 …" + magic link
        └── unsure ─────▶ review_queue ──▶ ADMIN CONSOLE ──▶ saved_places

                       saved_places        ← the only shared surface

WEB APP (user) ────────────────────────────────────────────────────
  browse saved · request a day · watch it plan · swap · share to group
        │
        ▼
  [ orchestrator ]   ONE model call: intent → RequestEnvelope
        │            then: resolve area · load saved + profiles · run stages
        │
        ├──▶ RESEARCH     PlaceSource fusion + cache → VerifiedPlace[]
        ├──▶ PLANNING     LLM selects+orders → code schedules → Itinerary
        └──▶ VALIDATION   → Violation[] ──┐
                   ▲                      │  ≤3 rounds, forbidden[] grows
                   └──────────────────────┘
                                          └──▶ Itinerary (final)
                                                    └──▶ DM: "your Saturday ↓"
```

**Boundaries**

- **Ingestion is asynchronous and fully decoupled from planning.** They share `saved_places` and
  nothing else. A broken extractor cannot take down planning; a bad planning deploy cannot lose
  an incoming reel.
- **The Orchestrator is not an agent.** It is a function containing exactly one model call
  (intent parsing). It then resolves the area, loads saved places and profiles, runs three stages
  in a fixed order, and streams progress.
- **`PlaceSource` is the only code that knows Naver exists.** Everything above it sees
  `VerifiedPlace`. This is also what makes the scraper swappable, rate-limitable and mockable.
- **The admin console is the extraction pipeline's error handler**, not a dashboard. Every human
  resolution is a labelled training pair.

**Stack (proposed, not load-bearing):** Next.js on Vercel for both surfaces and all routes;
Postgres for state; a DB-backed job table for the extraction queue; Playwright for the Naver
scrape, running on Vercel Functions (5 GB package limit accommodates it).

## 5. Data model

### 5.1 Place identity

The same café has four identities: burned into a reel with no ID at all, a Kakao place ID, a
Naver place ID, a Google place ID. If these do not collapse, the user sees duplicates, the
planner double-books, and the validator compares Naver hours against Google coordinates.

```sql
places
  id          uuid pk
  name        text
  name_alt    text[]           -- 어니언 성수 / Onion Seongsu
  category    text             -- cafe | restaurant | exhibition | shop | activity
  lat, lng    double precision
  address     text
  area        text             -- 성수, resolved once, denormalized for filtering
  created_at  timestamptz

place_refs
  place_id    uuid references places
  source      text             -- naver | kakao | google
  source_id   text
  url         text
  unique (source, source_id)
```

Resolution is geocode-plus-fuzzy-name within ~50 m. This is the highest-bug-density area of the
model: Korean venues rename frequently, and branches of one brand sit 200 m apart in 성수. **A
"these two rows are the same place" merge action is required in the admin console from day one.**

### 5.2 Users, groups, saved places

```sql
users
  id                uuid pk
  display_name      text
  avatar_url        text
  email             text unique NULL     -- recovery + future billing identity
  email_verified_at timestamptz
  igsid             text unique NULL     -- Instagram-scoped user ID
  locale            text                 -- ko | en
  home_area         text
  profile_visible_in_groups boolean default true
  plan              text default 'free'
  created_at, last_active_at
  CHECK (igsid IS NOT NULL OR email IS NOT NULL)

groups          id, name, created_by, created_at
group_members   group_id, user_id, role (owner|member), joined_at
                unique (group_id, user_id)
group_invites   token, group_id, created_by, expires_at, used_by, used_at

saved_places
  id            uuid pk
  user_id       uuid references users
  group_id      uuid NULL            -- null = personal
  place_id      uuid NULL            -- null until resolved
  reel_video_id text                 -- from the ig_reel attachment
  source_url    text                 -- reel permalink
  raw_caption   text
  extracted     jsonb                -- PlaceCandidate as the extractor saw it
  hook          text                 -- what the reel was selling
  status        text                 -- pending | resolved | needs_review | rejected
  confirmed     boolean default true -- false ⇒ 확인 필요 badge
  saved_at      timestamptz
  unique (user_id, reel_video_id)

usage_counters                       -- the metering seam; see §13
  user_id, period, unit, count       -- unit ∈ extraction | planning_run
  unique (user_id, period, unit)
```

**The row is created at ack time with `status = 'pending'`**, before extraction runs, so a crash
in the extractor can never lose a reel the user already sent. `place_id` and `hook` are filled in
on resolution. **There is no separate `review_queue` table** — the admin console's queue is
`saved_places WHERE status = 'needs_review'`, which keeps one row per shared reel through its
whole lifecycle instead of copying it between tables.

`email` is **never requested at first touch.** IG users are already recoverable through DM and
are never prompted. Only an invite-joiner is asked, and only at the point they would otherwise
have no recovery channel. The `CHECK` constraint is what enforces this as a rule rather than a
convention.

`hook` is inferred by the extractor from the reel, not asked of the user — "티라미수가 미쳤다",
"루프탑 뷰", "웨이팅 없는 오마카세". It is the most useful single input to personalization because
it captures *what kind of appeal* moves this person.

`groups.kind` is deliberately absent. Two members is a couple; party composition comes from
`itineraries.for_members`.

### 5.3 Research cache

```sql
place_facts
  place_id      uuid references places
  fetched_at    timestamptz
  ttl_until     timestamptz
  hours         jsonb    -- per weekday, incl. break time and last order
  closed_days   jsonb    -- regular + irregular (공휴일, 임시휴무)
  price_band    text     -- ₩ | ₩₩ | ₩₩₩ + typical per-person KRW
  rating        jsonb    -- per source; NEVER averaged across sources
  review_digest jsonb
  degraded      boolean default false
  source_trace  jsonb    -- which source asserted which field, and when
```

`source_trace` is a product requirement, not bookkeeping. Sources disagree; the validator must
know which value it trusted and the UI must be able to say *"영업시간 네이버 기준, 2시간 전 확인"*.

`review_digest` shape:

```json
{ "wait": { "sat_afternoon": "90–120min", "confidence": "medium",
            "evidence": ["8/31 블로그: 1시간 반 웨이팅", "9/2 리뷰: 오픈런 필수"] },
  "vibe": ["quiet", "solo-friendly"],
  "warnings": ["15:00 break time", "no reservations"] }
```

### 5.4 Preferences

```sql
preference_signals              -- append-only, never rewritten
  user_id, kind, place_id, itinerary_id, weight, meta jsonb, created_at
  kind ∈ saved | accepted | rejected | swapped_out | visited

user_profile                    -- derived, rebuildable, read by the planner
  user_id pk, profile jsonb, computed_at
```

The log is truth. The profile is a cache that can be thrown away and recomputed when the
preference model changes — which it will, repeatedly. `profile` is explainable JSON:

```json
{ "category_mix": { "exhibition": 0.4, "cafe": 0.2, "restaurant": 0.3, "shop": 0.1 },
  "price_band": "₩₩", "crowd_tolerance": "low", "pace": 4,
  "dwell_pref": "normal", "areas": ["성수", "한남"], "avoid": [] }
```

It is rendered to group members when `profile_visible_in_groups` is true (default):
*민지 · 전시 40% · 조용한 곳 선호 · 보통 4곳 · ₩₩*.

### 5.5 Itineraries

```sql
itineraries
  id, user_id, group_id NULL, for_members uuid[],
  request jsonb,        -- the RequestEnvelope
  status,               -- planning | validated | best_effort | failed
  round, created_at

itinerary_stops
  itinerary_id, seq, place_id
  arrive_at, depart_at
  travel_from_prev jsonb  -- { mode, minutes, meters }
  est_cost_krw
  reason       text       -- why this place, shown to the user
  for_user_id  uuid NULL  -- whose taste this stop serves (attribution)
  pinned       boolean    -- from must_include[]; validation may never drop it

violations
  itinerary_id, round, stop_seq NULL, code, severity, detail jsonb, resolution
  -- stop_seq is null for whole-itinerary violations (OVER_BUDGET)
```

`pinned` prevents the validator from silently deleting the exhibition the whole trip was for.
`reason` and `for_user_id` are what make the agent's judgment visible rather than implied.

## 6. Ingestion

### 6.1 What Instagram actually provides

A shared reel arrives as an `ig_reel` attachment carrying a **short-lived CDN URL** and a `title`
that is sometimes the caption and often empty. The reel's location tag, full caption and author
are **not** available — that data belongs to the poster, not to the forwarder. **The place name
therefore usually exists only as text burned into the video.** This makes extraction a vision
problem. See §12 for the verification this assumption requires.

### 6.2 The ladder

Each rung runs only when the one above leaves confidence below the band boundary. The
boundaries themselves are tuned against the extraction eval set (§11), not fixed here.

```
1. title / caption text     ~free    → keyword search  (OPPORTUNISTIC — see §12/1a;
                                       Meta does not document this field)
2. 8 frames, evenly sampled,
   deduped by perceptual hash ~5–15s  → vision: name, category, hook,
                                        visible price, signage
3. audio → ASR              +cost    → low confidence only; Korean reels
                                        frequently *say* the place name
4. human                    async    → admin review queue
```

Then: candidate name + inferred area → Kakao/Naver keyword search → canonical `place` +
`place_ref`. Step 2 also produces `hook`.

### 6.3 Non-negotiable properties

- **Idempotency, twice.** The ingest route dedupes on `mid` (Meta redelivers on timeout). The
  extractor dedupes on `(user_id, reel_video_id)` (users re-share).
- **Download before anything else.** The CDN URL expires. Ack fast, download in `waitUntil`,
  then enqueue.
- **The user never waits on the extractor.** Instant receipt (`"받았어요 👀"`), second message on
  resolution.
- **Per-user queue depth cap.** Forty reels from one Tokyo binge must not starve other users.
- **Every branch ends in a usable outcome.** Failure is a one-tap repair, not an apology:
  *"저장했어요 — 장소를 못 찾았어요. 이름만 알려주세요 →"*.
- **Every human resolution is labelled data.**

### 6.4 Confidence bands

| band | behaviour |
|---|---|
| high | save, `confirmed = true`, DM "Saved 📍 …" |
| medium | save, `confirmed = false` (확인 필요 badge), usable by the planner immediately |
| low | `review_queue`, DM "찾고 있어요", follow-up DM on resolution |
| none | `rejected`, DM with the one-tap name-it repair link |

### 6.5 Group assignment

Reels default to **personal**; assignment to a group happens in the web app. A DM quick-reply
(`add to: [나] [우리]`) is nicer UX and supported by the Messaging API, but it re-opens a decision
in the channel D2 keeps dumb. Deferred until the DM integration has proven stable.

## 7. Research

### 7.1 Source coverage

| source | identity | coords | hours | break | price | reviews | wait |
|---|---|---|---|---|---|---|---|
| Kakao Local *(API)* | ✓ | ✓ | — | — | — | — | — |
| Naver Search *(API)* | ✓ | ✓ | — | — | — | — | — |
| Naver Place *(scrape)* | ✓ | ✓ | ✓ | ✓ | menu | ✓ | signal |
| Naver Blog *(API)* | — | — | — | — | ~ | ✓ | **signal** |
| Google Places *(API)* | ✓ | ✓ | ✓ | — | band | ✓ | — |

```ts
interface PlaceSource {
  name: 'naver' | 'kakao' | 'google'
  search(query: string, near?: LatLng): Promise<PlaceRef[]>
  facts(ref: PlaceRef): Promise<PartialFacts>
  reviews(ref: PlaceRef, since: Date): Promise<ReviewText[]>
}
```

### 7.2 Merge policy

| field | precedence | on disagreement |
|---|---|---|
| `coords` | Kakao → Naver → Google | take Kakao's; if two sources differ by >100 m, flag the place for admin merge review — that is usually two rows, not one bad coordinate |
| `hours`, `break_time`, `closed_days` | Naver Place → Google | **take the conservative value** (earlier close, more closed days), record both, show both |
| `price` | Naver menu → Google band | conservative |
| `rating` | — | **keep per source, never average** |

The conservative rule is justified by asymmetry: arriving at a closed place ruins the day;
leaving an hour early costs nothing.

### 7.3 The wait-time digest

The signature feature, and the only one with no API behind it. Long-form Naver blog posts are
where Koreans describe waits, and blog search is an official API.

- **Recency is a hard filter.** Wait claims expire at ~6 months; vibe claims live longer.
- **An unqualified wait is not a wait.** Extract the day/time qualifier or discard the claim.
- **Confidence is reported.** Low/medium confidence enters the planner as a *soft* constraint.
- **Evidence is kept verbatim.** A dated quote is a receipt; a score is a claim.

### 7.4 Freshness

```
coords · name · category      TTL 90d   stale-while-revalidate
review_digest                 TTL 14d   stale-while-revalidate
hours · closed_days           TTL  7d   stale-while-revalidate
    ── except ──
itinerary date within 48h     force refresh, blocking
```

임시휴무 is announced ~2 days out. The 48-hour rule exists so the cache cannot hide exactly the
failure the Validation Agent was built to catch. If the blocking refresh fails, serve stale and
raise `STALE_FACTS`.

### 7.5 Scrape discipline

Cache-first always · concurrency cap with jitter · circuit breaker → Google fallback with
`degraded = true` and a visible "영업시간 미확인" · **nightly pre-warm of every user's saved
places**, which moves scrape load off the request path and turns a planning run from ~60 s of
mostly-fetches into ~10 s of mostly-cache-hits.

**Scheduled contract test (required, see §12/2a).** Naver Place renders from an internal GraphQL
API whose shape changes frequently. A circuit breaker detects blocking; it does **not** detect a
changed response shape, which returns 200 and quietly poisons `place_facts`. So: a scheduled job
scrapes a fixed set of ~5 known-stable places and asserts the parsed fields against recorded
values. A mismatch pages before users get wrong hours — not after.

### 7.6 Fan-out

Candidates = the group's saved places in the area ∪ discovered places filling the day's category
gaps, **capped at ~30**. Uncapped, one planning run scrapes two hundred places.

## 8. Planning and validation

### 8.1 The model chooses, the code counts

```
1. code   prefilter candidates by availability_on(date)
2. LLM    select + order → Draft { stops[], reason[], for_user_id[] }
3. code   schedule() → walk the order applying dwell + travel legs,
                       assigning every arrive_at / depart_at
4. code   → Itinerary
```

**The LLM never emits a time.** It emits an order; `schedule()` derives every clock value. This
eliminates the arithmetic-inconsistency failure class outright at no cost.

**Dwell defaults** live in a tunable table, not in code: café 60 · restaurant 75 · exhibition 90
· pop-up 30 · shop 30 minutes, adjusted by the profile's `pace` / `dwell_pref`.

**Travel legs:** under ~1.5 km, haversine × 1.35 detour factor at 4.5 km/h — free, and accurate
enough to catch two 성수 places that are thirty minutes apart on foot. Above that, a transit API.
Computed lazily for the drafted order only.

**Selection rubric** given to the model, alongside both profiles, the floor rule and the budget:
fit-to-profile · attribution balance · category flow · geographic coherence · fact confidence.
Every stop must carry a `reason` and a `for_user_id`.

### 8.2 Violations

```ts
HARD  CLOSED        { reason: 'regular' | 'break' | 'holiday' | 'temp' }
      TOO_FAR       { from, to, minutes }
      OVER_BUDGET   { by_krw }
      LAST_ORDER    { stop, arrive_after }
SOFT  TIGHT         { slack_minutes }
      STALE_FACTS   { fetched_at }
      WAIT_TOO_LONG { est, confidence }   // hard iff confidence === 'high'
```

Hard violations force a repair round. Soft violations are shown to the user and change nothing.

### 8.3 The repair loop

Maximum 3 rounds. Three rules:

1. **Repair is targeted, not a replan.** The planner receives its own itinerary, the violations,
   and a `forbidden` set, and fixes only the affected stops.
2. **`forbidden` accumulates and never shrinks.** This is the anti-oscillation guarantee —
   without it, A violates → swap to B → B violates → swap back to A, forever. Monotonic growth
   guarantees termination.
3. **Pinned stops are never removed.** Repair may re-time the day around a pinned stop; an
   unfixable pinned violation becomes a warning to the user, never a deletion.

After three rounds, return the best effort **with remaining violations visible**:
*"이 카페는 토요일 웨이팅이 길 수 있어요 — 근처에서 대안을 못 찾았어요."*

### 8.4 Streaming

```
research.start     { count }
research.place     { name, ok | degraded }
plan.draft         { stops }
validate.violation { code, stop }
plan.repair        { removed, added, because }
done               { itineraryId }
```

`plan.repair` is what makes a deterministic pipeline read as agentic — and it surfaces more
genuine reasoning than an LLM-router would, with none of the nondeterminism.

## 9. Surfaces

**Instagram DM** — inbox and notifications only (D2). Inbound: a shared reel. Outbound: instant
receipt, resolution result, itinerary-ready link. No planning conversation.

**User web app** — saved places (personal and per group) · groups, invites, member profiles ·
the planning request · the live pipeline view · the itinerary with map, timeline, per-stop
`reason` and attribution · swap / reject / re-plan.

**Admin console** — the review queue (frames + title + ranked guesses, one click to resolve) ·
the place-merge action · circuit-breaker and scrape health · ingestion throughput. It is the
error handler for a pipeline that is expected to fail, not a metrics dashboard.

## 10. Failure modes

**Principle: degrade loudly, never silently.**

| area | failure | handling |
|---|---|---|
| ingest | webhook redelivered | dedupe on `mid` |
| ingest | CDN url expired | download in `waitUntil`; else DM "다시 보내주실래요?" |
| ingest | no place in the reel | `rejected` + one-tap name-it repair link |
| ingest | 3 candidates returned | optimistic save of top + 확인 필요 |
| ingest | 40 reels at once | per-user queue depth cap, FIFO |
| ingest | worker crash | `attempts` + backoff, dead-letter after 3 → `review_queue` |
| research | Naver blocking | circuit opens → Google, `degraded`, "영업시간 미확인" |
| research | no facts anywhere | drop from candidates — **unless pinned**, then warn |
| research | sources disagree | conservative value, both in `source_trace`, both shown |
| research | one place times out | drop that candidate, never fail the run |
| research | refresh fails in 48h window | serve stale + `STALE_FACTS` |
| plan | invalid JSON | schema-validate, retry once with the error, then fail cleanly |
| plan | **place not in the candidate set** | **reject the draft — enforced in code** |
| plan | fewer saved places than the floor | say so: "성수에 저장한 곳이 1곳뿐이라…" |
| plan | budget arithmetically impossible | say so before planning, not after |
| plan | nothing valid after 3 rounds | best effort + visible violations |
| auth | magic link reuse | single-use, short expiry, exchanged for a session |

The hallucinated-place rule is a **structural guarantee**, not a prompt instruction: the planner
may only emit `place_id`s from the candidate set it was handed, validated in code. A fabricated
restaurant is the exact failure the "verified" premise exists to rule out.

## 11. Testing

The §8.1 split means everything load-bearing is a pure function: `schedule()`, travel math, merge
policy, violation detection, `forbidden` monotonicity, both idempotency keys. All deterministic,
all genuinely unit-testable.

Four eval sets for the model-shaped stages:

| set | inputs | metric |
|---|---|---|
| extraction | ~30 real reels, known answers | exact match on resolved `place_id` |
| review digest | hand-labelled review sets | **precision** on wait claims, weighted toward false negatives |
| planning | fixed candidate set + constraints | **property assertions**, not golden outputs |
| repair loop | itinerary seeded with a known violation | terminates ≤3 · fix introduces no new hard violation |

Planning properties: budget respected · ≥1 saved place · no stop closed on arrival · attribution
balanced within one stop · every `place_id` in the candidate set. Golden itineraries for a
creative task go stale the first time the prompt improves; these assertions stay true.

**Demo fixtures.** Record real API and scrape responses for ~30 성수 places and freeze them.
Replay mode means a demo cannot be broken by rate-limiting, an open circuit breaker, or a café
changing its hours an hour beforehand.

## 12. External assumptions — verified 2026-09-18

All six were checked against primary sources. Four confirmed as written; **two came back
materially different and changed the design.** Sources listed at the end of this section.

| # | assumption | verdict |
|---|---|---|
| 1 | `ig_reel` attachment: short-lived CDN url, optional `title`, no location tag / full caption / author | **confirmed, and stricter** — see 1a |
| 2 | Naver Place has no official API; scraping only | **confirmed, and more fragile** — see 2a |
| 3 | Naver blog search is an official API | confirmed — `openapi.naver.com/v1/search/blog` |
| 4 | Kakao Local / Naver local return identity + coords, no hours | confirmed — `openapi.naver.com/v1/search/local` exists, no Place API is listed anywhere in Naver's official API catalogue |
| 5 | Google Places returns hours, price band, reviews for Seoul | API surface confirmed. **Coverage thinness for new cafés and pop-ups remains unverified** — it is a claim about data density, not API shape, and can only be settled by sampling real 성수 places |
| 6 | No provider exposes wait times | confirmed, Google included |

**1a. `title` is less reliable than assumed, and this promotes the vision rung.**
Meta's own webhook documentation does *not* document the `ig_reel` payload fields at all, and
states only: *"Only the URL for the shared media or post is included in the notification when a
customer sends a message with a share."* The `reel_video_id` / `title` / `url` shape is reported
consistently by third-party implementations, not by Meta. **Consequence:** §6.2 rung 1 (title
text) must be treated as an opportunistic bonus, not a rung the ladder can rely on. The vision
pass is the *primary* extraction path, not a fallback. Budget latency and cost accordingly.

Also confirmed: the Messaging API only surfaces DMs sent **to** Business or Creator accounts.
`@gaja.official` must be Professional — already assumed — but senders may be ordinary personal
accounts, which is what D3 requires.

**2a. The Naver scrape is more fragile than a circuit breaker covers.**
Naver Place renders from an **internal GraphQL API whose query structure is complex and changes
frequently.** A circuit breaker catches *blocking*; it does not catch a silently changed response
shape, which would poison `place_facts` with wrong or empty values while every request still
returns 200. **Consequence:** §7.5 gains a scheduled contract test (added). Second consequence:
managed scraping providers for Naver Place exist commercially, and routing the scrape through one
trades cost for both the maintenance burden and a meaningful slice of the ToS exposure. That is a
build-vs-buy decision for `data-engineer` in slice 2, not a decision this spec makes.

**On D9, confidence-gated wait times — the verification strengthens it.** Google's own popular-
times data is extractable only by scraping `aria-label` strings, and the extracted values are
language-dependent and frequently wrong. So inferring waits from dated Korean blog text is not a
*worse* option than the alternative; it is a comparable one that ships its own evidence. The
confidence gate stays.

**Sources:** Meta [Webhooks for Instagram Messaging](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/) ·
[Naver Open API list](https://naver.github.io/naver-openapi-guide/apilist.html) ·
[네이버 크롤링 차단 방식](https://blog.hashscraper.com/reasons-why-naver-crawling-is-blocked-and-solutions?locale=ko) ·
[Google Business Profile: popular times API](https://support.google.com/business/thread/44431586/is-there-an-api-available-that-i-can-use-to-show-popular-times-wait-times-on-my-web?hl=en) ·
[populartimes](https://github.com/m-wrzr/populartimes)

## 13. Out of scope

- **Billing, plans, tiers, paywalls.** Only the metering seam is built: `users.plan`,
  `usage_counters`, and `assertQuota()` at exactly two call sites — `enqueue_extraction()` and
  `start_planning_run()` — returning `true` unconditionally for now. Which unit to meter and what
  it is worth is a pricing question to answer with usage data, not without it.
- **Tokyo / Japan sources.** `PlaceSource` accommodates them; no adapter is built.
- **Learned preference embeddings.** Revisit once there is a year of `preference_signals`.
- **DM quick-reply group assignment.** Deferred per §6.5.
- **A security review.** The magic link is a bearer credential in a DM, the system stores other
  people's Instagram message content, and the scrape carries ToS exposure. `security-engineer`
  should be cast before the first real user.

## 14. Build decomposition

This spec is too large for one implementation plan. It decomposes into four vertical slices, each
of which ends in something demoable. The ordering is chosen so that **the demo exists after slice
2**, before the riskiest work begins.

### Slice 1 — Spine

`users` · `groups` · `group_members` · `group_invites` · `places` · `place_refs` ·
`saved_places` · magic-link auth with the dual sign-in/link semantics · web app shell ·
places added by hand.

Proves identity, the `CHECK` recovery constraint, and group membership with **no Instagram and no
scraping involved**. Everything downstream assumes this and nothing in it is uncertain.

### Slice 2 — The pipeline *(this is the demo)*

`PlaceSource` + `place_facts` + freshness · Research fusion · Planning with the
select/order → `schedule()` split · Validation with typed violations · the bounded repair loop ·
the streaming event feed · the itinerary view.

Runs against slice 1's hand-entered saved places. **Build the Kakao and Google adapters first** —
both are official APIs — so the pipeline works end to end before the fragile part exists. Add the
Naver Place scrape last, behind the circuit breaker it already has. Record the demo fixtures
(§11) as soon as the adapters return real data.

After this slice the product is demoable: a real itinerary, really verified, with visible
reasoning and a live swap.

### Slice 3 — Ingestion

IG webhook · `waitUntil` download · job queue · the extraction ladder · confidence bands ·
DM replies · the admin console review queue and place-merge action.

Deliberately last of the three build slices, because it is the piece with the most external
dependency and the least control — and because slice 2 does not need it. If Instagram behaves
unexpectedly (see §12), the demo still exists.

### Slice 4 — Personalization

`preference_signals` · the `user_profile` derivation · union-and-attribution in the planner ·
profile rendering inside groups.

Last because it needs the other three to have generated signals worth learning from. Until then
the planner runs on an empty profile, which is a valid state it must handle anyway — a new user
has one on day one.

### Not a slice

Billing, Tokyo adapters, embeddings, DM quick replies, the security review (§13).
