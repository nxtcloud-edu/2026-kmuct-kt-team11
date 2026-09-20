/**
 * Layer 2 — persistence. Writes a fused `PlaceFacts` (lib/research/fuse-facts.ts)
 * into `place_facts`, and reads it back with its freshness attached.
 *
 * This is the file the wait-digest spec §2 calls `facts.ts`. There is one store,
 * not two: same table, same job.
 *
 * **Reads never block** (§5.2). `getPlaceFacts` returns whatever row exists and
 * reports `stale`; it never refreshes inline and never calls out to a network.
 * §7.4's blocking 48-hour refresh is scoped to `hours` and `closed_days` and is
 * not implemented here — putting an Apify run plus a model call on a user's
 * request path is what §7.5 forbids, to sharpen a value §7.3 classifies as soft.
 * Refreshes happen on the cron (§5.3), which writes through `savePlaceFacts`.
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

export type CachedPlaceFacts = {
  facts: PlaceFacts;
  /** `ttl_until < now()`. Stale facts are still served — see §5.2. */
  stale: boolean;
};

/**
 * Return whatever row the place has, with its freshness reported rather than
 * enforced. `null` means no row at all — the place has never been researched,
 * which the UI renders as 웨이팅 정보 없음 and must handle regardless.
 *
 * This deliberately does NOT hide a stale row. A read that returned null for
 * anything past its ttl would leave a caller with two ways to say "nothing" and
 * no way to say "old but real", and the only honest thing to do with the second
 * on a request path is show it and say it is old. Deciding what to do about
 * `stale` — show it, badge it, queue a refresh for the cron — is the caller's
 * policy; so is whether a `degraded` row deserves an earlier retry. The one
 * thing this function will not do is refresh inline.
 *
 * `stale` is computed in SQL against `now()` so the boundary is the database's
 * clock, the same one `ttl_until` was written against.
 */
export async function getPlaceFacts(placeId: string): Promise<CachedPlaceFacts | null> {
  const row = await queryOne<PlaceFactsRow & { stale: boolean }>(
    `select place_id, fetched_at, ttl_until, hours, closed_days, price_band,
            rating, review_digest, degraded, source_trace,
            (ttl_until < now()) as stale
       from place_facts
      where place_id = $1`,
    [placeId],
  );
  return row ? { facts: toPlaceFacts(row), stale: row.stale } : null;
}
