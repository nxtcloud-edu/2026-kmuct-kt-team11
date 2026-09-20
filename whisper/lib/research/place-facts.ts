/**
 * The shape layer 2 writes: one `place_facts` row (design §5.3, with
 * `review_digest` sharpened by the wait-digest spec §3.1).
 *
 * Mirrors supabase/migrations/20260920000007_place_facts.sql by hand — same
 * convention as lib/api/types.ts. Change both in one commit.
 */

import type { PlaceSourceName, WeeklyHours, ClosedDays } from './source-facts';
import type { ReviewText } from './review-source';

/**
 * Review sources are a different family from `PlaceSource` (wait-digest §2), so
 * `source_trace.review_digest` names one of these rather than a `PlaceSourceName`.
 * Derived from `ReviewText` so the two cannot drift apart.
 */
export type ReviewSourceName = ReviewText['source'];

export type PriceBand = '₩' | '₩₩' | '₩₩₩';

/** Rating kept per source, never averaged (§5.3). Key is the source name. */
export type RatingBySource = Partial<Record<PlaceSourceName, number>>;

/**
 * The slot a wait claim is qualified by — a CLOSED vocabulary:
 * {weekday,weekend} × {morning,lunch,afternoon,evening}, plus `open_run` (오픈런).
 *
 * §7.3 requires that an unqualified wait claim be discarded ("an unqualified wait
 * is not a wait"). A closed union makes that structural rather than a prompt
 * instruction: a claim the extractor cannot assign a slot to fails schema
 * validation and never reaches the database, however the prompt happens to be
 * worded that day.
 */
export type WaitSlot =
  | 'weekday_morning'
  | 'weekday_lunch'
  | 'weekday_afternoon'
  | 'weekday_evening'
  | 'weekend_morning'
  | 'weekend_lunch'
  | 'weekend_afternoon'
  | 'weekend_evening'
  | 'open_run';

/** How much corroboration a slot has. Computed from distinct backing posts, never asked of the model. */
export type WaitConfidence = 'low' | 'medium' | 'high';

/**
 * One verbatim receipt. §7.3 calls a dated quote a receipt; a receipt that
 * cannot be followed is not one, so the URL and the post date travel with the
 * quote rather than being flattened into a sentence.
 */
export type WaitEvidence = {
  /** Literal substring of the cited post's body — asserted in code, not trusted from the model. */
  quote: string;
  url: string;
  /** ISO date of the post the quote came from. */
  posted_at: string;
};

export type WaitEstimate = {
  min_minutes: number;
  max_minutes: number;
  confidence: WaitConfidence;
  evidence: WaitEvidence[];
};

/**
 * LLM-produced digest. Top-level keys stay `wait` / `vibe` / `warnings` (§5.3);
 * the inside of `wait` is the wait-digest spec §3.1 shape.
 *
 * WHY not §5.3's original `{ [bucket: string]: string }` with values like
 * "90–120min": §8.2 defines `WAIT_TOO_LONG { est, confidence }` as a typed
 * violation that is HARD when `confidence` is `high`. A planner cannot compare
 * the string "90–120min" against schedule slack — it has to parse prose written
 * by a model — and a free-text bucket key like "sat_afternoon" cannot be looked
 * up reliably from a candidate itinerary slot. Typed minutes make §7.2's
 * conservative comparison arithmetic, and the closed `WaitSlot` union makes
 * §7.3's discard-the-unqualified rule structural (see `WaitSlot`).
 */
export type ReviewDigest = {
  wait?: Partial<Record<WaitSlot, WaitEstimate>>;
  vibe?: string[];
  warnings?: string[];
};

/** Which `PlaceSource` asserted a field, and when. */
export type SourceTraceEntry = { source: PlaceSourceName; at: string };

/**
 * The digest's provenance. `posts` is the cost lever §3.1 describes: a refresh
 * that retrieves the same set of posts can skip the model call entirely.
 */
export type ReviewDigestTraceEntry = {
  source: ReviewSourceName;
  at: string;
  posts: string[];
};

/**
 * source_trace: which source asserted which field, and when. A product
 * requirement (§5.3), so it is typed rather than left as opaque jsonb.
 */
export type SourceTrace = {
  review_digest?: ReviewDigestTraceEntry;
  [field: string]: SourceTraceEntry | ReviewDigestTraceEntry | undefined;
};

export type PlaceFacts = {
  placeId: string;
  fetchedAt: string;
  ttlUntil: string;
  hours: WeeklyHours | null;
  closedDays: ClosedDays | null;
  priceBand: PriceBand | null;
  rating: RatingBySource;
  reviewDigest: ReviewDigest | null;
  degraded: boolean;
  sourceTrace: SourceTrace;
};
