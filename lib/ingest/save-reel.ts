import { tx } from '../db';
import type { CaptionExtraction } from '../extract/types';

export type SaveReelInput = {
  userId: string;
  reelVideoId: string;
  sourceUrl: string | null;
  rawCaption: string | null;
  /** Null when extraction never produced a result — a crash, a timeout, a refusal. */
  extraction: CaptionExtraction | null;
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
  return 'extracted';
}

/**
 * Persist one extracted reel and the venues it named.
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
 * What is NOT done here: resolving a `PlaceCandidate` to a row in `places`. A
 * candidate is a name and maybe an address scraped off a caption; turning that
 * into a canonical place means geocoding, the ~50m + fuzzy-name dedupe that
 * `POST /api/places` performs, and a decision about what to do when it matches
 * nothing. None of that exists for caption text yet, so every row written here
 * has `place_id` null and `status = 'pending'` — which is the state
 * 20260918000001 defined for exactly this case ("the row is created at ack time
 * with status='pending', before extraction"). The candidate's name, address and
 * hours live in `reels.extracted`, findable from the row by `(reel_id, ordinal)`.
 */
export async function saveReel(input: SaveReelInput): Promise<SaveReelResult> {
  const places = input.extraction?.places ?? [];

  return tx(async (c) => {
    const inserted = await c.query<{ id: string }>(
      `insert into reels (user_id, reel_video_id, source_url, raw_caption, extracted, status)
            values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, reel_video_id) do nothing
         returning id`,
      [
        input.userId,
        input.reelVideoId,
        input.sourceUrl,
        input.rawCaption,
        // `pg` serialises a plain object into jsonb; null stays SQL NULL. Same
        // handling as lib/research/store.ts, which writes four jsonb columns.
        input.extraction,
        reelStatus(input.extraction),
      ],
    );

    if (!inserted.rows[0]) return readBack(c, input);

    const reelId = inserted.rows[0].id;

    // One statement rather than a loop: N round trips inside a transaction hold a
    // pooled client open for N latencies, and a ten-venue listicle is the normal
    // case, not the extreme one.
    //
    // A duplicate ordinal inside one extraction violates
    // `saved_places_reel_ordinal_idx` and takes the whole transaction down. That is
    // deliberate — two venues claiming position 3 is an extractor bug, and writing
    // one of them while dropping the other is how it would stay invisible.
    const rows = await c.query<{ id: string; ordinal: number }>(
      `insert into saved_places (user_id, reel_id, ordinal, status, confirmed)
            select $1, $2, o, 'pending', false
              from unnest($3::smallint[]) as o
         returning id, ordinal`,
      [input.userId, reelId, places.map((p) => p.ordinal)],
    );

    return {
      reelId,
      // RETURNING has no defined row order, so the caller's "first venue first"
      // comes from the ordinal, not from the order Postgres handed rows back.
      savedPlaceIds: sortByOrdinal(rows.rows),
      alreadyExisted: false,
    };
  });
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
