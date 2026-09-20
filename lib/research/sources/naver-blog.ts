/**
 * The only Naver-aware file. SERVER ONLY.
 *
 * Implements `ReviewSource` (lib/research/review-source.ts) over the Apify actor
 * the wait-digest spec §1 names: `maximedupre/naver-blog-review-scraper`. The
 * boundary the spec §2 restates twice holds here — nothing above `lib/research`
 * knows Apify exists, and nothing above this file knows Naver does. A caller
 * sees `ReviewText[]` and nothing else.
 *
 * WHY the actor rather than `openapi.naver.com/v1/search/blog`, which exists and
 * is free: the official endpoint returns a ~200-character `description` snippet.
 * §7.3's rule is that an unqualified wait is not a wait — the qualifier
 * ("토요일 오후에 갔는데") is routinely a hundred characters from the number it
 * qualifies, so the rule cannot be enforced against snippets. The actor returns
 * full post bodies from the same keyword search.
 *
 * Two contract guarantees this file owes its callers, both enforced here rather
 * than asked of the transport:
 *
 *   RECENCY — no `ReviewText` older than `since` is ever returned. It goes to
 *   the actor as `dateFrom` so Apify is not paid to fetch what we would discard,
 *   AND it is re-applied after mapping, because a source that silently ignores
 *   an input parameter would otherwise break the contract invisibly.
 *
 *   MATCH — §4.2. A post whose body mentions neither the place's name nor any
 *   alias is dropped, NFC-normalised and space-stripped. This fails closed: a
 *   성수동 roundup naming twelve cafés survives for all twelve, which is correct
 *   because it is about all twelve, while a post about a different café with a
 *   similar name does not.
 */

import { runActor, ApifyError } from '../../ingest/apify';
import type { Place } from '../../api/types';
import type { ReviewSource, ReviewText } from '../review-source';

/**
 * Pinned by full id, and overridable by env for one reason only: if the actor is
 * renamed or forked, that is a deployment change rather than a code change. The
 * default is the actor the spec chose, so an unset variable is not a failure.
 */
const ACTOR = process.env.APIFY_NAVER_BLOG_ACTOR ?? 'maximedupre/naver-blog-review-scraper';

/**
 * Ten is the spec's own costing unit (§5.4: ~10 posts per refresh, $0.16/day at
 * 500 places). More posts do not buy proportionally more signal — Naver's own
 * relevance ordering puts the on-topic posts first, and the tail is 협찬 copy.
 */
const MAX_POSTS = 10;

/**
 * The actor's output shape belongs to the actor, not to us, and it can change
 * without a version bump. So: read every plausible key, require only what a
 * `ReviewText` cannot be built without, and let `mapPost` return null rather
 * than throw. A shape change then shows up as "0 parseable items from >0 rows",
 * which §6 says to log loudly — it is a different event from "no results".
 */
type RawPost = Record<string, unknown>;

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** First non-empty string among several candidate keys. */
function pick(raw: RawPost, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(raw[k]);
    if (v) return v;
  }
  return null;
}

/**
 * Naver writes blog dates as `2026. 9. 20.` as often as ISO, and the actor
 * passes through whatever the post showed. `new Date()` parses the ISO form and
 * returns Invalid Date for the Korean one, so the dotted form is handled
 * explicitly. An unparseable date is not coerced to "now" — a post that claims
 * no date must not survive a recency filter it was never measured against.
 */
function parsePostedAt(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = str(v);
  if (!s) return null;

  const dotted = s.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?$/);
  if (dotted) {
    const [, y, m, d] = dotted;
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function mapPost(raw: RawPost): ReviewText | null {
  const url = pick(raw, ['url', 'link', 'postUrl', 'blogUrl']);
  const body = pick(raw, ['bodyText', 'content', 'text', 'body', 'description']);
  const postedAt = parsePostedAt(raw.postedAt ?? raw.postDate ?? raw.date ?? raw.publishedAt);

  // A quote has to be followable and datable to be a receipt (§7.3), and the
  // substring check downstream runs against `body`. Missing any of the three
  // makes the row unusable rather than partially usable.
  if (!url || !body || !postedAt) return null;

  return {
    source: 'naver_blog',
    url,
    body,
    postedAt,
    title: pick(raw, ['title', 'postTitle']) ?? '',
  };
}

/**
 * NFC so that a decomposed Hangul jamo sequence compares equal to its composed
 * form — Naver serves both — and whitespace-stripped so "성수 커피" matches
 * "성수커피". Case-folded for the Latin aliases (`UIG` vs `uig`).
 */
function fold(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, '').toLowerCase();
}

export class NaverBlogSource implements ReviewSource {
  readonly name = 'naver_blog' as const;

  async reviews(place: Place, since: Date): Promise<ReviewText[]> {
    // §4.1's query: the name plus the area. The area is what separates two
    // venues that share a name, and Naver's blog index is area-heavy.
    const keyword = `${place.name} ${place.area}`.trim();

    const items = await runActor(
      ACTOR,
      {
        // REQUIRED, AND ITS ABSENCE IS WHY THIS SOURCE NEVER ONCE RAN. The actor
        // rejects the whole input at validation with
        // `Field input.target is required`, so every Naver search 400'd before
        // it started and the screen reported "read failed" for a request that
        // had not been made. `keyword` selects a search; `postUrls` would mean
        // "scrape exactly these posts", which is not what we are doing.
        //
        // The previous input guessed at parameter names and sent several
        // spellings of each, on the theory that an actor ignores what it does
        // not recognise so a wrong guess degrades to "unfiltered". That is true
        // of unknown OPTIONAL fields and says nothing about a required one it
        // had never heard of — which is the case that actually occurred. These
        // are now the ten names in the actor's published input schema, nothing
        // invented: target, keyword, sortBy, dateFrom, dateTo,
        // sponsorshipFilter, maxItems, postUrls, contentFormat,
        // includeEngagement.
        target: 'keyword',
        keyword,
        maxItems: MAX_POSTS,
        dateFrom: since.toISOString().slice(0, 10),
        // §4.1: the bodies are already in the response at this setting, so
        // asking for text costs nothing extra over asking for HTML.
        contentFormat: 'text',
      },
      { timeoutSecs: 90 },
    );

    const mapped = items
      .map((i) => mapPost((i ?? {}) as RawPost))
      .filter((p): p is ReviewText => p !== null);

    if (items.length > 0 && mapped.length === 0) {
      // §6: a shape change, not an empty result. The two have different fixes —
      // one is "the actor changed", the other is "this place has no coverage" —
      // so they must not look the same in the logs.
      console.error(
        `[naver-blog] actor ${ACTOR} returned ${items.length} rows and 0 parseable posts for "${keyword}". Output shape may have changed.`,
      );
    }

    const names = [place.name, ...place.name_alt].map(fold).filter((n) => n.length > 0);

    return mapped
      // RECENCY, re-applied. `dateFrom` is a request, not a guarantee.
      .filter((p) => p.postedAt >= since)
      // MATCH (§4.2), failing closed.
      .filter((p) => {
        const body = fold(p.body);
        return names.some((n) => body.includes(n));
      })
      .slice(0, MAX_POSTS);
  }
}

export const naverBlog = new NaverBlogSource();
export { ApifyError };
