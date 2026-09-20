/**
 * The shape layer 2 writes: one `place_facts` row (design §5.3).
 *
 * Mirrors supabase/migrations/20260920000003_place_facts.sql by hand — same
 * convention as lib/api/types.ts. Change both in one commit.
 */

import type { PlaceSourceName, WeeklyHours, ClosedDays } from './source-facts';

export type PriceBand = '₩' | '₩₩' | '₩₩₩';

/** Rating kept per source, never averaged (§5.3). Key is the source name. */
export type RatingBySource = Partial<Record<PlaceSourceName, number>>;

/** LLM-produced digest. Structure fixed by §5.3. */
export type ReviewDigest = {
  wait?: {
    /** e.g. { "sat_afternoon": "90–120min" } — keys are time buckets. */
    [bucket: string]: string;
  };
  vibe?: string[];
  warnings?: string[];
};

/**
 * source_trace: which source asserted which field, and when. A product
 * requirement (§5.3), so it is typed rather than left as opaque jsonb.
 */
export type SourceTrace = {
  [field: string]: { source: PlaceSourceName; at: string };
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
