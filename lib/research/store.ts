/**
 * Layer 2 — persistence. Writes a fused `PlaceFacts` (lib/research/fuse-facts.ts)
 * into `place_facts`, and reads it back honouring the ttl so callers can avoid
 * hitting a source for a place whose facts are still fresh.
 *
 * Source-agnostic like the rest of layer 2: it stores provenance but never reads
 * a source format. Uses lib/db.ts as the owner role (see the RLS note in the
 * place_facts migration).
 */

import { query, queryOne } from '../db';
import type { PlaceFacts } from './place-facts';
import type { PriceBand, RatingBySource, ReviewDigest, SourceTrace } from './place-facts';
import type { WeeklyHours, ClosedDays } from './source-facts';

type PlaceFactsRow = {
  place_id: string;
  fetched_at: Date;
  ttl_until: Date;
  hours: WeeklyHours | null;
  closed_days: ClosedDays | null;
  price_band: PriceBand | null;
  rating: RatingBySource;
  review_digest: ReviewDigest | null;
  degraded: boolean;
  source_trace: SourceTrace;
};

function toPlaceFacts(r: PlaceFactsRow): PlaceFacts {
  return {
    placeId: r.place_id,
    fetchedAt: r.fetched_at.toISOString(),
    ttlUntil: r.ttl_until.toISOString(),
    hours: r.hours,
    closedDays: r.closed_days,
    priceBand: r.price_band,
    rating: r.rating ?? {},
    reviewDigest: r.review_digest,
    degraded: r.degraded,
    sourceTrace: r.source_trace ?? {},
  };
}

/**
 * Upsert one place's facts. Keyed on place_id (the PK): a re-research overwrites
 * the previous row rather than accumulating history — the research cache is a
 * cache, not a log. jsonb columns are passed as JS objects; `pg` serialises them.
 */
export async function savePlaceFacts(facts: PlaceFacts): Promise<void> {
  await query(
    `insert into place_facts
       (place_id, fetched_at, ttl_until, hours, closed_days, price_band,
        rating, review_digest, degraded, source_trace, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     on conflict (place_id) do update set
       fetched_at    = excluded.fetched_at,
       ttl_until     = excluded.ttl_until,
       hours         = excluded.hours,
       closed_days   = excluded.closed_days,
       price_band    = excluded.price_band,
       rating        = excluded.rating,
       review_digest = excluded.review_digest,
       degraded      = excluded.degraded,
       source_trace  = excluded.source_trace,
       updated_at    = now()`,
    [
      facts.placeId,
      facts.fetchedAt,
      facts.ttlUntil,
      facts.hours,
      facts.closedDays,
      facts.priceBand,
      facts.rating,
      facts.reviewDigest,
      facts.degraded,
      facts.sourceTrace,
    ],
  );
}

/**
 * Return a place's facts only if they are still fresh (ttl_until in the future).
 * A caller uses this to decide whether to re-run the sources: null means "stale
 * or absent — go fetch". A degraded row that is still fresh is returned as-is;
 * whether to retry a degraded row sooner is a policy for the caller, not here.
 */
export async function getFreshPlaceFacts(placeId: string): Promise<PlaceFacts | null> {
  const row = await queryOne<PlaceFactsRow>(
    `select place_id, fetched_at, ttl_until, hours, closed_days, price_band,
            rating, review_digest, degraded, source_trace
       from place_facts
      where place_id = $1 and ttl_until > now()`,
    [placeId],
  );
  return row ? toPlaceFacts(row) : null;
}
