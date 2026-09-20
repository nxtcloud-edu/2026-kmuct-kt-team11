/**
 * A `PlaceCandidate` (a creator's claim, parsed) into a `places.id` (a row).
 *
 * This is the step lib/extract/types.ts says has not happened — "Nothing here has
 * been geocoded, deduped against `places`, or checked against a place source" —
 * and the one lib/ingest/save-reel.ts names as the reason every saved row is born
 * `place_id = null, status = 'pending'`.
 *
 * Two moving parts and no third: geocode the address (lib/research/geocode.ts),
 * then hand the point to the SAME find-or-create the `POST /api/places` write
 * boundary uses (lib/places.ts). There is deliberately no second dedupe here. A
 * separate one for reel-sourced places would eventually disagree with the one for
 * hand-entered places, and the two would stop collapsing onto each other — which
 * is the exact duplicate a user notices, because they saved the café by hand in
 * March and shared a reel about it in April.
 *
 * NOTHING HERE WRITES `saved_places`. It returns ids; saveReel attaches them
 * inside its own transaction. Keeping the network calls outside that transaction
 * is not stylistic — `tx()` checks out a pooled client and holds it for the
 * duration, and lib/db.ts runs a pool of ONE per instance on Vercel. Ten
 * sequential HTTPS round trips inside a transaction is a connection held for
 * several seconds while every other request on that instance waits for it.
 */

import { findOrCreatePlace } from '../places';
import type { PlaceCategory } from '../api/types';
import type { PlaceCandidate, PlaceCandidateCategory } from '../extract/types';
import { GeocodeRequestError, GeocoderNotConfiguredError, geocodeAddress } from './geocode';

/**
 * THE TWO CATEGORY UNIONS AGREE, PROVEN AT BUILD TIME.
 *
 * `PlaceCandidateCategory` is restated in lib/extract/types.ts rather than
 * imported from lib/api/types.ts, because scripts/test-ladder.mjs compiles
 * lib/extract/ alone and an import reaching out of that directory makes tsc
 * refuse it (TS6059). This file is the only one that holds both, so this is
 * where the duplication is checked. Each parameter's DEFAULT is the other file's
 * union and its CONSTRAINT is this file's, and TypeScript checks a default
 * against its constraint — so a sixth category added to either list and not the
 * other fails `npx tsc --noEmit` right here, naming both types. The body is a
 * tuple of the two parameters for no reason but to use them; the assertion is
 * entirely in the `extends` clauses.
 */
export type CategoryUnionsAgree<
  Extracted extends PlaceCategory = PlaceCandidateCategory,
  Api extends PlaceCandidateCategory = PlaceCategory,
> = [Extracted, Api];

/**
 * Between geocode calls. Ten venues therefore cost ~1.2s of deliberate waiting
 * on top of the requests themselves.
 *
 * SEQUENTIAL, NOT CONCURRENT, and that is the decision rather than an oversight:
 * firing ten simultaneous requests the moment a reel arrives is a burst against a
 * per-second quota, and it buys nothing — the caller is the DM poller
 * (lib/ingest/inbox/), a background job with nobody waiting on the latency. If a
 * user-facing caller ever appears, the right answer is a small bounded pool, not
 * removing the limit.
 */
const GAP_MS = 120;

/**
 * Why one candidate did not produce a place. Returned rather than thrown so the
 * caller can log which venues fell out of a reel without the reel failing.
 */
export type ResolveFailure =
  /** The caption gave no address. `deriveConfidence` already treats this as weak. */
  | 'no-address'
  /** Geocoded cleanly and matched nothing — a wrong or too-vague address. */
  | 'not-found'
  /** The request itself failed: transport, timeout, 401, 429, 5xx. */
  | 'geocode-failed'
  /** Naver found the point but named no 동 and no 구, and `places.area` is NOT NULL. */
  | 'no-area'
  /**
   * Nobody could say what kind of place this is: the extractor returned no
   * category or a low-confidence one, and the caller offered no reel-level
   * fallback either. `places.category` is NOT NULL, so the choice was between
   * writing a guess and not writing a row, and not writing is the one that can
   * be corrected later — the candidate's name, address and hours are still in
   * `reels.extracted`, and the reel is `needs_review`.
   */
  | 'no-category';

export type ResolvedCandidate = {
  ordinal: number;
  placeId: string | null;
  failure: ResolveFailure | null;
  /** True when an existing `places` row was matched instead of a new one written. */
  matched: boolean;
};

export type ResolveOptions = {
  /**
   * THE REEL-LEVEL FALLBACK, and nothing more. Still required to pass, so the
   * decision stays visible at the call site; `null` is a legal and honest value.
   *
   * The history matters, because the shape changed for a reason. This used to be
   * the ONLY answer: `places.category` is NOT NULL with a CHECK, a caption says
   * 📍 and a name and never "restaurant", and defaulting to `'cafe'` here would
   * have written a guess into a column that reads as a fact. That left the caller
   * holding the reel's title (`여름 날에 다녀오기 좋은 카페 10곳`) as the only
   * evidence in the system.
   *
   * It is no longer the only evidence. `PlaceCandidate.category` now carries a
   * per-venue classification with its own confidence, produced by the step that
   * was already reading the caption — a listicle of ten cafés with one 소품샵 in
   * it is a real thing, and one category for the whole reel cannot describe it.
   * So the order is: the candidate's own answer when it is confident, this when
   * it is not, and `'no-category'` when neither can say. A title that names no
   * kind of place (`서울에서 꼭 가봐야 할 10곳`) should pass `null` rather than a
   * guess — an unresolved row is recoverable and a wrong category is not.
   */
  category: PlaceCategory | null;
};

/**
 * Which category this candidate gets written with, or null for none.
 *
 * `'low'` is treated as no answer at all. That is the whole safety argument for
 * asking a model to classify: a guess the extractor itself flagged as a guess
 * must not become a fact, and lib/ingest/save-reel.ts reads the same field to
 * send the reel to `needs_review`. Exported so the rule is testable and so the
 * two files cannot drift on what "low" means.
 */
export function categoryFor(
  candidate: Pick<PlaceCandidate, 'category' | 'category_confidence'>,
  fallback: PlaceCategory | null,
): PlaceCategory | null {
  if (candidate.category && candidate.category_confidence !== 'low') return candidate.category;
  return fallback;
}

/**
 * Resolve one candidate. Never throws for a data reason; see `ResolveFailure`.
 *
 * `GeocoderNotConfiguredError` is the one exception and is allowed to propagate:
 * a missing credential is a deployment mistake that applies to every candidate in
 * every reel, and swallowing it would turn a broken deploy into a quiet stream of
 * unresolved rows that looks exactly like a run of bad addresses.
 */
export async function resolvePlaceCandidate(
  candidate: PlaceCandidate,
  options: ResolveOptions,
): Promise<ResolvedCandidate> {
  const unresolved = (failure: ResolveFailure): ResolvedCandidate => ({
    ordinal: candidate.ordinal,
    placeId: null,
    failure,
    matched: false,
  });

  if (!candidate.address?.trim()) return unresolved('no-address');

  // Decided BEFORE the geocode, not after: a candidate nobody can categorise is
  // not going to become a row, and spending a Naver request plus the 120ms gap
  // on it is ten wasted round trips on a reel the extractor could not read.
  const category = categoryFor(candidate, options.category);
  if (!category) return unresolved('no-category');

  let point;
  try {
    point = await geocodeAddress(candidate.address);
  } catch (e) {
    if (e instanceof GeocoderNotConfiguredError) throw e;
    if (e instanceof GeocodeRequestError) return unresolved('geocode-failed');
    throw e;
  }

  if (!point) return unresolved('not-found');
  if (!point.area) return unresolved('no-area');

  const { place, matched } = await findOrCreatePlace({
    // The creator's own script, never romanised — the alias goes in name_alt,
    // which is what lib/extract/types.ts keeps them separate for.
    name: candidate.name,
    name_alt: candidate.name_alt ? [candidate.name_alt] : [],
    category,
    lat: point.lat,
    lng: point.lng,
    // Naver's canonical 도로명 form, not the creator's string. Two captions
    // writing `서울 마포구 망원로3길 7` and `서울특별시 마포구 망원로3길 7` are the same
    // address, and storing what was typed keeps that difference alive forever.
    address: point.roadAddress,
    area: point.area,
  });

  return { ordinal: candidate.ordinal, placeId: place.id, failure: null, matched };
}

/**
 * Resolve a whole reel's worth, in caption order, one at a time.
 *
 * Every candidate gets a result — the array is the same length as the input and
 * in the same order — so a caller can report "7 of 10 resolved" without
 * reconciling two lists. Losing the reel because one of ten addresses is wrong is
 * the failure this shape exists to make impossible.
 */
export async function resolvePlaceCandidates(
  candidates: readonly PlaceCandidate[],
  options: ResolveOptions,
): Promise<ResolvedCandidate[]> {
  const out: ResolvedCandidate[] = [];
  for (const candidate of candidates) {
    if (out.length > 0) await sleep(GAP_MS);
    out.push(await resolvePlaceCandidate(candidate, options));
  }
  return out;
}

/**
 * The `ordinal -> place_id` map `saveReel` takes, built from the results above.
 * Unresolved ordinals are absent rather than present-and-null, so the seam
 * carries one meaning: a key here is a place, and everything else is pending.
 */
export function placeIdsByOrdinal(resolved: readonly ResolvedCandidate[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const r of resolved) if (r.placeId) map.set(r.ordinal, r.placeId);
  return map;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
