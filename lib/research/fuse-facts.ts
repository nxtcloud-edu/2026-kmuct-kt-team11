/**
 * Layer 2 — fusion. Source-agnostic (design §4): it reads only `SourceFacts`
 * and never re-parses a source format. Its jobs, in order:
 *
 *   1. merge several sources into one `PlaceFacts` row,
 *   2. keep ratings PER SOURCE (never averaged, §5.3),
 *   3. record which source asserted which field, and when (`source_trace`),
 *   4. mark `degraded` when a source failed or a field is missing,
 *   5. compute the re-fetch boundary (`ttl_until`).
 *
 * Grading a `price_band` needs a price signal, so it is injected
 * (`GradePriceBand`) and this function stays pure and testable. The
 * `review_digest` is not injected but CARRIED: it is produced by a separate
 * pipeline from a separate family of sources (see `FusedReviewDigest`). When
 * either is absent the corresponding field is left null and the row is degraded
 * — honest partial data rather than a guess.
 */

import type { PlaceSourceName, SourceFacts } from './source-facts';
import type {
  PlaceFacts,
  PriceBand,
  RatingBySource,
  ReviewDigest,
  ReviewSourceName,
  SourceTrace,
} from './place-facts';

/** Default cache lifetime. Hours change rarely; a week keeps us off the source. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FuseOptions = {
  /** When `now` + this is the ttl. Defaults to one week. */
  ttlMs?: number;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /** Grades a price band from the raw hints each source left. Optional. */
  gradePriceBand?: GradePriceBand;
  /**
   * The digest to write into this row, already produced, with its provenance.
   * Absent ⇒ the row carries no digest and is degraded.
   *
   * `fuseFacts` has no memory: a caller that is NOT re-running the digest
   * pipeline passes forward the digest it read from the store, or the upsert
   * blanks a digest that was fine.
   */
  reviewDigest?: FusedReviewDigest;
  /**
   * Sources we intended to fetch. If a name here is absent from `facts`, that
   * source failed and the row is degraded. Defaults to the sources present.
   */
  expectedSources?: PlaceSourceName[];
};

export type GradePriceBand = (facts: SourceFacts[]) => PriceBand | null;

/**
 * A digest plus the provenance to record for it.
 *
 * WHY this is a value and not a `summariseReviews` injector like
 * `gradePriceBand`: the digest is not made from `SourceFacts`. It is made by
 * `digest.ts` from `ReviewText[]` that a `ReviewSource` retrieved (wait-digest
 * §2, §4), on its own hourly cron, from a different family of sources than the
 * `PlaceSource` adapters this function fuses. A synchronous injector here could
 * not express that pipeline's own failure rule either — §6 says a failed model
 * call leaves the row UNTOUCHED, where a summariser returning null would
 * instead mark the row degraded and overwrite a good digest with a blank one.
 * So the seam leaves `fuseFacts` entirely and this function only carries the
 * result, which keeps it pure, synchronous and free of a model dependency.
 *
 * `digest` is non-nullable on purpose: "no digest" is expressed by omitting the
 * option, and an EMPTY digest (`{}`) is a complete answer — §6's "we looked and
 * there is nothing", distinct from never having checked.
 */
export type FusedReviewDigest = {
  digest: ReviewDigest;
  source: ReviewSourceName;
  /** ISO 8601, when the digest was produced. */
  at: string;
  /** URLs of the posts it was built from. */
  posts: string[];
};

/**
 * Fuse the facts several sources returned for ONE place into a single row.
 * `facts` may be empty (every source failed): the result is a fully degraded
 * row, which is still worth writing so ttl throttles the retry.
 */
export function fuseFacts(
  placeId: string,
  facts: SourceFacts[],
  opts: FuseOptions = {},
): PlaceFacts {
  const now = (opts.now ?? (() => new Date()))();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  const trace: SourceTrace = {};
  let degraded = false;

  // Which sources did we mean to have? Missing ones ⇒ degraded.
  const expected = opts.expectedSources ?? facts.map((f) => f.source);
  const present = new Set(facts.map((f) => f.source));
  if (expected.some((s) => !present.has(s))) degraded = true;
  if (facts.length === 0) degraded = true;

  // ── hours / closedDays: first source that has them wins; record provenance ──
  // "First wins" is deliberate and paired with source_trace so the choice is
  // visible and overridable later (source priority is a layer-2 policy, not a
  // parse concern). A richer policy replaces only this block.
  let hours: PlaceFacts['hours'] = null;
  let closedDays: PlaceFacts['closedDays'] = null;
  for (const f of facts) {
    if (!hours && f.hours) {
      hours = f.hours;
      trace.hours = { source: f.source, at: f.fetchedAt };
    }
    if (!closedDays && f.closedDays) {
      closedDays = f.closedDays;
      trace.closed_days = { source: f.source, at: f.fetchedAt };
    }
  }
  if (!hours) degraded = true;

  // ── rating: per source, never averaged (§5.3) ──────────────────────────────
  const rating: RatingBySource = {};
  for (const f of facts) {
    if (typeof f.rating === 'number') {
      rating[f.source] = f.rating;
      trace[`rating.${f.source}`] = { source: f.source, at: f.fetchedAt };
    }
  }
  if (Object.keys(rating).length === 0) degraded = true;

  // ── price band: injected grader over all sources' hints ─────────────────────
  let priceBand: PriceBand | null = null;
  if (opts.gradePriceBand) {
    priceBand = opts.gradePriceBand(facts);
    if (priceBand) {
      // Attribute to the earliest-fetched source that carried price hints; the
      // grader is source-agnostic, so provenance is best-effort here.
      const src = facts[0];
      if (src) trace.price_band = { source: src.source, at: src.fetchedAt };
    } else {
      degraded = true;
    }
  } else {
    degraded = true;
  }

  // ── review digest: carried in, produced elsewhere (see FusedReviewDigest) ──
  let reviewDigest: ReviewDigest | null = null;
  const rd = opts.reviewDigest;
  if (rd) {
    reviewDigest = rd.digest;
    trace.review_digest = { source: rd.source, at: rd.at, posts: rd.posts };
  } else {
    degraded = true;
  }

  return {
    placeId,
    fetchedAt: now.toISOString(),
    ttlUntil: new Date(now.getTime() + ttlMs).toISOString(),
    hours,
    closedDays,
    priceBand,
    rating,
    reviewDigest,
    degraded,
    sourceTrace: trace,
  };
}
