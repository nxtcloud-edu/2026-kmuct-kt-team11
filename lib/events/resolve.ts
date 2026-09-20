/**
 * An event's address into a `places.id`, so that tapping 저장 has somewhere to point.
 *
 * TWO MOVING PARTS AND NO THIRD, exactly as lib/research/resolve-place.ts has
 * for reels: geocode the address (lib/research/geocode.ts), then hand the point
 * to the SAME find-or-create the `POST /api/places` write boundary uses
 * (lib/places.ts). There is deliberately no geocoder and no dedupe of its own in
 * here. Design §5.1 calls place identity the highest-bug-density area of the
 * model, and a second implementation is how one venue comes to exist twice.
 *
 * This is NOT a copy of `resolvePlaceCandidate`. That function takes a
 * `PlaceCandidate` — an extractor's guess at a venue from a reel caption, with a
 * per-venue confidence and a reel-level category fallback — and none of those
 * inputs exist here. An event's category is known (it is the feed tab it came
 * from) and its address, when there is one, was published by a listing site
 * rather than inferred from a caption. Sharing a signature would mean
 * constructing a fake candidate to call it with. What IS shared is everything
 * below the seam: the same geocoder, the same find-or-create, and — see
 * `EventResolution` — the same vocabulary for why a resolution failed, so the
 * two paths read alike in a log.
 *
 * NOTHING HERE WRITES `events`. It returns a place id and a status; `store.ts`
 * attaches them. Keeping network calls out of the caller's transaction is not
 * stylistic — lib/db.ts runs a pool of ONE per instance on Vercel, and a handful
 * of sequential HTTPS round trips inside a transaction is that instance's only
 * connection held for several seconds while everything else waits.
 */

import { findOrCreatePlace } from '../places';
import { GeocodeRequestError, GeocoderNotConfiguredError, geocodeAddress } from '../research/geocode';
import { PLACE_CATEGORY_FOR_EVENT, type ScrapedEvent } from './types';

/**
 * The `events.place_status` values, spelled the same as
 * `lib/research/resolve-place.ts`'s `ResolveFailure` on purpose. The reel path
 * and the event path fail for the same four reasons and a reader comparing two
 * log lines should not have to translate.
 */
export type EventResolution =
  | 'resolved'
  /** The source published no address. The normal case for yanolja; not an error. */
  | 'no-address'
  /** Geocoded cleanly and matched nothing — a wrong or too-vague address. */
  | 'not-found'
  /** The request itself failed: transport, timeout, 401, 429, a 5xx. */
  | 'geocode-failed'
  /** Naver found the point but named no 동 and no 구, and `places.area` is NOT NULL. */
  | 'no-area';

export type ResolvedEvent = {
  placeId: string | null;
  status: EventResolution;
  /** The 동/구 the geocode derived, when it derived one. Overwrites the source's label. */
  area: string | null;
};

/** Between geocodes, when a pass resolves several. A weekly job has nobody waiting. */
const GAP_MS = 120;

/**
 * Resolve one event. Never throws for a data reason.
 *
 * `GeocoderNotConfiguredError` is the one exception and is allowed to propagate,
 * for the reason the reel resolver gives: a missing credential applies to every
 * event in every category, and swallowing it turns a broken deploy into a quiet
 * stream of unresolved rows that looks exactly like a run of bad addresses.
 */
export async function resolveEventPlace(event: ScrapedEvent): Promise<ResolvedEvent> {
  const unresolved = (status: EventResolution): ResolvedEvent => ({
    placeId: null,
    status,
    area: event.area,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // THE EXPECTED OUTCOME FOR MOST YANOLJA EVENTS, AND IT IS NOT A FAILURE.
  //
  // `NOL 유니플렉스 1관` is a hall, not a location. The payload carries no street
  // address and there is nothing to geocode. The alternative — geocoding the
  // VENUE NAME as if it were an address — would sometimes return the right
  // building and sometimes return a shop with a similar name in another city,
  // and there is no way to tell which from the response. A wrong pin on a user's
  // saved map is worse than no pin, because it is silent.
  //
  // The event still appears in the feed and still links out to book. It just
  // cannot be saved, and the screen says so.
  // ──────────────────────────────────────────────────────────────────────────
  if (!event.address?.trim()) return unresolved('no-address');

  let point;
  try {
    point = await geocodeAddress(event.address);
  } catch (e) {
    if (e instanceof GeocoderNotConfiguredError) throw e;
    if (e instanceof GeocodeRequestError) return unresolved('geocode-failed');
    throw e;
  }

  if (!point) return unresolved('not-found');
  if (!point.area) return unresolved('no-area');

  const { place } = await findOrCreatePlace({
    // ────────────────────────────────────────────────────────────────────────
    // THE PLACE IS NAMED AFTER THE EVENT, NOT AFTER THE BUILDING.
    //
    // A popup is the destination. Somebody who saves 영풍문고 X 고양이와 스프 팝업
    // is going to see that popup, and a pin reading `여의도 IFC몰 L2층` tells them
    // nothing about why it is on their map. The venue goes in `name_alt`, which
    // is what that column is for.
    //
    // This also keeps `findOrCreatePlace`'s 50m-plus-fuzzy-name rule doing the
    // right thing in both directions. Two popups running at 더현대 서울 at the same
    // time are two outings and stay two pins, because their names are nothing
    // alike. The SAME popup seen by next week's scrape collapses onto the row
    // this one wrote, because the name is identical — which is the dedupe that
    // actually matters here, since this job re-reads the same listings every
    // week for as long as they run.
    // ────────────────────────────────────────────────────────────────────────
    name: event.title,
    name_alt: event.venue ? [event.venue] : [],
    category: PLACE_CATEGORY_FOR_EVENT[event.category],
    lat: point.lat,
    lng: point.lng,
    // Naver's canonical 도로명 form, not the string the listing printed. Two
    // sources writing `서울 영등포구 국제금융로 10` and `서울특별시 영등포구 국제금융로 10`
    // mean one address, and storing what was typed keeps that difference alive.
    address: point.roadAddress,
    area: point.area,
  });

  return { placeId: place.id, status: 'resolved', area: point.area };
}

/**
 * Resolve a batch, one at a time, in order.
 *
 * SEQUENTIAL, NOT CONCURRENT, for the reason lib/research/resolve-place.ts
 * gives: firing every request at once is a burst against a per-second NCP quota
 * and buys nothing, because the caller is a weekly cron with nobody waiting on
 * the latency. Every input gets a result at the same index, so a caller can
 * report "3 of 5 resolved" without reconciling two lists.
 */
export async function resolveEventPlaces(events: readonly ScrapedEvent[]): Promise<ResolvedEvent[]> {
  const out: ResolvedEvent[] = [];
  for (const event of events) {
    // Only paid for when a request is actually going to happen. Most yanolja
    // events return `no-address` without touching the network, and sleeping
    // between those would add half a second per genre for nothing.
    if (out.length > 0 && event.address?.trim()) await sleep(GAP_MS);
    out.push(await resolveEventPlace(event));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
