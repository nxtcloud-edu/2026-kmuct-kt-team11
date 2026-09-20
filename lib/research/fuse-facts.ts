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
 * Grading a `price_band` and producing a `review_digest` need a price signal and
 * an LLM respectively; those are injected (`GradePriceBand`, `SummariseReviews`)
 * so this function stays pure, testable, and free of a model dependency. When an
 * injector is absent the corresponding field is left null and the row is degraded
 * — honest partial data rather than a guess.
 */

import type { PlaceSourceName, SourceFacts } from './source-facts';
import type { PlaceFacts, PriceBand, RatingBySource, ReviewDigest, SourceTrace } from './place-facts';

/** Default cache lifetime. Hours change rarely; a week keeps us off the source. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FuseOptions = {
  /** When `now` + this is the ttl. Defaults to one week. */
  ttlMs?: number;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /** Grades a price band from the raw hints each source left. Optional. */
  gradePriceBand?: GradePriceBand;
  /** Produces the review digest (LLM in production). Optional. */
  summariseReviews?: SummariseReviews;
  /**
   * Sources we intended to fetch. If a name here is absent from `facts`, that
   * source failed and the row is degraded. Defaults to the sources present.
   */
  expectedSources?: PlaceSourceName[];
};

export type GradePriceBand = (facts: SourceFacts[]) => PriceBand | null;
export type SummariseReviews = (reviewTexts: string[]) => ReviewDigest | null;

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

  // ── review digest: injected summariser (LLM) over pooled review texts ───────
  const reviewTexts = facts.flatMap((f) => f.reviewTexts ?? []);
  let reviewDigest: ReviewDigest | null = null;
  if (opts.summariseReviews && reviewTexts.length > 0) {
    reviewDigest = opts.summariseReviews(reviewTexts);
    if (reviewDigest) {
      const src = facts.find((f) => (f.reviewTexts ?? []).length > 0)!;
      trace.review_digest = { source: src.source, at: src.fetchedAt };
    } else {
      degraded = true;
    }
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
