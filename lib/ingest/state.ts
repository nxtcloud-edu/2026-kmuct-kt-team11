/**
 * `ingest_state` — where a source left off, and whether it may run.
 *
 * See supabase/migrations/20260920000008_ingest_state.sql for why a cursor
 * exists at all when `reels` already has `unique (user_id, reel_video_id)`: the
 * index dedups writes, and a clip from an unrecognised sender is never written.
 *
 * Every function here upserts rather than requiring a seeded row. A source that
 * has to be registered before it can run is a source that silently does nothing
 * on a fresh database — including, specifically, the first production deploy.
 */

import { query, queryOne } from '../db';

/** The poller in lib/ingest/inbox/instagram-poll.ts. One name, used by both. */
export const INSTAGRAM_POLL_SOURCE = 'instagram-web-inbox-poll';

export type IngestState = {
  source: string;
  cursorAt: Date | null;
  /** Non-null means the breaker is tripped and the source must not run. */
  breakerTrippedAt: Date | null;
  breakerReason: string | null;
  lastOkAt: Date | null;
  lastError: string | null;
  lastAttemptAt: Date | null;
};

type Row = {
  source: string;
  cursor_at: Date | null;
  breaker_tripped_at: Date | null;
  breaker_reason: string | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_attempt_at: Date | null;
};

function toState(r: Row): IngestState {
  return {
    source: r.source,
    cursorAt: r.cursor_at,
    breakerTrippedAt: r.breaker_tripped_at,
    breakerReason: r.breaker_reason,
    lastOkAt: r.last_ok_at,
    lastError: r.last_error,
    lastAttemptAt: r.last_attempt_at,
  };
}

const COLUMNS = `source, cursor_at, breaker_tripped_at, breaker_reason,
                 last_ok_at, last_error, last_attempt_at`;

/**
 * The source's row, creating an empty one if this is its first run.
 *
 * `on conflict do nothing` then `returning` gives no row on the conflict path,
 * so the read is unconditional and separate. Two concurrent first runs both
 * insert, one loses harmlessly, and both read the same row.
 */
export async function getIngestState(source: string): Promise<IngestState> {
  await query(`insert into ingest_state (source) values ($1) on conflict (source) do nothing`, [
    source,
  ]);
  const row = await queryOne<Row>(`select ${COLUMNS} from ingest_state where source = $1`, [source]);
  // The insert above ran in the same call; a missing row here means the table is
  // gone or the source name changed underneath us, and neither is recoverable by
  // guessing at a default.
  if (!row) throw new Error(`ingest_state row for "${source}" vanished after upsert`);
  return toState(row);
}

/**
 * TRIPS THE BREAKER, PERMANENTLY, UNTIL A HUMAN CLEARS IT.
 *
 * There is no `untripBreaker` exported from this module, and that is the design.
 * Reset is `update ingest_state set breaker_tripped_at = null, breaker_reason =
 * null where source = '…'` run by a person who has first opened Instagram in a
 * browser, cleared whatever challenge is waiting, and captured a fresh
 * `IG_SESSION_ID`. A function that did that from code would be called from a
 * retry within a week.
 *
 * `coalesce` keeps the FIRST trip's timestamp and reason. The second failure is
 * a consequence of the first — a 429 that follows a checkpoint tells you nothing
 * — and the original reason is the one that says what a human has to go and fix.
 */
export async function tripBreaker(source: string, reason: string): Promise<void> {
  await query(
    `insert into ingest_state (source, breaker_tripped_at, breaker_reason, last_error, last_attempt_at)
     values ($1, now(), $2, $2, now())
     on conflict (source) do update set
       breaker_tripped_at = coalesce(ingest_state.breaker_tripped_at, now()),
       breaker_reason     = coalesce(ingest_state.breaker_reason, excluded.breaker_reason),
       last_error         = excluded.last_error,
       last_attempt_at    = now()`,
    [source, reason],
  );
}

/**
 * Asks for this pass's turn and, if it gets one, spends the budget in the same
 * statement. Returns true when the caller may poll, false when it is too soon.
 *
 * WRITTEN FIRST, NOT LAST, for the same reason `recordAttempt` in
 * app/api/auth/password/route.ts writes its row before verifying the password: a
 * floor enforced from a timestamp that is only written on the way out is not a
 * floor at all — a pass that hangs, crashes or is killed mid-flight leaves the
 * previous attempt's time in place, and the next invocation is free to poll
 * immediately. Marking the attempt as it starts means the budget is spent the
 * moment a request is admitted, whatever becomes of it.
 *
 * ONE STATEMENT, AND THAT IS THE SINGLE-FLIGHT. This used to be a read
 * (`getIngestState`), a comparison in TypeScript, and then a separate write. That
 * is read-then-write, and read-then-write is not a lock: N callers that read the
 * same stale `last_attempt_at` all pass the comparison and all poll. It went
 * unnoticed while the only callers were a daily cron and one local watcher. It
 * stopped being survivable the moment the ingest pass was hung off
 * /api/reels/status (lib/ingest/kick.ts), where the number of callers is the
 * number of people with the home screen open — a burst of simultaneous requests
 * to Instagram from one datacentre is the shape of traffic that gets an account
 * challenged.
 *
 * The conditional UPDATE closes it: the row is the lock, `where` is the test,
 * and the second caller's `where` no longer matches because the first already
 * moved the timestamp. Same mechanism, same column, no second mechanism — this
 * is `claimCategory` in lib/events/state.ts, applied to the poller.
 *
 * The insert is the first-run path only, and it is guarded by `where not exists`
 * rather than `on conflict do update` so that losing an insert race cannot also
 * hand out the turn.
 */
export async function claimAttempt(source: string, minIntervalMs: number): Promise<boolean> {
  // Seconds, because make_interval takes them. Sub-second floors round DOWN to
  // zero, which is the honest reading of "as fast as you can": the caller asked
  // for no floor and the clamp in InstagramPollSource is what stops it being one.
  const seconds = Math.floor(minIntervalMs / 1000);

  const claimed = await queryOne<{ source: string }>(
    `update ingest_state
        set last_attempt_at = now()
      where source = $1
        and (last_attempt_at is null
             or last_attempt_at < now() - make_interval(secs => $2::int))
      returning source`,
    [source, seconds],
  );
  if (claimed) return true;

  // No row updated means either "too soon" or "this source has never run". Only
  // the second is worth an insert, and `where not exists` makes the insert lose
  // silently when a concurrent caller got there first.
  const inserted = await queryOne<{ source: string }>(
    `insert into ingest_state (source, last_attempt_at)
     select $1, now()
      where not exists (select 1 from ingest_state where source = $1)
     returning source`,
    [source],
  );
  return inserted !== null;
}

/** A pass that completed with nothing failed. Clears the last error. */
export async function markOk(source: string, cursorAt: Date | null): Promise<void> {
  await query(
    `update ingest_state
        set last_ok_at = now(),
            last_error = null,
            -- Never moves backwards. A pass that read an empty inbox passes null
            -- and must not rewind the mark to the start of time.
            cursor_at  = greatest(cursor_at, $2::timestamptz)
      where source = $1`,
    [source, cursorAt],
  );
}

/**
 * A pass that failed without tripping the breaker — a caption model timing out,
 * a write that lost a race. Recorded, and deliberately NOT a breaker trip: these
 * are our bugs, not Instagram's verdict on the account, and locking the pipeline
 * out over one of them would need the same manual reset as a checkpoint.
 *
 * The cursor is untouched by the caller in this case, so the failed clips are
 * re-read next pass.
 */
export async function markError(source: string, error: string): Promise<void> {
  await query(
    `insert into ingest_state (source, last_error) values ($1, $2)
     on conflict (source) do update set last_error = excluded.last_error`,
    [source, error.slice(0, 2000)],
  );
}
