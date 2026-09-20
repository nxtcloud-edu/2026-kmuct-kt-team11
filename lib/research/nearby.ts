/**
 * "What else is near here?" — the orchestration. SERVER ONLY.
 *
 * One anchor place in, a list of PROPOSED venues out, each carrying the post it
 * was read from. Nothing here writes to the database and nothing here geocodes:
 * discovery proposes, the user disposes. The whole module is a read.
 *
 * ── THE CHAIN, AND WHY EVERY LINK IS ONE THAT ALREADY EXISTED ──────────────
 *
 *   anchor.area ─┬─> sources/naver-blog.ts  (adapted, see `naverAsNearbySource`)
 *                └─> sources/instagram.ts
 *                        │  NearbyPost[]  (each with a URL that is not optional)
 *                        ▼
 *                 lib/extract/caption.ts   extractPlacesFromCaption
 *                        │  PlaceCandidate[]
 *                        ▼
 *                 dedupe + drop the anchor  ──> NearbyCandidate[]
 *
 * The extractor is `extractPlacesFromCaption` and not a new parser, because it is
 * the one that was measured against real Korean venue listicles and because two
 * answers to "what venues did this text name?" in one codebase is how the two
 * start disagreeing. It is a caption parser being shown a blog body in the Naver
 * case; see `BLOG_BODY_CHARS` for why that is acceptable and what it costs.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 * It does not geocode, it does not call `findOrCreatePlace`, and it does not
 * insert a `saved_places` row. Every candidate below is A CLAIM IN SOMEONE
 * ELSE'S POST — the same class of thing as `hours_raw` on the place-detail
 * screen, and governed by the same rule from
 * `docs/gaja/reel-extraction-findings.md`: a creator's words are a prior to
 * verify, not ground truth. Writing one of these into `places` would launder a
 * stranger's sentence into a Gaja record, and `places` is the table the planner
 * reads. The user's route to a real row is the one that already exists: open it
 * in Naver Map, then save it.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * One call here is at most: 2 Apify actor runs (10 Naver posts + 12 reels) and
 * `MAX_EXTRACTIONS` Gemini flash-lite calls. Both caps live in code, not in a
 * parameter, so no caller can raise them. Nothing runs on page load — see the
 * route and the screen; the button is the intent.
 */

import { extractPlacesFromCaption } from '../extract/caption';
import type { PlaceCandidate } from '../extract/types';
import type { Place, PlaceCategory } from '../api/types';
import { ApifyError, ApifyNotConfiguredError, apifyConfigured } from '../ingest/apify';
import { instagram } from './sources/instagram';
import { naverBlog } from './sources/naver-blog';
import {
  fold,
  searchWord,
  type NearbyPost,
  type NearbyQuery,
  type NearbySource,
  type NearbySourceName,
  type NearbySourceResult,
  type NearbySourceStatus,
} from './nearby-source';

/**
 * How far back a post may be and still describe a place worth walking to. A café
 * written up two years ago is as likely closed as open, and an undated post is
 * dropped rather than assumed recent (see the sources).
 */
const MAX_AGE_MONTHS = 12;

/**
 * THE GEMINI CAP, and the second of the two bills this feature runs up.
 *
 * Fourteen is the arithmetic of the source caps (10 Naver + 12 Instagram = 22
 * possible posts) cut to what a single request can afford: at four at a time,
 * fourteen flash-lite calls over ~1–4 KB each finish in a few seconds, and the
 * marginal post is the lowest-ranked one from whichever source returned more.
 * Sources are interleaved before this slice is taken, so the cap never silently
 * becomes "Naver only".
 */
const MAX_EXTRACTIONS = 14;

/** Four at a time. Enough to hide the latency, small enough not to be a burst against a per-minute quota. */
const EXTRACT_CONCURRENCY = 4;

/**
 * A Naver blog body is prose with a numbered list somewhere in it, and
 * `extractPlacesFromCaption` is prompted for Instagram captions. Truncating to
 * 4 KB is the honest trade: the venue list in a 맛집 roundup is near the top,
 * the tail is 협찬 disclosure and the writer's sign-off, and a 30 KB body would
 * cost real tokens to read past the part that matters. A blog the truncation
 * cuts in half yields fewer venues — which shows up as fewer cards, never as
 * wrong ones.
 */
const BLOG_BODY_CHARS = 4000;

/** Nothing here is a Gaja fact. The type name says candidate; so does every field's provenance. */
export type NearbyCandidate = {
  /** Stable within one result set. React key and nothing else — not an id, not a row. */
  key: string;
  /** The venue name as the writer wrote it. Never romanised, never corrected. */
  name: string;
  /** The Latin alias, when the writer put one in parentheses. */
  nameAlt: string | null;
  /** The address AS WRITTEN IN THE POST. Not geocoded, not canonicalised, frequently null. */
  address: string | null;
  category: PlaceCategory | null;
  /** The extractor's own hedge. `'low'` is shown as a hedge, never hidden. */
  categoryConfidence: 'low' | 'medium' | 'high' | null;
  source: NearbySourceName;
  /** THE RECEIPT. Never null — a candidate without one is dropped upstream. */
  sourceUrl: string;
  /** The post's title, or a reel's first line. */
  sourceTitle: string;
  /** The author's handle, without the `@`. Null when the source named none. */
  sourceHandle: string | null;
  /** ISO. The post's date, not the venue's. */
  postedAt: string | null;
  /** A remote URL. Gaja stores no third-party media; see the screen for how it is rendered. */
  thumbUrl: string | null;
};

export type NearbySourceReport = {
  source: NearbySourceName;
  status: NearbySourceStatus;
  /** Rows the actor returned, before parsing. */
  rows: number;
  /** Posts that survived parsing and the recency filter. */
  posts: number;
  /** Venues extracted from those posts, before dedupe. */
  candidates: number;
};

export type NearbyResult = {
  /** The 동 the search was built around. */
  area: string;
  /** What was actually searched, so the user can see the question we asked. */
  keyword: string;
  candidates: NearbyCandidate[];
  /** One entry per source, always both, whatever happened to each. */
  sources: NearbySourceReport[];
  /** Venues folded away as duplicates of another card or of the anchor itself. */
  deduped: number;
};

/** No credential, so nothing was attempted and nothing was billed. Distinct from "the scraper is broken". */
export class NearbyNotConfiguredError extends Error {
  constructor(readonly variable: string) {
    // Names the variable, never the value. An error message is the single most
    // likely place a secret escapes, because it is the one string that gets logged.
    super(`${variable} is not set; lib/research/nearby.ts cannot run a nearby search.`);
    this.name = 'NearbyNotConfiguredError';
  }
}

/**
 * `NaverBlogSource` adapted to `NearbySource`, rather than rewritten as one.
 *
 * It takes a `Place` and a `since`, and its MATCH filter (§4.2 of the wait-digest
 * spec) drops any post whose body mentions neither the place's name nor an alias.
 * Both of those do the right thing here once the synthetic place is built the
 * right way round: `name` is the 동, so the actor's keyword becomes `성수동 카페`
 * AND the match filter becomes "the body must mention 성수동" — which is exactly
 * the guard this surface wants. A roundup that never says 성수동 is not about
 * 성수동, whatever the search engine thought.
 *
 * The coordinate fields are zeroed and `NaverBlogSource` never reads them. That
 * is stated rather than assumed — `lib/agent/tools.ts` builds the same synthetic
 * place for the same source and says so in the same words.
 */
function naverAsNearbySource(): NearbySource {
  return {
    name: 'naver_blog',
    async find({ area, category, since }: NearbyQuery): Promise<NearbyPost[]> {
      const place: Place = {
        id: '',
        name: area,
        name_alt: [],
        category: category ?? 'cafe',
        lat: 0,
        lng: 0,
        address: null,
        area: searchWord(category),
      };

      const reviews = await naverBlog.reviews(place, since);
      return reviews.map((r) => ({
        source: 'naver_blog' as const,
        url: r.url,
        title: r.title,
        body: r.body,
        postedAt: r.postedAt,
        // Naver's blog actor returns no cover image in the shape this repo reads,
        // and inventing one from the body's first <img> would mean parsing HTML
        // out of a field we asked for as text. A card without a thumbnail is a
        // designed state (see the screen), not a defect.
        thumbUrl: null,
        authorHandle: null,
      }));
    },
  };
}

/** Runs one source and converts every failure into a reported status. Never throws. */
async function runSource(source: NearbySource, query: NearbyQuery): Promise<NearbySourceResult> {
  try {
    const posts = await source.find(query);
    return {
      source: source.name,
      // `no-rows` would need the untransformed dataset length, which the sources
      // do not surface; what IS available is "the source returned nothing at
      // all", and that is reported as `no-rows` so it reads as the alarm it is.
      // A source that returned posts which then produced no venues reports
      // `no-posts` below, after extraction — the two silences stay separate.
      status: posts.length > 0 ? 'ok' : 'no-rows',
      rows: posts.length,
      posts,
    };
  } catch (e) {
    if (e instanceof ApifyNotConfiguredError) {
      return { source: source.name, status: 'not-configured', rows: 0, posts: [] };
    }
    if (e instanceof ApifyError) {
      // The message can carry an upstream body; log it, never return it — a
      // gateway's HTML has no business in a problem response.
      console.error(`[nearby] source ${source.name} failed:`, e.message);
      return { source: source.name, status: 'failed', rows: 0, posts: [] };
    }
    console.error(`[nearby] source ${source.name} threw:`, e);
    return { source: source.name, status: 'failed', rows: 0, posts: [] };
  }
}

/**
 * Interleave the sources' posts before the extraction cap is applied.
 *
 * Without this, `slice(0, MAX_EXTRACTIONS)` over a concatenation spends the
 * whole budget on whichever source is listed first, and a user whose Instagram
 * run happened to return twelve posts would silently never see a blog result.
 * The cap has to cut the tail of both lists, not the whole of one.
 */
function interleave(lists: NearbyPost[][]): NearbyPost[] {
  const out: NearbyPost[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/** Bounded-concurrency map. Results keep input order; a rejected task yields null. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        // One bad caption must not cost the other thirteen. The null shows up as
        // a post that contributed no venues, which is an ordinary outcome.
        console.error('[nearby] extraction failed for one post:', e);
        out[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function toCandidate(post: NearbyPost, c: PlaceCandidate, index: number): NearbyCandidate {
  return {
    key: `${post.source}:${post.url}:${c.ordinal}:${index}`,
    name: c.name,
    nameAlt: c.name_alt,
    address: c.address,
    category: c.category,
    categoryConfidence: c.category_confidence,
    source: post.source,
    sourceUrl: post.url,
    sourceTitle: post.title,
    // The venue's own handle, when the caption gave one, is a better attribution
    // than the poster's — it is who the card is ABOUT. Falls back to the poster.
    sourceHandle: c.handle ?? post.authorHandle,
    postedAt: post.postedAt ? post.postedAt.toISOString() : null,
    thumbUrl: post.thumbUrl,
  };
}

/**
 * Find venues written about near an anchor place.
 *
 * Throws `NearbyNotConfiguredError` and nothing else. Every other failure is
 * reported per source in the result, because half a screen of blog results is
 * worth far more than an error page that hides them.
 */
export async function findNearbyPlaces(anchor: {
  name: string;
  area: string;
  category: PlaceCategory | null;
}): Promise<NearbyResult> {
  // Checked BEFORE anything is spent, and named individually: "we did not look"
  // and "we looked and found nothing" are different sentences and the user is
  // owed the right one.
  if (!apifyConfigured()) throw new NearbyNotConfiguredError('APIFY_TOKEN');
  if (!process.env.GEMINI_API_KEY) throw new NearbyNotConfiguredError('GEMINI_API_KEY');

  const since = new Date();
  since.setMonth(since.getMonth() - MAX_AGE_MONTHS);

  const query: NearbyQuery = { area: anchor.area, category: anchor.category, since };
  const keyword = `${anchor.area} ${searchWord(anchor.category)}`;

  // Concurrent, not sequential: two 90s actor runs back to back is three minutes
  // and the platform's function ceiling is five. Nothing shared between them, so
  // there is no ordering to preserve.
  const results = await Promise.all(
    [naverAsNearbySource(), instagram].map((s) => runSource(s, query)),
  );

  const posts = interleave(results.map((r) => r.posts)).slice(0, MAX_EXTRACTIONS);

  const extracted = await mapLimit(posts, EXTRACT_CONCURRENCY, async (post) => {
    const text = post.source === 'naver_blog' ? post.body.slice(0, BLOG_BODY_CHARS) : post.body;
    const out = await extractPlacesFromCaption(text);
    return { post, places: out.places };
  });

  // Folded name -> already taken. Seeded with the anchor so the place you are
  // standing in is never proposed as somewhere to go next, which is the single
  // most obvious way this screen could look broken.
  const seen = new Set<string>([fold(anchor.name)]);
  const perSource = new Map<NearbySourceName, number>();
  const candidates: NearbyCandidate[] = [];
  let deduped = 0;

  extracted.forEach((hit, i) => {
    if (!hit) return;
    perSource.set(hit.post.source, (perSource.get(hit.post.source) ?? 0) + hit.places.length);

    for (const place of hit.places) {
      const key = fold(place.name);
      // Two writers naming the same café is the normal case, not the exception —
      // that is what a neighbourhood roundup IS. First mention wins, and the
      // count is reported rather than swallowed so a screen showing three cards
      // out of thirty extractions does not look like a broken scraper.
      if (key.length === 0 || seen.has(key)) {
        deduped++;
        continue;
      }
      seen.add(key);
      candidates.push(toCandidate(hit.post, place, i));
    }
  });

  return {
    area: anchor.area,
    keyword,
    candidates,
    sources: results.map((r) => {
      const found = perSource.get(r.source) ?? 0;
      return {
        source: r.source,
        // THE FOURTH STATE. The source ran, returned posts, and none of them
        // named a venue we could read. That is not `no-rows` (the scraper
        // returned nothing, which is the actor-rot signature) and it is not
        // `failed`. Collapsing the three is how a dead scraper passes for a
        // quiet neighbourhood — discovery spec §8.
        status: r.status === 'ok' && found === 0 ? 'no-posts' : r.status,
        rows: r.rows,
        posts: r.posts.length,
        candidates: found,
      };
    }),
    deduped,
  };
}
