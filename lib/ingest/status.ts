/**
 * "Is anything of mine being worked on right now?" — one row, for one user.
 *
 * This exists so the home screen can say `릴스 1개 분석 중` about work that is
 * genuinely in flight. `reels.status` is the extractor's own state machine
 * (20260920000005) and `pending` is written by `claimReel` before the extraction
 * ladder runs, so counting pending rows is counting real work rather than
 * guessing at it. Nothing here is derived from a timer or a client-side flag.
 *
 * DELIBERATELY AN AGGREGATE, NOT A LIST. The consumer is a status chip, not a
 * dashboard: it is polled every few seconds while the home tab is open, and the
 * cost of that has to stay one indexed scan over a handful of recent rows. If a
 * screen ever needs the reels themselves, it should ask for them separately
 * rather than widening this.
 *
 * NO CAPTION TEXT LEAVES HERE except the extraction's own `title` — the caption's
 * lead-in line, which is the one string written to be read as a label. The
 * caption body, the source URL and the sender are not in the shape and must not
 * be added: this is served to a browser, and a reel's caption is a third party's
 * writing.
 */

import { queryOne } from '../db';

/**
 * How long a `pending` reel is still believed to be in flight.
 *
 * THE WIDGET'S OFF SWITCH, and the reason it cannot become permanent furniture.
 * A pass killed between `claimReel` and `finishReel` leaves a row that nothing
 * will ever move — `markReelFailed` covers the ordinary failure, but not a
 * process that was `kill -9`'d — and without a ceiling here the home screen
 * would say `분석 중` about it until someone noticed, which is to say forever.
 * Ten minutes is far past any real pass: the measured cost is a ~4 MB download,
 * one model call and ~10 sequential geocodes, which is seconds.
 */
const ANALYSING_WINDOW_S = 10 * 60;

/**
 * How long a finished reel is still worth mentioning.
 *
 * Short on purpose. The card's job is to close the loop on something the user
 * just did — share a reel, open the app, see it land — and a result that is
 * still on screen ten minutes later has stopped being feedback and become a
 * notification nobody dismissed. After this the reel is simply in 저장한 곳,
 * which is where it belongs.
 */
const LANDED_WINDOW_S = 2 * 60;

export type IngestStatus = {
  /** Reels claimed and not yet finished — the honest count behind `분석 중`. */
  analysing: number;
  /** Reels that finished inside `LANDED_WINDOW_S`. */
  landed: number;
  /** Venues named across those finished reels. What was FOUND, not what geocoded. */
  places: number;
  /** Of the landed reels, how many need a human to look. */
  needs_review: number;
  /** Of the landed reels, how many could not be analysed at all. */
  failed: number;
  /** The most recent landed reel's own lead-in line, or null. */
  title: string | null;
};

const EMPTY: IngestStatus = {
  analysing: 0,
  landed: 0,
  places: 0,
  needs_review: 0,
  failed: 0,
  title: null,
};

type Row = {
  analysing: number;
  landed: number;
  places: number;
  needs_review: number;
  failed: number;
  title: string | null;
};

/**
 * Both windows in one round trip.
 *
 * `reels_user_idx` is `(user_id, shared_at desc, id desc)`, so the `recent` CTE
 * is a range scan over the newest few rows for one user and stops there. The
 * `limit 20` is a ceiling on a pathological case — a backfill dumping hundreds
 * of reels in one pass — and not an expected one; a status chip that said "20"
 * when the truth was 200 would be wrong in a direction nobody would notice, and
 * a status chip that scanned 200 rows every four seconds would be worse.
 *
 * `shared_at` is set by `claimReel`'s insert default, so it is the moment WE
 * took the reel, not the moment the DM was sent. That is the right clock for
 * both windows here — this measures our own work, not Instagram's.
 */
export async function readIngestStatus(userId: string): Promise<IngestStatus> {
  const row = await queryOne<Row>(
    `with recent as (
       select status, extracted, shared_at
         from reels
        where user_id = $1
          and shared_at > now() - make_interval(secs => $2::int)
        order by shared_at desc
        limit 20
     ),
     landed as (
       select * from recent
        where status <> 'pending'
          and shared_at > now() - make_interval(secs => $3::int)
     )
     select
       (select count(*) from recent where status = 'pending')::int            as analysing,
       (select count(*) from landed)::int                                     as landed,
       (select count(*) from landed where status = 'needs_review')::int       as needs_review,
       (select count(*) from landed where status = 'failed')::int             as failed,
       -- What the extraction NAMED. A venue whose address would not geocode is
       -- still a venue the reel gave us, and it is saved with place_id null —
       -- reporting only the resolved ones would tell the user we found fewer
       -- places than are about to appear in their list.
       (select coalesce(
                 sum(jsonb_array_length(coalesce(extracted -> 'places', '[]'::jsonb))), 0)
          from landed)::int                                                   as places,
       (select extracted ->> 'title' from landed order by shared_at desc limit 1) as title`,
    [userId, ANALYSING_WINDOW_S, LANDED_WINDOW_S],
  );

  // The query is all scalar subqueries over an aggregate-free select, so it
  // always returns exactly one row. The fallback is the shape of `queryOne`, not
  // a case that happens.
  return row ?? EMPTY;
}
