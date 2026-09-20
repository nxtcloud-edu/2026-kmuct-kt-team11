/**
 * yanolja (NOL 티켓) — 공연 listings, read out of a framework's private payload.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS OF SERVICE. READ THIS BEFORE CHANGING ANYTHING IN HERE.
 *
 * THERE IS NO API. `https://nol.yanolja.com/ticket/genre/{genre}` server-renders
 * its listings; the only client-side call the page makes is
 * `/nol-api/nol-display/navigation-bar`, which is the nav and not the data.
 * What this file parses is the React Server Components FLIGHT PAYLOAD — the
 * `self.__next_f.push([1, "…"])` chunks Next.js emits to stream a server render
 * to the client. That is a FRAMEWORK'S PRIVATE SERIALISATION FORMAT. It is not
 * documented, not versioned, not a contract, and not offered to us.
 *
 * Unlike popga.ts, which uses a public JSON endpoint the way it is meant to be
 * used, THIS IS PARSED WITHOUT PERMISSION. It will break the next time yanolja
 * deploys — not "might", will, eventually, with no warning and no deprecation
 * notice. Every design decision below assumes that.
 *
 * Whoever maintains this: the popup half of the feed is durable and this half is
 * borrowed. If yanolja publishes a real API, or an affiliate feed, take it and
 * delete this file. If they put the listings behind auth, let it break — do not
 * make this pretend harder to be a browser.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A ZERO IS NOT A SUCCESS HERE.
 *
 * docs/superpowers/specs/2026-09-20-gaja-discovery-design.md §8: a source that
 * returns zero where it previously returned many is the signature of rot, not of
 * a quiet week, and it must record a DISTINCT outcome rather than a success with
 * no rows — because "succeeded, found nothing" is exactly what a dead scraper
 * looks like from the outside. This module therefore returns an empty array
 * without complaint and lets `run.ts` compare it against `event_sources.peak_count`,
 * which is the only thing that remembers what this page used to yield.
 *
 * TWO PAYLOAD SHAPES, AND THE SECOND ONE IS WHY THE ALARM IS PER-CATEGORY.
 * Measured live while building this:
 *
 *   /genre/{exhibition,play,musical,concert}
 *       `{"type":"PRODUCT_ITEM","data":{ id, action.web, thumbnail, title,
 *         locationDetails[], dateInfo }}`
 *       → 30, 55, 41, 50 records respectively.
 *
 *   /genre/sports
 *       ZERO `PRODUCT_ITEM`. Nine records in an entirely different shape —
 *       `{ goodsCode, goodsName, placeName, playStartDate, playEndDate,
 *          posterImageUrl, landingInfo }` — because a fixture list is not a
 *       product list and the page renders it from a different query.
 *
 * A single parser would have reported sports as empty, forever, while four other
 * genres worked — which is precisely the false alarm that teaches people to
 * ignore a real one. Both shapes are parsed. A per-SOURCE breaker would also
 * have taken the whole of yanolja down over sports alone, which is why the
 * breaker is keyed by category.
 */

import { isAllowedPosterUrl } from './poster-hosts';
import {
  EVENTS_PER_CATEGORY,
  EventSourceRefusedError,
  EventSourceUnavailableError,
  SCRAPER_TIMEOUT_MS,
  SCRAPER_USER_AGENT,
  type EventCategory,
  type ScrapedEvent,
} from './types';

/** Our five categories are five genre slugs. `popup` is not here; that is popga's. */
export const YANOLJA_GENRE: Record<Exclude<EventCategory, 'popup'>, string> = {
  exhibition: 'exhibition',
  play: 'play',
  musical: 'musical',
  concert: 'concert',
  sports: 'sports',
};

export type YanoljaCategory = keyof typeof YANOLJA_GENRE;

/**
 * Extracts the flight payload from a page's HTML.
 *
 * Next streams the server render as a series of `self.__next_f.push([1, "…"])`
 * calls whose second element is a JSON STRING LITERAL — so the chunks are pulled
 * out with the quotes still on and handed to `JSON.parse` to unescape them,
 * rather than unescaped by hand. Doing it by hand is how `\\u003c` and a literal
 * backslash before a quote end up mangled, and a mangled payload fails silently
 * by matching nothing.
 *
 * The regex tolerates any escape (`[^"\\]|\\.`) so a chunk containing an escaped
 * quote — which most of them do, the payload is nested JSON — is not cut in half.
 *
 * Exported for the test: this is the one piece of this file that can be checked
 * against a synthesised fixture without touching the network.
 */
export function extractFlightPayload(html: string): string {
  const chunks = html.match(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g) ?? [];
  let out = '';
  for (const chunk of chunks) {
    const literal = chunk.slice(chunk.indexOf(',') + 1, -2);
    try {
      const decoded: unknown = JSON.parse(literal);
      if (typeof decoded === 'string') out += decoded;
    } catch {
      // One unparseable chunk is a chunk, not a page. Skipping it loses a slice
      // of the payload and may lose a record; throwing would lose the category.
    }
  }
  return out;
}

/**
 * Pulls out every complete JSON object in `payload` that starts with `marker`.
 *
 * A brace-counting scan rather than a regex, because these objects nest several
 * levels deep and no regular expression can match balanced braces. It tracks
 * string state so a `}` inside `"NOL 유니플렉스 1관"` — or inside an escaped quote
 * — does not close an object early. That is not hypothetical: yanolja titles
 * contain `〈`, `《`, `＆`, and at least one contains a brace.
 *
 * An object that will not parse is skipped. The payload is a stream of a render,
 * not a document, and a truncated tail is normal.
 */
export function scanJsonObjects(payload: string, marker: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (true) {
    i = payload.indexOf(marker, i);
    if (i < 0) break;

    let depth = 0;
    let j = i;
    let inString = false;
    let escaped = false;
    for (; j < payload.length; j++) {
      const ch = payload[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        j++;
        break;
      }
    }

    if (depth === 0 && j > i) {
      try {
        out.push(JSON.parse(payload.slice(i, j)));
      } catch {
        // Unbalanced or truncated. Skip the record, keep the pass.
      }
    }
    // Always advance past this marker, parsed or not — `j` sits at the start of
    // the marker when the scan ran off the end, and reusing it would spin.
    i = j > i ? j : i + marker.length;
  }
  return out;
}

/* ── Shape 1: PRODUCT_ITEM (exhibition / play / musical / concert) ─────────── */

const PRODUCT_MARKER = '{"type":"PRODUCT_ITEM","data":';

type ProductItem = {
  data?: {
    id?: unknown;
    title?: unknown;
    thumbnail?: unknown;
    dateInfo?: unknown;
    locationDetails?: unknown;
    action?: { web?: unknown } | null;
  } | null;
};

/* ── Shape 2: the sports fixture list ─────────────────────────────────────── */

const SPORTS_MARKER = '{"goodsCode":';

type SportsGoods = {
  goodsCode?: unknown;
  goodsName?: unknown;
  placeName?: unknown;
  playStartDate?: unknown;
  playEndDate?: unknown;
  posterImageUrl?: unknown;
};

/**
 * The pure half: a page's HTML in, listings out. No fetch, no clock, no
 * database — scripts/test-events.sh compiles this module alone.
 *
 * Returning `[]` is a legal answer and is NOT thrown over. See the header: the
 * caller is the one holding the memory of what this page used to return, and
 * only it can tell an empty genre from a broken parser.
 */
export function parseYanoljaGenre(html: string, category: YanoljaCategory): ScrapedEvent[] {
  const payload = extractFlightPayload(html);
  const out: ScrapedEvent[] = [];

  for (const raw of scanJsonObjects(payload, PRODUCT_MARKER)) {
    const item = (raw as ProductItem).data;
    if (!item) continue;

    const sourceId = str(item.id);
    const title = str(item.title);
    // `action.web` is yanolja's OWN canonical link for the product, so it is used
    // rather than built from the id. A link we constructed would be a guess that
    // works until their routing changes; this one is what their card links to.
    const bookUrl = str(item.action?.web);
    if (!sourceId || !title || !bookUrl) continue;

    const { opensOn, closesOn } = parseDateInfo(str(item.dateInfo));

    out.push({
      source: 'yanolja',
      sourceId,
      category,
      title,
      // `locationDetails` is an array because a touring show lists several halls.
      // The first is the one the card shows; the rest are lost, and that is
      // acceptable for a browse feed whose job is to get you to the booking page.
      venue: Array.isArray(item.locationDetails) ? str(item.locationDetails[0]) : null,
      // NO ADDRESS EXISTS IN THIS PAYLOAD. `NOL 유니플렉스 1관` is a hall name, not
      // a location, and this is the reason most yanolja events never resolve to a
      // `places` row and therefore cannot be saved to a map. Not a bug; see the
      // migration.
      address: null,
      area: null,
      posterUrl: posterOrNull(item.thumbnail),
      bookUrl,
      opensOn,
      closesOn,
      rank: out.length,
    });
    if (out.length >= EVENTS_PER_CATEGORY) break;
  }

  // Only reached when the product list yielded nothing — which is every run for
  // `sports` and, if this file rots, a run for anything. Trying the second shape
  // unconditionally would double the scan cost of four healthy genres to catch a
  // case that cannot co-occur with them.
  if (out.length > 0) return out;

  for (const raw of scanJsonObjects(payload, SPORTS_MARKER)) {
    const g = raw as SportsGoods;
    const sourceId = str(g.goodsCode);
    const title = str(g.goodsName);
    if (!sourceId || !title) continue;

    out.push({
      source: 'yanolja',
      sourceId,
      category,
      title,
      venue: str(g.placeName),
      address: null,
      area: null,
      posterUrl: posterOrNull(g.posterImageUrl),
      // This shape carries no `action` object. `/ticket/products/{goodsCode}`
      // 308s to the team's own page and resolves 200 — verified live against
      // 26005455, which lands on `/ticket/genre/sports/bears`. Following the
      // redirect ourselves to store the final URL would freeze a routing detail
      // that is theirs to change.
      bookUrl: `https://nol.yanolja.com/ticket/products/${encodeURIComponent(sourceId)}`,
      opensOn: isoDate(g.playStartDate),
      closesOn: isoDate(g.playEndDate),
      rank: out.length,
    });
    if (out.length >= EVENTS_PER_CATEGORY) break;
  }

  return out;
}

/** One live request for one genre page. */
export async function fetchYanoljaGenre(category: YanoljaCategory): Promise<ScrapedEvent[]> {
  const url = `https://nol.yanolja.com/ticket/genre/${YANOLJA_GENRE[category]}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': SCRAPER_USER_AGENT, Accept: 'text/html' },
      cache: 'no-store',
      signal: AbortSignal.timeout(SCRAPER_TIMEOUT_MS),
    });
  } catch (e) {
    throw new EventSourceUnavailableError(
      'yanolja',
      `${category} request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new EventSourceRefusedError('yanolja', res.status);
  }
  if (!res.ok) throw new EventSourceUnavailableError('yanolja', `${category} returned ${res.status}`);

  return parseYanoljaGenre(await res.text(), category);
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

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

/**
 * `"26.07.01 ~ 26.09.27"` → `{ opensOn: '2026-07-01', closesOn: '2026-09-27' }`.
 *
 * TWO-DIGIT YEARS, EXPANDED AS 20YY, and that is not a Y2K shrug — it is what
 * the data means. A measured record reads `10.01.20 ~ 26.10.31`: 어둠속의대화 has
 * been running in 북촌 since January 2010 and is booked through October 2026.
 * Pivoting on "50" or on the current year would have read that open date as
 * 1910 or refused it, and a null open date on a long-running exhibition is a
 * card that cannot say how long it has been there.
 *
 * A single date with no `~` is treated as a one-day run — both ends set — which
 * is how the feed's "ended" filter keeps a one-night concert for exactly one day.
 */
export function parseDateInfo(info: string | null): {
  opensOn: string | null;
  closesOn: string | null;
} {
  if (!info) return { opensOn: null, closesOn: null };
  const parts = info.split('~').map((p) => p.trim());
  const open = shortDate(parts[0]);
  const close = parts.length > 1 ? shortDate(parts[1]) : open;
  return { opensOn: open, closesOn: close };
}

/** `26.09.27` → `2026-09-27`. Anything else → null. */
function shortDate(s: string | undefined): string | null {
  const m = s?.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  // Range-checked rather than trusted: `events.opens_on` is a `date` column and
  // `2026-13-45` would fail the insert for the whole batch.
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${yy}-${mm}-${dd}`;
}

/** Already `YYYY-MM-DD` in the sports shape. Validated, not trusted. */
function isoDate(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
