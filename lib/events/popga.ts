/**
 * popga — 팝업스토어 listings, from a real public JSON API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS OF SERVICE. This one is clean, and it is worth saying so out loud
 * because its sibling (yanolja.ts) is not.
 *
 * `GET https://popga.co.kr/api/spots/search` is the endpoint popga's own pages
 * call. No auth header, no cookie, no signature, no CSRF token; a plain
 * server-side fetch with a browser User-Agent answers 200 with
 * `application/json`. Nothing here is reverse-engineered from a bundle and
 * nothing is disguised. One request per week, for five records.
 *
 * If popga ever puts a key on it, this file should stop working loudly (401 →
 * `EventSourceRefusedError` → breaker) rather than start pretending to be a
 * browser harder. That is a decision, not an oversight.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT WE ASK FOR AND WHY.
 *
 *   periodTypes[]=IN_PROGRESS,READY   running now, or announced and not open
 *                                     yet. The two states a person can plan
 *                                     around. Everything else has ended.
 *   sorts[0].order=activated_at       popga's own recency ranking. We keep the
 *                                     order it returns — see `rank`.
 *
 * WHAT COMES BACK IS NOT ALL POPUPS. Measured on a live response: 60 records
 * carried four `type` values — STORE 19, FESTIVAL 19, PERFORMANCE 13,
 * EXHIBITION 9. popga is a 팝업 site that also lists what else is on.
 *
 * ONLY `STORE` IS KEPT, and the other three are dropped rather than mapped:
 *
 *   FESTIVAL    is a 축제 — 광안리 드론쇼, running 2026-01-01 to 2026-12-31. It is
 *               not a popup and it is not one of our six categories. Filing it
 *               under 팝업 would put a year-long civic event in a feed whose
 *               whole promise is "this is on for three weeks".
 *   PERFORMANCE and EXHIBITION overlap the yanolja categories, and the same show
 *               appears on both sites. Taking them from both sources would
 *               duplicate 〈꽃의 비밀〉 in the 연극 tab under two different ids,
 *               because `unique (source, source_id)` dedupes within a source and
 *               has no way to see across one.
 *
 * `types[]` was tried as a server-side filter and is ignored by the endpoint —
 * verified live, the response came back with the same four types — so the filter
 * is applied here, which is why `PAGE_SIZE` asks for far more than five.
 */

import { isAllowedPosterUrl } from './poster-hosts';
import {
  EVENTS_PER_CATEGORY,
  EventSourceRefusedError,
  EventSourceUnavailableError,
  SCRAPER_TIMEOUT_MS,
  SCRAPER_USER_AGENT,
  type ScrapedEvent,
} from './types';

const ENDPOINT = 'https://popga.co.kr/api/spots/search';

/**
 * Asked for in one request, then filtered to STORE and trimmed to five.
 *
 * 60 rather than 5 because the server-side `types` filter does not work (above)
 * and STORE was ~32% of a measured page — five STOREs need roughly sixteen
 * records, and the margin is for the day a festival season skews the mix. One
 * request of 60 is cheaper than paging until five popups turn up, and it bounds
 * the cost at exactly one round trip whatever the mix happens to be.
 */
const PAGE_SIZE = 60;

/**
 * A popga spot's public page. `/popup/{id}` — verified 200 against a live id;
 * `/spot/{id}` and `/spots/{id}` both 404, so this is not a guess at a pattern.
 *
 * Built rather than read from the payload because the payload's own `link` field
 * is null on every record measured — it is for a brand's external landing page,
 * not for popga's own detail view.
 */
function bookUrl(id: number): string {
  return `https://popga.co.kr/popup/${id}`;
}

/** Only the fields this module reads. The response carries ~35 more. */
type PopgaSpot = {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  address?: unknown;
  addressDetail?: unknown;
  openDate?: unknown;
  closeDate?: unknown;
  area?: { region2Depth?: unknown } | null;
  file?: { path?: unknown } | null;
};

/**
 * The pure half: a parsed response body in, listings out. No fetch, no clock, no
 * database — so scripts/test-events.sh can compile and exercise it on its own
 * against a synthesised fixture.
 *
 * Skips rather than throws on a malformed record. One record missing an id in a
 * page of sixty is popga's problem and should cost us that record; throwing
 * would cost us the pass, and a pass that fails is a category that shows nothing.
 */
export function parsePopgaSpots(body: unknown): ScrapedEvent[] {
  const content = (body as { data?: { content?: unknown } } | null)?.data?.content;
  if (!Array.isArray(content)) {
    // A shape change, not an empty result. `{ data: { content: [] } }` is a legal
    // empty page and reaches the caller as an empty array; a MISSING `content` is
    // the API having changed underneath us, and the two must not look alike.
    throw new EventSourceUnavailableError('popga', 'response had no data.content array');
  }

  const out: ScrapedEvent[] = [];
  for (const raw of content) {
    const spot = raw as PopgaSpot;
    if (spot?.type !== 'STORE') continue;

    const id = typeof spot.id === 'number' ? spot.id : null;
    const title = str(spot.title);
    if (id === null || !title) continue;

    out.push({
      source: 'popga',
      sourceId: String(id),
      category: 'popup',
      title,
      // `addressDetail` is the floor-and-unit line — `더현대 서울 B1 와인웍스`, and
      // sometimes just `3층`. Thin on its own, which is why the card pairs it
      // with `area` and falls back to the street address.
      venue: str(spot.addressDetail),
      address: str(spot.address),
      area: str(spot.area?.region2Depth),
      posterUrl: posterOrNull(spot.file?.path),
      bookUrl: bookUrl(id),
      opensOn: isoDate(spot.openDate),
      closesOn: isoDate(spot.closeDate),
      // Filled in below, after the filter — a record's position among the
      // POPUPS, not among the sixty mixed records it arrived with.
      rank: 0,
    });
    if (out.length >= EVENTS_PER_CATEGORY) break;
  }

  return out.map((e, rank) => ({ ...e, rank }));
}

/** One live request. Throws the two documented errors and nothing else. */
export async function fetchPopgaPopups(): Promise<ScrapedEvent[]> {
  const url = new URL(ENDPOINT);
  // Bracket-indexed query parameters, Spring's array binding convention.
  // `URLSearchParams` percent-encodes the brackets, which the endpoint accepts —
  // verified live against the encoded form.
  url.searchParams.set('periodTypes[0]', 'IN_PROGRESS');
  url.searchParams.set('periodTypes[1]', 'READY');
  url.searchParams.set('sorts[0].order', 'activated_at');
  url.searchParams.set('size', String(PAGE_SIZE));
  url.searchParams.set('page', '0');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': SCRAPER_USER_AGENT, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
    });
  } catch (e) {
    throw new EventSourceUnavailableError(
      'popga',
      `request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 401/403/429 is popga declining on purpose; everything else that is not 2xx is
  // popga having a bad minute. The first trips the breaker, the second retries
  // tomorrow — see the migration for why that distinction is load-bearing.
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new EventSourceRefusedError('popga', res.status);
  }
  if (!res.ok) throw new EventSourceUnavailableError('popga', `returned ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new EventSourceUnavailableError('popga', 'returned a body that was not JSON');
  }

  return parsePopgaSpots(body);
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * A poster URL we are configured to render, or null.
 *
 * The check is `lib/events/poster-hosts.ts`, the same list `next.config.ts` is
 * built from. Storing a URL `next/image` will refuse means a 400 and a broken
 * card; storing null means the card draws its placeholder. Both are "no
 * picture"; only one of them looks broken.
 */
function posterOrNull(v: unknown): string | null {
  const s = str(v);
  return s && isAllowedPosterUrl(s) ? s : null;
}

/** A non-empty trimmed string, or null. Empty strings are absent, not blank. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * popga dates arrive already as `YYYY-MM-DD`. Validated rather than trusted,
 * because `events.opens_on` is a `date` column and a malformed string would fail
 * the whole batch insert on one bad row — the shape is checked here so a bad
 * date costs that field and nothing else.
 */
function isoDate(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
