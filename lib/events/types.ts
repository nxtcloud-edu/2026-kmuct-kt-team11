/**
 * The vocabulary the events feed is written in.
 *
 * Kept free of `pg`, `next` and every other runtime import on purpose: both
 * scrapers, the pure parsers and their tests all reach in here, and
 * scripts/test-events.sh compiles the parsers ALONE. A side-effecting import in
 * this file breaks that script loudly rather than quietly coupling a string
 * table to Postgres.
 */

import type { EventCategory, PlaceCategory } from '../api/types';

export type { EventCategory };

/**
 * SIX, and the split is by SOURCE as much as by meaning: `popup` is everything
 * popga gives us, and the other five are one yanolja genre page each
 * (`/ticket/genre/{exhibition,play,musical,concert,sports}`). That correspondence
 * is why there is no `festival` here even though popga returns FESTIVAL records
 * — see `popga.ts` for what is kept and dropped.
 */
/**
 * Annotated `readonly EventCategory[]` rather than inferred `as const`: the union
 * itself lives in lib/api/types.ts because it crosses the wire, and the
 * annotation is what makes a value added here — but not there — fail tsc instead
 * of silently widening the runtime list past the contract. The three
 * `Record<EventCategory, …>` tables below catch the other direction.
 */
export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'popup',
  'exhibition',
  'play',
  'musical',
  'concert',
  'sports',
];

export type EventSourceName = 'popga' | 'yanolja';

/** Which scraper owns which category. Mirrors the seed rows in the migration. */
export const SOURCE_FOR_CATEGORY: Record<EventCategory, EventSourceName> = {
  popup: 'popga',
  exhibition: 'yanolja',
  play: 'yanolja',
  musical: 'yanolja',
  concert: 'yanolja',
  sports: 'yanolja',
};

/**
 * Display order, and it is by FAMILIARITY rather than by alphabet or by source.
 * 팝업 first because it is the thing Gaja's users are already hunting for on
 * Instagram; 스포츠 last because it is the one category that regularly has
 * nothing in it. Serial position effect: the first and last chips are the two a
 * person remembers, so the strongest goes first and the thinnest goes where it
 * costs least.
 */
export const EVENT_CATEGORY_ORDER: EventCategory[] = [
  'popup',
  'exhibition',
  'musical',
  'concert',
  'play',
  'sports',
];

/** Every word a user reads is Korean; the enum is English because the CHECK is. */
export const EVENT_CATEGORY_KO: Record<EventCategory, string> = {
  popup: '팝업',
  exhibition: '전시',
  musical: '뮤지컬',
  concert: '콘서트',
  play: '연극',
  sports: '스포츠',
};

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SIX EVENT CATEGORIES ONTO FIVE PLACE CATEGORIES. THIS MAPPING IS LOSSY AND
 * THE LOSS IS THE POINT OF THIS COMMENT.
 *
 * `places.category` is NOT NULL with a five-value CHECK —
 * `cafe|restaurant|exhibition|shop|activity` — and saving an event writes a
 * `places` row, so every event category has to land somewhere in that five.
 * There is no 공연 value and adding one is a migration against `places` that
 * would touch the map legend, the filter rail and `lib/categories.ts`; it is not
 * something this feature gets to do on its way past.
 *
 *   popup      → shop        A 팝업스토어 is retail. It sells things over a
 *                            counter and then stops existing — which is exactly
 *                            `shop` plus a close date, and the close date lives
 *                            on `events`, not on `places`.
 *
 *   exhibition → exhibition  The one honest one-to-one in the table.
 *
 *   musical  ┐
 *   concert  ├→ activity     A ticketed thing that happens at a time. `activity`
 *   play     │                (체험) is the loosest of the five and therefore the
 *   sports   ┘                only one that does not actively lie: a 뮤지컬 is
 *                            not a 전시, not a 가게, and certainly not a café.
 *                            It is the residual bucket and it is being used as
 *                            one, knowingly.
 *
 * WHAT THIS COSTS: a user who saves 웨스턴 스토리 and 강원FC vs 제주 finds both
 * filed under 체험 on their map, next to a pottery class. If that becomes the
 * complaint, the fix is a sixth value on `places.category` — not a cleverer
 * mapping here, because there is no sixth bucket in five to be clever with.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const PLACE_CATEGORY_FOR_EVENT: Record<EventCategory, PlaceCategory> = {
  popup: 'shop',
  exhibition: 'exhibition',
  musical: 'activity',
  concert: 'activity',
  play: 'activity',
  sports: 'activity',
};

/**
 * One listing, as a scraper produces it and before anything has been geocoded,
 * deduped or written. The shape both scrapers agree on; nothing downstream
 * branches on which source a record came from except to report.
 */
export type ScrapedEvent = {
  source: EventSourceName;
  /** The source's own identifier. Unique within `source`, and text — yanolja's is `a:b`. */
  sourceId: string;
  category: EventCategory;
  title: string;
  /** As the source names it. `NOL 유니플렉스 1관`, `충무아트센터 갤러리`. */
  venue: string | null;
  /** A street address, or null. Null is the common case for yanolja and is not an error. */
  address: string | null;
  /**
   * The source's own neighbourhood label, when it has one — popga's
   * `area.region2Depth` (`성수`, `여의도`). A HINT, not an authority: the geocode
   * overwrites it when the event resolves, because `망원동` derived from
   * coordinates is a fact and `망원` printed by a listing site is a label.
   */
  area: string | null;
  /** Remote URL. Never downloaded; `next.config.ts` allowlists the host. */
  posterUrl: string | null;
  /** Where 예매하기 goes. A record without one is dropped by its scraper. */
  bookUrl: string;
  /** `YYYY-MM-DD`, or null when the source did not say. */
  opensOn: string | null;
  closesOn: string | null;
  /** Position in the source's own ordering, 0-based. The feed renders in this order. */
  rank: number;
};

/**
 * HOW MANY OF EACH WE KEEP. Five, per the product decision — a browse feed, not
 * a catalogue. Applied at the point the scraper trims, so the network cost is
 * one request per category regardless.
 */
export const EVENTS_PER_CATEGORY = 5;

/**
 * A shared browser User-Agent for both scrapers.
 *
 * Not a disguise — both requests are for public pages, one of them through a
 * documented JSON endpoint. It is here because a bare `node-fetch`/`undici`
 * default UA is refused or served a different document by a fair number of
 * Korean CDNs, and a scraper that silently receives the mobile shell instead of
 * the page is the failure mode this whole file exists to make visible.
 */
export const SCRAPER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Nothing hangs forever. An unbounded fetch holds a function until the platform kills it. */
export const SCRAPER_TIMEOUT_MS = 15_000;

/**
 * The source said no, on purpose — 401, 403, 429. Distinct from a timeout or a
 * 5xx, and the ONLY thing that trips the breaker: see the migration for why an
 * automatic retry into a refusal is the behaviour that gets an IP blocked.
 */
export class EventSourceRefusedError extends Error {
  constructor(
    readonly source: EventSourceName,
    readonly status: number,
  ) {
    super(`${source} refused the request with ${status}`);
    this.name = 'EventSourceRefusedError';
  }
}

/**
 * The request did not produce an answer: transport failure, timeout, 5xx, a body
 * that would not parse. A bad minute at the vendor, and therefore a retry
 * tomorrow rather than a breaker trip.
 */
export class EventSourceUnavailableError extends Error {
  constructor(
    readonly source: EventSourceName,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = 'EventSourceUnavailableError';
  }
}
