/**
 * `event_sources` — whether a category may be scraped, and what happened last time.
 *
 * The shape is lifted from lib/ingest/state.ts and the reasoning with it: state a
 * serverless worker has to remember lives in Postgres, because each invocation is
 * a fresh process and an in-process timer resets on every cold start. What is NOT
 * lifted is the cursor — a scrape re-reads the same top-five every week and has
 * no stream to be partway through. See the migration for the full argument.
 *
 * WHY THE COOLDOWN LIVES HERE AND NOT IN A CRON EXPRESSION. Vercel Cron floors at
 * one invocation and this project's plan allows DAILY at best (vercel.ts). "Every
 * seven days" is therefore not something the platform can express: it has to be a
 * daily cron that mostly does nothing, and "mostly does nothing" has to be decided
 * against a value that survives the invocation. That value is `last_attempt_at`.
 */

import { query, queryOne } from '../db';
import { EVENT_CATEGORIES, type EventCategory, type EventSourceName } from './types';

/** The product decision: a category is re-scraped at most this often. */
export const COOLDOWN_DAYS = 7;

/**
 * What a finished pass records. The three non-`ok` values are why this column
 * exists rather than a boolean — see the migration's block comment on
 * `empty_after_rows`, which is the §8 "succeeded, found nothing" alarm.
 */
export type ScrapeOutcome = 'ok' | 'empty' | 'empty_after_rows' | 'failed';

export type EventSourceState = {
  category: EventCategory;
  source: EventSourceName;
  lastAttemptAt: Date | null;
  lastOkAt: Date | null;
  lastOutcome: ScrapeOutcome | null;
  lastCount: number | null;
  lastError: string | null;
  /** Monotonic high-water mark. Non-zero means this category HAS produced rows. */
  peakCount: number;
  /** Non-null means this category refuses to run until a human clears it. */
  breakerTrippedAt: Date | null;
  breakerReason: string | null;
};

type Row = {
  category: string;
  source: string;
  last_attempt_at: Date | null;
  last_ok_at: Date | null;
  last_outcome: string | null;
  last_count: number | null;
  last_error: string | null;
  peak_count: number;
  breaker_tripped_at: Date | null;
  breaker_reason: string | null;
};

const COLUMNS = `category, source, last_attempt_at, last_ok_at, last_outcome,
                 last_count, last_error, peak_count, breaker_tripped_at, breaker_reason`;

function toState(r: Row): EventSourceState {
  return {
    category: r.category as EventCategory,
    source: r.source as EventSourceName,
    lastAttemptAt: r.last_attempt_at,
    lastOkAt: r.last_ok_at,
    lastOutcome: r.last_outcome as ScrapeOutcome | null,
    lastCount: r.last_count,
    lastError: r.last_error,
    peakCount: r.peak_count,
    breakerTrippedAt: r.breaker_tripped_at,
    breakerReason: r.breaker_reason,
  };
}

/**
 * Every category's state, in the migration's declared order.
 *
 * Unlike `ingest_state`, nothing here upserts a missing row. The key set is
 * fixed — six categories, seeded by the migration — so a missing row is a
 * database that has not been migrated, and inventing one at runtime would hide
 * that until the day somebody wonders why the feed is empty.
 */
export async function listEventSources(): Promise<EventSourceState[]> {
  const rows = await query<Row>(`select ${COLUMNS} from event_sources`);
  const byCategory = new Map(rows.map((r) => [r.category, toState(r)]));
  return EVENT_CATEGORIES.map((c) => byCategory.get(c)).filter(
    (s): s is EventSourceState => s !== undefined,
  );
}

export type ClaimResult =
  | { run: true; state: EventSourceState }
  | { run: false; reason: 'breaker' | 'cooldown'; state: EventSourceState };

/**
 * Decides whether this category runs now and, if it does, spends its budget.
 *
 * THE STAMP IS WRITTEN BEFORE THE REQUEST LEAVES, which is lib/ingest/state.ts's
 * `markAttempt` argument applied here: a cooldown enforced from a timestamp
 * written on the way OUT is not a cooldown at all. A pass that hangs, crashes or
 * is killed mid-flight would leave the previous attempt's time in place and the
 * next invocation would be free to go again immediately.
 *
 * `last_outcome` IS CLEARED BY THE SAME STATEMENT, and that pairing is the whole
 * subtlety of this function. The skip rule below reads `last_outcome = 'ok'`; if
 * an interrupted pass left the PREVIOUS run's `ok` sitting there next to a fresh
 * attempt stamp, the category would be suppressed for a full seven days on the
 * strength of a pass that never finished. Nulling it makes an interrupted pass
 * indistinguishable from a failed one — retried tomorrow, which is the right
 * answer for both.
 *
 * THE RULE: run unless the breaker is tripped, or the last attempt was inside
 * the cooldown AND that attempt succeeded.
 *
 * The second clause is why a failure does not cost a week. Seven days is the
 * budget for a HEALTHY category; a category that failed, came back empty, or was
 * interrupted is retried on the next daily cron. That is bounded at one attempt
 * a day by the platform, so it cannot become the tight retry loop the poller's
 * floor exists to prevent — the cron IS the floor here.
 *
 * One statement, so two cron invocations that overlap cannot both claim the same
 * category: the second's `where` no longer matches.
 */
export async function claimCategory(category: EventCategory): Promise<ClaimResult> {
  const before = await queryOne<Row>(`select ${COLUMNS} from event_sources where category = $1`, [
    category,
  ]);
  if (!before) {
    throw new Error(
      `event_sources has no row for "${category}"; run supabase/migrations/20260920000012_events.sql`,
    );
  }
  const state = toState(before);

  const claimed = await queryOne<{ category: string }>(
    `update event_sources
        set last_attempt_at = now(),
            last_outcome    = null
      where category = $1
        and breaker_tripped_at is null
        and (last_attempt_at is null
             or last_outcome is distinct from 'ok'
             or last_attempt_at < now() - make_interval(days => $2::int))
      returning category`,
    [category, COOLDOWN_DAYS],
  );

  if (claimed) return { run: true, state };
  return { run: false, reason: state.breakerTrippedAt ? 'breaker' : 'cooldown', state };
}

/**
 * A pass that finished. `peak_count` only ever goes up.
 *
 * `greatest` rather than an assignment: the high-water mark is the memory that
 * makes `empty_after_rows` decidable, and a pass that found fewer listings than
 * last time must not lower the bar. Letting it drift down would disarm the alarm
 * one mediocre pass at a time — five, then two, then zero, and by the time it is
 * zero the record says this category never returned much anyway.
 */
export async function recordOutcome(
  category: EventCategory,
  outcome: ScrapeOutcome,
  count: number,
  error: string | null,
): Promise<void> {
  await query(
    `update event_sources
        set last_outcome = $2,
            last_count   = $3,
            last_error   = $4,
            peak_count   = greatest(peak_count, $3),
            -- Only a pass that actually produced listings counts as ok. An
            -- empty pass is not a failure, but it is not a success either, and
            -- last_ok_at is the column a human reads to ask "when did this
            -- last work".
            last_ok_at   = case when $2 = 'ok' then now() else last_ok_at end
      where category = $1`,
    [category, outcome, count, error?.slice(0, 2000) ?? null],
  );
}

/**
 * TRIPS THE BREAKER, PERMANENTLY, UNTIL A HUMAN CLEARS IT.
 *
 * There is no `untripBreaker` in this module, on purpose and for the same reason
 * lib/ingest/state.ts gives: reset is
 *
 *   update event_sources set breaker_tripped_at = null, breaker_reason = null
 *    where category = '…';
 *
 * run by a person who has first checked that the source is serving us again. The
 * only states that get here are 401, 403 and 429 — a source declining on purpose
 * — and an automatic retry into a refusal is how a scraper earns an IP ban. A
 * tripped breaker is a page, not a backoff.
 *
 * `coalesce` keeps the FIRST trip's timestamp and reason: the second refusal is a
 * consequence of the first, and the original is the one that says what happened.
 */
export async function tripBreaker(category: EventCategory, reason: string): Promise<void> {
  await query(
    `update event_sources
        set breaker_tripped_at = coalesce(breaker_tripped_at, now()),
            breaker_reason     = coalesce(breaker_reason, $2),
            last_outcome       = 'failed',
            last_error         = $2
      where category = $1`,
    [category, reason.slice(0, 2000)],
  );
}
