import { query, tx } from '../db';
import type { CaptionExtraction } from '../extract/types';

/**
 * Everything the reel is known by before anything has been read out of it — the
 * DM's own four facts. `claimReel` takes exactly this and nothing more, which is
 * the point: the claim happens BEFORE the extraction ladder runs, so it cannot
 * depend on the ladder's output.
 */
export type ClaimReelInput = {
  userId: string;
  reelVideoId: string;
  sourceUrl: string | null;
  rawCaption: string | null;
};

export type ClaimReelResult = {
  reelId: string;
  /** True when this reel was already ours — a redelivery. Nothing was written. */
  alreadyExisted: boolean;
  /**
   * The row's status as it stands. `'pending'` on a fresh claim; on a
   * redelivery it is whatever the previous pass left behind, and the caller
   * needs it to tell two very different redeliveries apart.
   *
   * A reel that reached `'extracted'` or `'needs_review'` is done and a second
   * delivery is an ack. A reel still `'pending'`, or `'failed'`, is one whose
   * analysis did not survive — a model timeout, a killed process — and it has no
   * saved_places, because `finishReel` writes the status and the venues in one
   * transaction. Re-running the analysis over it is therefore safe and is the
   * only thing that ever un-sticks it.
   */
  status: 'pending' | 'extracted' | 'needs_review' | 'failed';
};

export type FinishReelInput = {
  /** From `claimReel`. */
  reelId: string;
  /** The same user the claim was made for; the venues are written under it. */
  userId: string;
  /** Null when extraction never produced a result — a crash, a timeout, a refusal. */
  extraction: CaptionExtraction | null;
  /** See `SaveReelInput.placeIds`. */
  placeIds?: ReadonlyMap<number, string>;
};

export type SaveReelInput = {
  userId: string;
  reelVideoId: string;
  sourceUrl: string | null;
  rawCaption: string | null;
  /** Null when extraction never produced a result — a crash, a timeout, a refusal. */
  extraction: CaptionExtraction | null;

  /**
   * `ordinal -> places.id`, for the candidates that resolved. Build it with
   * `placeIdsByOrdinal` (lib/research/resolve-place.ts).
   *
   * OPTIONAL, AND THE ABSENT CASE IS THE ORIGINAL BEHAVIOUR. Omit it — or leave
   * an ordinal out of it — and that row is written `place_id = null,
   * status = 'pending'` exactly as before. This is the whole seam: resolution
   * happens before the call, over the network, where a 401 or a wrong address
   * can fail without a transaction open. Nothing in here can be brought down by
   * a geocoder, because nothing in here talks to one. Losing a ten-venue reel
   * because one venue's address was mistyped would be a worse bug than the
   * unresolved row it replaced.
   */
  placeIds?: ReadonlyMap<number, string>;
};

export type SaveReelResult = {
  reelId: string;
  savedPlaceIds: string[];
  alreadyExisted: boolean;
};

type ReelStatus = 'extracted' | 'needs_review' | 'failed';

/**
 * `reels.status` is the extractor's state machine, not the venue's — the two
 * vocabularies are different on purpose (see 20260920000005).
 *
 * A low-confidence extraction goes to needs_review even when it found ten places,
 * because the model saying "I am not sure" is exactly the signal the review queue
 * exists to catch; shipping those ten straight to a user's saved list would spend
 * our credibility on the model's worst guesses.
 */
function reelStatus(extraction: CaptionExtraction | null): ReelStatus {
  if (!extraction) return 'failed';
  if (extraction.places.length === 0) return 'needs_review';
  if (extraction.confidence === 'low') return 'needs_review';
  // A venue the extractor could not classify, or classified with a shrug.
  //
  // `places.category` is NOT NULL with a CHECK, so one of these two things has
  // already happened by the time this runs: the candidate was written with the
  // reel-level fallback the caller stood behind, or it was not written at all
  // (`ResolveFailure: 'no-category'`, lib/research/resolve-place.ts). Either way
  // a person should look — the first case put a title's guess on a row, and the
  // second left a named venue with no place. This is the rule that makes asking
  // a model for a category safe rather than merely convenient: the answer it was
  // unsure about costs a review, never a fact.
  if (extraction.places.some((p) => !p.category || p.category_confidence === 'low')) {
    return 'needs_review';
  }
  return 'extracted';
}

/**
 * Persist one extracted reel and the venues it named, in a single call.
 *
 * `claimReel` then `finishReel`, run inside ONE transaction — the same two
 * statements the ingest pass makes separately, so there is one definition of
 * what a saved reel is and no second write path to drift. Use this when the
 * extraction is already in hand (scripts/ingest-inbox-once.ts,
 * scripts/verify-reel-ingest.ts); use the two stages when the analysis happens
 * between them and the `pending` row should be visible while it does.
 *
 * ONE TRANSACTION, because a listicle is not a set of independent rows. Half of a
 * ten-venue reel is worse than none of it: the user sees five places, believes
 * that is what they sent, and nothing in the schema records that five are
 * missing — `reels.status` would say 'extracted' over a truncated list.
 *
 * IDEMPOTENT, because the caller is a poller and a poller sees the same DM twice.
 * Meta redelivers a webhook that did not get a 200 fast enough, and a restart
 * re-reads an inbox page it already read. `unique (user_id, reel_video_id)` is
 * what makes the second delivery cheap rather than a 500 or a duplicate: the
 * insert takes the `do nothing` branch, no saved_places are written, and the
 * caller is told `alreadyExisted: true` so it can ack and move on.
 *
 * Resolving a `PlaceCandidate` to a row in `places` is NOT done here — it is done
 * BEFORE the call, by lib/research/resolve-place.ts, and arrives as `placeIds`.
 * Geocoding is a network round trip per venue and `tx()` holds one pooled client
 * for its whole duration (a pool of ONE per instance on Vercel — see lib/db.ts),
 * so doing it in here would hold a connection open across ten HTTPS calls.
 *
 * A row whose ordinal is not in `placeIds` is written `place_id = null,
 * status = 'pending'` — the state 20260918000001 defined for exactly this case
 * ("the row is created at ack time with status='pending', before extraction").
 * The candidate's name, address and hours live in `reels.extracted` either way,
 * findable from the row by `(reel_id, ordinal)`.
 */
export async function saveReel(input: SaveReelInput): Promise<SaveReelResult> {
  return tx(async (c) => {
    const reelId = await claimIn(c, input);
    if (!reelId) return readBack(c, input);
    const savedPlaceIds = await finishIn(c, reelId, input);
    return { reelId, savedPlaceIds, alreadyExisted: false };
  });
}

/**
 * Stage one: take the reel, before anything has been read out of it.
 *
 * Writes `status = 'pending'` and nothing else — the state 20260918000001
 * defined in so many words ("the row is created at ack time with
 * status='pending', before extraction") and which, until this existed, nothing
 * ever actually wrote. The ingest pass called `saveReel` at the END, after the
 * ladder and ten geocodes, so a reel was invisible for the ten-odd seconds it
 * took to analyse and then appeared finished. `pending` was a column default
 * with no writer.
 *
 * THAT WINDOW IS THE PRODUCT. app/(app)/home/ingest-status.tsx counts these rows
 * to say `릴스 1개 분석 중`, and it can only be honest if the row exists while the
 * work is actually happening. Claim first, analyse, then `finishReel`.
 *
 * Returns null when the reel is already ours — the `on conflict do nothing`
 * branch, which is what makes a redelivered DM cheap. See `saveReel`'s note.
 */
export async function claimReel(input: ClaimReelInput): Promise<ClaimReelResult> {
  return tx(async (c) => {
    const reelId = await claimIn(c, input);
    if (reelId) return { reelId, alreadyExisted: false, status: 'pending' };

    const existing = await c.query<{ id: string; status: ClaimReelResult['status'] }>(
      `select id, status from reels where user_id = $1 and reel_video_id = $2`,
      [input.userId, input.reelVideoId],
    );
    if (!existing.rows[0]) {
      throw new Error(
        `reels insert conflicted on (${input.userId}, ${input.reelVideoId}) but no row was found`,
      );
    }
    return { reelId: existing.rows[0].id, alreadyExisted: true, status: existing.rows[0].status };
  });
}

/**
 * Stage two: the extraction landed, so record it and write the venues.
 *
 * ONE TRANSACTION, for the reason `saveReel` gives at length: half a ten-venue
 * listicle is worse than none of it. The reel row is already committed by
 * `claimReel`, so what rolls back here is the status change and the venues
 * together — a failure leaves the reel exactly as the claim left it, `pending`
 * with no places, which is a state the caller can see and correct
 * (`markReelFailed`) rather than a half-written list it cannot.
 *
 * Call it exactly once per claim. A second call raises a unique violation on
 * `saved_places_reel_ordinal_idx` rather than duplicating the venues, which is
 * the right end for a bug of that shape.
 */
export async function finishReel(input: FinishReelInput): Promise<{ savedPlaceIds: string[] }> {
  return tx(async (c) => ({ savedPlaceIds: await finishIn(c, input.reelId, input) }));
}

/**
 * The reel was claimed and then could not be analysed.
 *
 * Without this a pass that dies between the two stages leaves a `pending` row
 * forever, and forever is exactly how long the home screen would go on saying
 * `분석 중`. Deliberately narrow: it moves the status and touches nothing else,
 * so a reel that failed keeps its caption and its source url for whoever comes
 * to look at why.
 */
export async function markReelFailed(reelId: string): Promise<void> {
  await query(`update reels set status = 'failed' where id = $1 and status = 'pending'`, [reelId]);
}

/** The insert, on a caller's client. Null means the reel was already ours. */
async function claimIn(c: import('pg').PoolClient, input: ClaimReelInput): Promise<string | null> {
  const inserted = await c.query<{ id: string }>(
    `insert into reels (user_id, reel_video_id, source_url, raw_caption, status)
          values ($1, $2, $3, $4, 'pending')
     on conflict (user_id, reel_video_id) do nothing
       returning id`,
    [input.userId, input.reelVideoId, input.sourceUrl, input.rawCaption],
  );
  return inserted.rows[0]?.id ?? null;
}

/** The extraction write plus the venues, on a caller's client. */
async function finishIn(
  c: import('pg').PoolClient,
  reelId: string,
  input: {
    userId: string;
    extraction: CaptionExtraction | null;
    placeIds?: ReadonlyMap<number, string>;
  },
): Promise<string[]> {
  const places = input.extraction?.places ?? [];

  // Scoped to the user as well as the id, because the venues below are written
  // under `input.userId` and a caller that paired a reelId with the wrong user
  // would otherwise file one person's places under another's. Narrowing the
  // UPDATE turns that from a silent mis-write into zero rows and the throw below.
  const updated = await c.query(
    `update reels set extracted = $3, status = $4 where id = $1 and user_id = $2`,
    [
      reelId,
      input.userId,
      // `pg` serialises a plain object into jsonb; null stays SQL NULL. Same
      // handling as lib/research/store.ts, which writes four jsonb columns.
      input.extraction,
      reelStatus(input.extraction),
    ],
  );
  if (updated.rowCount === 0) {
    throw new Error(`reel ${reelId} is not user ${input.userId}'s, or no longer exists`);
  }

  // One statement rather than a loop: N round trips inside a transaction hold a
  // pooled client open for N latencies, and a ten-venue listicle is the normal
  // case, not the extreme one.
  //
  // A duplicate ordinal inside one extraction violates
  // `saved_places_reel_ordinal_idx` and takes the whole transaction down. That is
  // deliberate — two venues claiming position 3 is an extractor bug, and writing
  // one of them while dropping the other is how it would stay invisible.
  //
  // The `dropped` CTE below exists for a DIFFERENT index, and dropping it would
  // reintroduce the bug this seam was built to avoid. `saved_places_no_duplicate_idx`
  // is unique on (user_id, place_id, coalesce(group_id, zero)) where the row is not
  // rejected and place_id is not null — so the moment a resolved place_id is
  // written, a venue the user ALREADY holds (saved by hand in March, shared in a
  // reel in April) raises a unique violation, and because this is one transaction
  // that violation takes all ten venues with it. Two entries in one reel resolving
  // to the same place — two branches within 50 m and similar names — do the same.
  // Both are handled by writing that row unresolved rather than by failing:
  // `place_id` null, status 'pending', ordinal intact, candidate still in
  // `reels.extracted`. The user already has the place; this reel does not get to
  // claim it twice, and it does not get to destroy the other nine either.
  //
  // Under READ COMMITTED the `exists` check can still be raced by a DIFFERENT reel
  // for the same user resolving the same venue concurrently. That loser rolls back
  // whole and the poller redelivers — which is the behaviour the idempotent insert
  // above is for, not a case worth a lock over.
  const rows = await c.query<{ id: string; ordinal: number }>(
    `with candidate as (
       select o, p, row_number() over (partition by p order by o) as nth
         from unnest($3::smallint[], $4::uuid[]) as u(o, p)
     ),
     dropped as (
       select c.o,
              case when c.nth > 1 then null
                   when exists (
                     select 1 from saved_places sp
                      where sp.user_id = $1 and sp.place_id = c.p
                        and sp.group_id is null and sp.status <> 'rejected'
                   ) then null
                   else c.p
              end as p
         from candidate c
     )
     insert into saved_places (user_id, reel_id, ordinal, place_id, status, confirmed)
          select $1, $2, d.o, d.p,
                 case when d.p is null then 'pending' else 'resolved' end, false
            from dropped d
       returning id, ordinal`,
    [
      input.userId,
      reelId,
      places.map((p) => p.ordinal),
      // Parallel arrays, so the null for an unresolved ordinal has to be
      // written out — `unnest` of two arrays of different lengths pads the
      // short one with nulls, which would silently mis-pair them.
      places.map((p) => input.placeIds?.get(p.ordinal) ?? null),
    ],
  );

  // RETURNING has no defined row order, so the caller's "first venue first"
  // comes from the ordinal, not from the order Postgres handed rows back.
  return sortByOrdinal(rows.rows);
}

/**
 * The second delivery of a reel we already hold.
 *
 * Reached only via `on conflict do nothing`, which under READ COMMITTED waits for
 * the conflicting transaction to commit before returning zero rows — so by the
 * time this select runs its own snapshot, the winner's row is visible. The throw
 * below is therefore unreachable in practice and stays anyway: the alternative to
 * failing here is returning a result object built around `undefined`, which would
 * surface three frames away as a reel id that does not exist.
 */
async function readBack(
  c: import('pg').PoolClient,
  input: SaveReelInput,
): Promise<SaveReelResult> {
  const existing = await c.query<{ id: string }>(
    `select id from reels where user_id = $1 and reel_video_id = $2`,
    [input.userId, input.reelVideoId],
  );
  if (!existing.rows[0]) {
    throw new Error(
      `reels insert conflicted on (${input.userId}, ${input.reelVideoId}) but no row was found`,
    );
  }

  const rows = await c.query<{ id: string; ordinal: number }>(
    `select id, ordinal from saved_places
      where reel_id = $1 and ordinal is not null`,
    [existing.rows[0].id],
  );

  // The first delivery's rows, not a fresh set. Re-running the extractor over the
  // same caption may name a different number of venues; the reel is already saved
  // and the user may have edited what came out of it, so a redelivery is an ack,
  // never a rewrite.
  return { reelId: existing.rows[0].id, savedPlaceIds: sortByOrdinal(rows.rows), alreadyExisted: true };
}

function sortByOrdinal(rows: { id: string; ordinal: number }[]): string[] {
  return [...rows].sort((a, b) => a.ordinal - b.ordinal).map((r) => r.id);
}
