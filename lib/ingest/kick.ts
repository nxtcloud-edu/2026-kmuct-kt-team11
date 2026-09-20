/**
 * Running the ingest pass off traffic that already exists.
 *
 * ─── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * A reel should land within seconds of being shared. Nothing else in this
 * project can deliver that:
 *
 *   - Vercel Cron on this plan fires ONCE A DAY (vercel.ts). Sub-daily schedules
 *     are a paid feature. A poller that runs at 03:00 is not a product.
 *   - scripts/watch-inbox.ts loops every few seconds and is a laptop. It is a
 *     development tool and it is not running in production.
 *   - The Meta Messaging API webhook — the real answer, no polling at all — does
 *     not exist yet.
 *
 * What DOES happen every few seconds in production is the home screen polling
 * `GET /api/reels/status` (app/(app)/home/ingest-status.tsx: 3s while something
 * is analysing, 8s while idle). So the pass is hung off that request. The person
 * who shared a reel and opened the app to watch for it is, by opening the app,
 * the thing that goes and fetches it.
 *
 * ─── THE THREE RULES THIS HAS TO OBEY ───────────────────────────────────────
 *
 * 1. IT MUST NOT DELAY THE RESPONSE. The reader is waiting on that request. The
 *    pass is therefore started from `after()` (next/server), which runs the
 *    callback once the response has been sent — not awaited in the handler, and
 *    not fired-and-forgotten either, which on a serverless platform means
 *    "killed the instant the response flushes".
 *
 * 2. SINGLE-FLIGHT, through the floor that already exists. `claimAttempt`
 *    (lib/ingest/state.ts) tests and moves `ingest_state.last_attempt_at` in ONE
 *    statement, so of N readers polling at once exactly one is admitted and the
 *    rest are told it is too soon. There is no second mechanism here — no lock
 *    table, no in-process flag, both of which would be per-instance and
 *    therefore not a lock at all on Vercel.
 *
 * 3. THE CIRCUIT BREAKER IS OBEYED, NOT WORKED AROUND. `runIngestPass` refuses
 *    to run at all while `breaker_tripped_at` is set and throws; this catches
 *    that and stops, exactly as the cron does. Nothing here clears a breaker,
 *    retries into one, or lowers a floor because a user is waiting.
 */

import { InboxBreakerTrippedError, InboxNotConfiguredError } from './inbox/instagram-poll';
import { runIngestPass } from './run-pass';

/**
 * How stale the inbox is allowed to get while somebody is watching the home
 * screen. Five seconds — the cadence asked for.
 *
 * ─── SAY THE RISK OUT LOUD ──────────────────────────────────────────────────
 *
 * THIS IS AGGRESSIVE AND IT IS A PRODUCT DECISION, NOT AN ENGINEERING ONE. The
 * poller's own default is FIFTEEN MINUTES (`DEFAULT_MIN_INTERVAL_MS`) and the
 * comment there explains why: every request to an undocumented endpoint is a
 * draw against a real person's real Instagram account, and the thing being
 * optimised is that account's survival, not freshness. Five seconds is 180x that
 * default. From a datacentre IP, on a session cookie, against an endpoint only a
 * browser calls, a five-second cadence is the traffic shape that gets an account
 * challenged — and a challenged account means `challenge_required`, a tripped
 * breaker, and NO ingestion at all until a human clears it in the Instagram app
 * and captures a fresh cookie by hand. The failure mode of being too fast is not
 * "slightly rate limited", it is "the feature is down and only a person can
 * restore it".
 *
 * It is implemented at five seconds anyway, because it was asked for explicitly
 * with that trade-off stated. What bounds the damage:
 *
 *   - it is a FLOOR between passes, not a schedule. No home screen open means no
 *     traffic at all, so a quiet night costs nothing;
 *   - it applies only to this opportunistic path. The cron still uses the
 *     15-minute default, so the backstop keeps polling slowly even if this
 *     is turned off;
 *   - the breaker still stops everything on the first sign that Instagram has
 *     noticed, and it stays stopped.
 *
 * TO BACK OFF, RAISE THIS NUMBER. 30_000 or 60_000 is still far fresher than a
 * daily cron and a fraction of the traffic. That is the first dial to reach for
 * if the account starts seeing challenges.
 */
export const OPPORTUNISTIC_MIN_INTERVAL_MS = 5_000;

/**
 * Logged once per instance rather than once per skipped pass.
 *
 * A missing `IG_SESSION_ID` is a deployment fact that does not change between
 * two requests four seconds apart, and this path runs on every home-screen poll
 * of every signed-in user. One line per cold start is a note; one line per poll
 * is a denial-of-service on the function logs.
 */
let warnedNotConfigured = false;
let warnedBreaker = false;

/**
 * Start one ingest pass if the floor allows it. Never throws, never returns
 * anything the caller could wait on being useful.
 *
 * MUST BE CALLED FROM `after()`, never awaited inside a handler. The signature
 * returns a promise only so the platform can keep the instance alive until the
 * pass finishes; the value is deliberately void.
 */
export async function kickIngestPass(): Promise<void> {
  // Cheap gate before the database. Without the session cookie the pass throws
  // `InboxNotConfiguredError` before it does anything else, and a round trip to
  // Postgres on every status poll to discover that is a waste. It also keeps a
  // fresh clone — no Instagram credentials at all — from lighting up its logs.
  if (!process.env.IG_SESSION_ID) {
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn(
        '[ingest] IG_SESSION_ID is not set; the home screen will not trigger ingest passes.',
      );
    }
    return;
  }

  try {
    const summary = await runIngestPass({ minIntervalMs: OPPORTUNISTIC_MIN_INTERVAL_MS });

    // Nothing is logged for the ordinary skip. It is the COMMON case by design —
    // every poll inside the floor returns it — and logging it would bury the
    // lines that matter under a steady drip of "did nothing".
    if (summary.skipped) return;

    // A pass that touched Instagram, summarised in one line. Counts only: no
    // caption, no cookie, no thread. The sender handle that could not be placed
    // is logged by `runIngestPass` itself, next to the drop it explains.
    if (summary.fetched > 0 || summary.pending_inbox.read === 'unreachable') {
      console.log(
        `[ingest] opportunistic pass: fetched=${summary.fetched} saved=${summary.saved} ` +
          `bound=${summary.bound_by_handle} unknown=${summary.dropped_unknown_sender} ` +
          `pending=${summary.pending_inbox.read}`,
      );
    }
  } catch (e) {
    // A TRIPPED BREAKER IS NOT AN INCIDENT HERE, it is the system working. It is
    // already logged loudly, once, at the moment it trips
    // (lib/ingest/inbox/instagram-poll.ts). Repeating it on every home-screen
    // poll afterwards would make the logs useless precisely when somebody is
    // reading them to find out what happened.
    if (e instanceof InboxBreakerTrippedError) {
      if (!warnedBreaker) {
        warnedBreaker = true;
        console.error(
          `[ingest] breaker is tripped (${e.reason}); the home screen will not trigger ` +
            `passes until ingest_state.breaker_tripped_at is cleared by hand.`,
        );
      }
      return;
    }
    if (e instanceof InboxNotConfiguredError) {
      if (!warnedNotConfigured) {
        warnedNotConfigured = true;
        console.warn(`[ingest] ${e.message}`);
      }
      return;
    }
    // Everything else: recorded and swallowed. This runs after a response that
    // has already been sent to a user who asked a different question; an
    // exception escaping here would be an unhandled rejection in the runtime,
    // not an error anybody sees.
    console.error('[ingest] opportunistic pass failed:', e);
  }
}
