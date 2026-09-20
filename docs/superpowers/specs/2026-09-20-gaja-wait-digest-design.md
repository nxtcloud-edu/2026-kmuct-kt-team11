# Gaja — the wait-time digest on Apify-sourced Naver blog text

**Date** 2026-09-20 · **Status** approved, not yet implemented
**Amends** `2026-09-18-gaja-design.md` §5.3, §7.1, §7.4, §7.5 — see §9
**Depends on** `lib/ingest/` (built 2026-09-20; see `lib/ingest/README.md`)

> **Reconciled with PR #1 on 2026-09-20.** This spec was written independently of
> PR #1 (`slice2/place-facts-layer2`), which had already built the source-agnostic
> half of place research against the same ground. PR #1 landed, and the overlaps
> were settled in its favour where it had already shipped code. Three amendments
> are marked inline below — the migration ordinal (§3), the fact that §3's DDL is
> a description of that one table rather than a second one (§3), and `facts.ts`
> being called `store.ts` (§2, §5.2). Two of this spec's own decisions won and are
> now in the merged code: `review_digest` has §3.1's typed shape rather than
> PR #1's `{ [bucket: string]: string }`, and review text left `SourceFacts`
> entirely for `ReviewText` behind a `ReviewSource`. Nothing else here changed.

## 1. What this is

The §7.3 wait-time digest, built as a vertical sliver of slice 2 rather than after
slice 2's research layer is complete. It reads long-form Korean blog posts through
Apify, extracts wait claims that carry a day/time qualifier, and writes them to
`place_facts.review_digest` with verbatim, clickable evidence.

It runs against slice 1's hand-entered saved places. No Instagram, no webhook, no
Kakao or Google adapter, no `hours` fusion. On its own it is demoable: *here is what
the internet says the wait is at this café, with dated receipts*.

**Why this before the rest of slice 2.** §14 orders Kakao and Google first, and for
building a working itinerary that ordering is right — hours and coords are what the
planner blocks on, waits are a soft constraint. But §7.3 calls the digest "the
signature feature, and the only one with no API behind it", and the assumption
underneath it has never been checked. §12 verified that blog *search* exists; nobody
has verified that posts about the places Gaja saves contain waits with a qualifier
attached. That is a claim about data density, which §12/5 says "can only be settled
by sampling real 성수 places". This is the smallest build that settles it against
real data and still produces something kept.

### Settled decisions

| Question | Decision |
|---|---|
| Naver blog transport | Apify `maximedupre/naver-blog-review-scraper`, not Naver's official Search API |
| Where it sits | Behind a new `ReviewSource`, sibling to `PlaceSource` |
| Extraction | One model call per place, AI SDK v6 structured output via AI Gateway |
| Retrieval precision | `"{name} {area}"` query, then require the name in the body |
| Confidence | Computed in code from corroboration count, never asked of the model |
| Evidence integrity | Each quote must be a literal substring of the post it cites |
| Schedule | Hourly cron, batches of ~20, never on the request path |
| Not built | Circuit breaker · Kakao/Google adapters · `hours` · `price_band` · `rating` |

### Why Apify rather than Naver's official API

§12/3 confirmed `openapi.naver.com/v1/search/blog` exists, and it does. It returns a
truncated `description` snippet of roughly 200 characters. §7.3's own rule is *"an
unqualified wait is not a wait — extract the day/time qualifier or discard the
claim"*, and a qualifier ("토요일 오후에 갔는데") is regularly a hundred characters away
from the number it qualifies. **The rule the spec already committed to cannot be
enforced against snippets.** The Apify actor returns full post bodies from the same
keyword search, and needs no Naver API credentials.

This partly answers the build-vs-buy §12/2a deferred to `data-engineer` in slice 2 —
for blog text only. Naver **Place** remains undecided and is out of scope here.

## 2. Boundaries and layout

§4 states the rule this must not break: *"`PlaceSource` is the only code that knows
Naver exists. Everything above it sees `VerifiedPlace`."*

Naver Blog is not a `PlaceSource`. §7.1's table marks it ✓ under `reviews` and `wait`
and blank under identity, coords, hours, break and price. Implementing
`search()`/`facts()` as two throwing methods would push that lie into every caller's
types. Instead it gets a narrower sibling:

```ts
type ReviewText = {
  source: 'naver_blog' | 'naver_place' | 'google'
  url: string          // the receipt the evidence links back to
  body: string         // full text; the substring check in §4.3 runs against this
  postedAt: Date       // §7.3's recency filter and the evidence date
  title: string
}

interface ReviewSource {
  name: 'naver_blog' | 'naver_place' | 'google'
  reviews(place: Place, since: Date): Promise<ReviewText[]>
}
```

The caller owns `since` — `refresh.ts` passes `now() - 6 months` per §7.3. Each
source translates it into whatever its transport wants; `naver-blog.ts` turns it
into the actor's `dateFrom`. A source that cannot filter by date server-side filters
after, so the contract holds either way: **no `ReviewText` older than `since` is
ever returned.**

Three eventual implementations — blog now, Naver Place and Google reviews in slice 2
proper — the same cardinality `PlaceSource` has. The rule §4 cares about is preserved
and restated: **nothing above `lib/research` knows Apify exists, and nothing above
`sources/naver-blog.ts` knows Naver exists.**

```
lib/research/
  source-facts.ts     [PR #1, landed] SourceFacts — the layer-1/layer-2 boundary
  place-facts.ts      [PR #1, landed] the place_facts row shape · ReviewDigest (§3.1)
  fuse-facts.ts       [PR #1, landed] SourceFacts[] → PlaceFacts
  review-source.ts    [landed] the interface above
  sources/
    naver-blog.ts     the only Naver-aware file
  digest.ts           ReviewText[] → ReviewDigest (the model call)
  store.ts            [PR #1, landed] place_facts read/write · TTL
  refresh.ts          the cron job body
```

**Amended 2026-09-20.** This spec called the persistence file `facts.ts`; PR #1
had already shipped it as `store.ts`, and the two are the same job against the
same table. It is `store.ts`; there is no `facts.ts`. This spec's `types.ts` is
likewise PR #1's `place-facts.ts` (the digest types) plus `review-source.ts`
(`ReviewText`); `WaitClaim` is the extractor's own type and lands with
`digest.ts`.

Dependencies run one way: `app/api` → `lib/research` → `lib/ingest` → Apify.
`lib/ingest` stays a transport that knows about posts and blogs and has never heard
of a place. Every domain rule lives in `lib/research`, which is what makes `digest.ts`
testable against fixture `ReviewText[]` with no network and no model.

**Consequence for slice 2.** `ReviewSource` becomes a decision slice 2 inherits.
Whoever builds the Kakao/Google fusion finds the review half already shaped.

## 3. Data model

`place_facts` lands with the full §5.3 column set; this feature populates four
columns. The rest stay null until the adapters arrive — stated in the migration so
the nulls are not read as a defect.

```sql
create table place_facts (
  place_id      uuid primary key references places(id) on delete cascade,
  fetched_at    timestamptz not null default now(),
  ttl_until     timestamptz not null,
  hours         jsonb,        -- slice 2: Naver Place → Google
  closed_days   jsonb,        -- slice 2
  price_band    text,         -- slice 2
  rating        jsonb,        -- slice 2; per source, NEVER averaged
  review_digest jsonb,        -- this feature
  degraded      boolean not null default false,
  source_trace  jsonb not null default '{}'
);

create index place_facts_stale_idx on place_facts (ttl_until);
```

**Amended 2026-09-20 — this is not a second table.** The DDL above describes
`place_facts`; the table itself ships in PR #1's migration, which landed as
**`supabase/migrations/20260920000007_place_facts.sql`**. (PR #1 numbered it
`…0003`, which `20260920000003_onboarding_profile.sql` already held; it was
renumbered past the highest ordinal on disk at merge time.) PR #1's DDL is the
base, so the shipped table also carries an `updated_at` column, and its ttl index
is named `place_facts_ttl_idx` rather than `place_facts_stale_idx` — nothing in
code references either name. Do not write a second `create table place_facts`.

`primary key (place_id)` rather than a surrogate: one row per place, and the refresh
upsert needs a conflict target.

`ttl_until` is set to `now() + interval '14 days'` on every successful refresh, per
§7.4's TTL for `review_digest`. It is **not** advanced on a failed refresh (§6), so a
persistently failing place stays at the front of the selection query rather than
disappearing from it for a fortnight.

### 3.1 `review_digest`, sharpened

§5.3's example shape does not survive contact with the planner. `"90–120min"` is a
string the conservative rule in §7.2 must *compare* against schedule slack;
`"sat_afternoon"` is a free-text key the planner cannot reliably look up; and the
evidence string has dropped the URL, so §7.3's *"a dated quote is a receipt"* yields
a receipt that cannot be followed.

```json
{ "wait": {
    "weekend_afternoon": {
      "min_minutes": 90,
      "max_minutes": 120,
      "confidence": "medium",
      "evidence": [
        { "quote": "토요일 오후에 갔는데 1시간 반 웨이팅",
          "url": "https://blog.naver.com/someblogger/223456789012",
          "posted_at": "2026-08-31" }
      ]
    }
  },
  "vibe": ["quiet", "solo-friendly"],
  "warnings": ["15:00 break time"] }
```

Top-level keys stay `wait` / `vibe` / `warnings`. Only the inside of `wait` changes.

The slot key comes from a **closed vocabulary**: `{weekday,weekend} ×
{morning,lunch,afternoon,evening}`, plus `open_run` for 오픈런. This is not tidiness.
§7.3 requires that an unqualified claim be discarded, and a closed enum makes that
**structural** — a claim the model cannot assign a slot to fails schema validation
and never reaches the database, rather than depending on the prompt to remember.

`source_trace` records which source asserted the digest and from which posts:

```json
{ "review_digest": { "source": "naver_blog", "at": "2026-09-20T03:00:00Z",
                     "posts": ["https://blog.naver.com/…/223…", "…"] } }
```

The post list is a cost lever: a refresh retrieving the same set skips the model call.

## 4. The pipeline

Four steps. Only the third is non-deterministic.

### 4.1 Retrieve

Query `"{place.name} {place.area}"` with `dateFrom` at today − 6 months. §7.3 calls
recency a *hard* filter, so it belongs in the query rather than a post-filter; it also
reduces what Apify is paid for.

**This requires one addition to `lib/ingest`.** `searchBlogPosts` maps results through
`mapSearchHit`, which returns `NaverSearchHit` — title, description, URL, no body. The
actor is already invoked with `contentFormat: 'text'`, so the bodies are present in
the response and the mapper discards them. Add `searchBlogPostsFull()`, mapping the
same items through `mapReviewPost` to return `NaverPost[]` with `bodyText`. Same
actor run, same cost, no second call.

### 4.2 Match

Drop any post whose body contains neither `place.name` nor any of `place.name_alt`,
NFC-normalised and space-stripped. A 성수동 roundup mentioning twelve cafés survives
for all twelve — correct, it is about all twelve — while a post about a different
café with a similar name does not.

This fails closed, which is the direction §11 asks for: precision weighted toward
false negatives.

### 4.3 Extract

One model call per place over the surviving bodies:

```ts
import { generateText, Output } from 'ai';

const { output } = await generateText({
  model: 'anthropic/claude-sonnet-5',
  output: Output.object({ schema: DigestSchema }),
  prompt: buildPrompt(place, texts),
});
```

`generateText` with `Output.object()` — AI SDK v6 moved this off `generateObject`.
The model is a plain `provider/model` string through the AI Gateway; no provider SDK
is installed.

```ts
const Claim = z.object({
  slot: z.enum([
    'weekday_morning', 'weekday_lunch', 'weekday_afternoon', 'weekday_evening',
    'weekend_morning', 'weekend_lunch', 'weekend_afternoon', 'weekend_evening',
    'open_run',
  ]),
  min_minutes:  z.number().int().min(0).max(600),
  max_minutes:  z.number().int().min(0).max(600),
  quote:        z.string().min(4),
  source_index: z.number().int(),
}).refine((c) => c.min_minutes <= c.max_minutes);
```

A single reported wait ("30분 기다렸어요") is `min === max`; a range ("30분에서 1시간")
is not. Inverted bounds are a malformed claim and are dropped, not silently swapped.

Then code asserts **`quote` is a literal substring of `texts[source_index].body`** and
drops the claim otherwise. §10 closes by insisting the hallucinated-place rule is *"a
structural guarantee, not a prompt instruction"*; this is that rule applied to
evidence. A fabricated quote cannot reach the database regardless of prompt quality,
and the check is a unit test with no model in it.

Input cap: 10 posts, 6,000 characters each, newest first.

The same call fills `vibe` and `warnings` — near-free once the bodies are in the
prompt, and §5.3 already reserves the keys.

### 4.4 Aggregate

Group surviving claims by slot. `min_minutes` is the lowest observed and
`max_minutes` the highest; the planner reads `max_minutes` per §7.2's conservative
rule. Confidence is computed, not asked:

| distinct posts backing the slot | confidence |
|---|---|
| 1 | `low` |
| 2 | `medium` |
| 3+ | `high` |

One blogger having a bad Saturday is not evidence about Saturdays, and a model asked
to self-report confidence will not reliably say so. This also makes §11's precision
target tunable by moving a threshold rather than editing a prompt. Per §7.3,
low and medium confidence enter the planner as a soft constraint.

## 5. Freshness and scheduling

### 5.1 The 48-hour rule does not apply here

§7.4's table places `── except ── itinerary date within 48h · force refresh,
blocking` below all three TTL rows, but its justification is entirely about 임시휴무:
*"announced ~2 days out… so the cache cannot hide exactly the failure the Validation
Agent was built to catch."* That is `hours` and `closed_days`.

Applying it to `review_digest` would put an Apify run plus a model call — seconds to
minutes — on a user's request path, which §7.5 forbids, in order to sharpen a value
§7.3 classifies as soft. **The blocking refresh covers `hours` and `closed_days`
only. `review_digest` is always served from cache, however stale.**

### 5.2 Reads never block

`store.ts` (this spec's `facts.ts`; see §2) returns whatever row exists and reports
`stale: ttl_until < now()`. It never triggers a refresh inline; no read path calls Apify. A place with no row
returns a null digest, which the UI renders as 웨이팅 정보 없음 — a state it must
handle regardless.

### 5.3 Writes happen on a cron

No `vercel.json` exists. This adds `vercel.ts` (the current recommendation over JSON,
and typed):

```ts
crons: [{ path: '/api/internal/refresh-facts', schedule: '0 * * * *' }]
```

Hourly rather than §7.5's nightly. A Vercel Function caps at 300s and an Apify run is
seconds to minutes, so a single nightly invocation cannot walk the set. Hourly
batches achieve what §7.5 actually asks for — research load off the request path —
without introducing a queue.

The route is `withRoute`-wrapped, verifies `CRON_SECRET`, and lives under
`/api/internal/` so it is visibly outside the public contract in `openapi.yaml`.

Selection per run:

```sql
select p.id
  from places p
  join saved_places sp on sp.place_id = p.id and sp.status <> 'rejected'
  left join place_facts f on f.place_id = p.id
 where f.ttl_until is null or f.ttl_until < now()
 group by p.id, f.ttl_until
 order by f.ttl_until nulls first
 limit 20;
```

`nulls first` means a place saved twenty minutes ago is digested before one a day past
TTL. Concurrency capped at 3 with jitter per §7.5.

### 5.4 Cost

At a 14-day TTL, 500 distinct saved places is ~36 refreshes per day × 10 posts ≈
**$0.16/day of Apify** plus ~36 model calls. `source_trace.posts` removes the model
call when the retrieved set is unchanged. This does not need a budget conversation.

### 5.5 No circuit breaker

§7.5 specifies one for the Naver Place *scrape*, where Gaja issues the requests.
Here Apify absorbs blocking and rate-limiting, and `ApifyError` plus the retry policy
already in `lib/ingest/apify.ts` is the entire failure surface. If the actor is down
the digest stays stale, which is the designed behaviour rather than a degradation
worth a breaker.

## 6. Failure modes

Per §10 — degrade loudly, never silently.

| area | failure | handling |
|---|---|---|
| research | Apify unreachable / `ApifyError` | digest untouched, `degraded = true` if a row exists; retried next hour |
| research | actor returns 0 parseable items from >0 rows | **log loudly** — a shape change, not an empty result |
| research | quote is not a substring of its cited body | drop the claim |
| research | claim carries no valid slot | schema rejects — §7.3's discard rule, enforced |
| research | zero posts match the place | write an **empty** digest, not null |
| research | model call fails | leave the row untouched; do not advance `ttl_until` |

A place with no `place_facts` row yet has nothing to mark `degraded` on, and none is
created — a failed first refresh leaves the place exactly as it was, unvisited, and
the selection query picks it up again next hour. `degraded` means *"this row was
built from less than we wanted"*, which is only meaningful once a row exists.

**Empty digest is not a null digest.** `{}` with a fresh `fetched_at` means *we looked
and there is nothing*; `null` means *never checked*. Collapsing them makes a place
with genuinely no wait data indistinguishable from one the cron has not reached, and
the UI must say different things.

## 7. Testing

§11 already specifies the eval for this stage: *hand-labelled review sets, precision
on wait claims, weighted toward false negatives*. Concretely, ~20 real posts across
~5 성수 places, hand-labelled, precision as the gate.

Pure functions, tested with no network and no model:

- body matching, including `name_alt` variants and NFC/space normalisation
- the quote-substring check, including a deliberately fabricated quote
- confidence thresholds at the 1 / 2 / 3-post boundaries
- slot-enum rejection of an unqualified claim
- range aggregation across disagreeing posts
- empty-versus-null digest

**Scheduled contract test, for the reason §12/2a already gives.** A circuit breaker
catches blocking but not a changed response *shape*, which returns 200 and quietly
poisons `place_facts` — the argument that made a contract test mandatory for Naver
Place. The identical risk applies here and is sharper: both Naver actors are
community-maintained, as `lib/ingest/naver/actors.ts` records. A weekly job fetches
one fixed, known-stable blog post and asserts the mapped fields against recorded
values. `lib/ingest`'s `.loose()` schemas stop a shape change from throwing; this is
what stops it passing unnoticed.

**Demo fixtures** per §11: freeze real Apify responses for the ~5 places so a demo
cannot be broken by an actor hiccup.

## 8. New dependencies

| package | kind | why |
|---|---|---|
| `ai` | runtime | AI SDK v6 structured output; first model call in the repo |
| `vitest` | dev | the pure functions above need a runner; `scripts/smoke.sh` drives real HTTP and cannot test them. `node --test` on Node 20 cannot run TypeScript without a build step |
| `@vercel/config` | dev | `vercel.ts` for the cron entry |

`server-only` was already added when `lib/ingest` landed.

Environment: `APIFY_TOKEN` (existing), `CRON_SECRET` (new), plus AI Gateway
credentials from the Vercel project.

## 9. What this changes in the 2026-09-18 spec

| § | change |
|---|---|
| 5.3 | `review_digest` shape sharpened — typed minutes, closed-vocabulary slot keys, evidence objects carrying URL and date |
| 7.1 | `ReviewSource` added as a sibling to `PlaceSource`; Naver Blog implements only it |
| 7.4 | the 48-hour blocking refresh is scoped to `hours` and `closed_days`; `review_digest` is never refreshed on the request path |
| 7.5 | nightly pre-warm becomes hourly batches, for the function timeout; no circuit breaker for this source |
| 12/3 | the official blog API is confirmed but not used — it returns snippets, and §7.3's qualifier rule needs bodies |
| 12/2a | the build-vs-buy is answered for blog text only; Naver Place remains open |

## 10. Out of scope

- Kakao, Google and Naver Place adapters; `hours`, `closed_days`, `price_band`,
  `rating`, and the §7.2 merge policy
- Instagram ingestion (slice 3) — `lib/ingest/instagram` is built and unused
- The planner consuming `review_digest`; this writes it, §8 reads it
- Surfacing waits in the UI beyond what is needed to see the digest is working
- `vibe` and `warnings` as product features — populated, not yet rendered
