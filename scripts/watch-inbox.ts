/**
 * A local watcher that runs the reel ingest pass on a loop, so reels arrive by
 * themselves instead of by somebody typing a curl.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE YOU LEAVE IT RUNNING.
 *
 * THE DEFAULT INTERVAL IS FIVE SECONDS AND FIVE SECONDS IS AGGRESSIVE. The
 * thing being polled is `GET /api/v1/direct_v2/inbox/` — the endpoint
 * instagram.com's own web client calls, with a real person's session cookie,
 * from a server. Instagram does not document it, does not version it and owes us
 * nothing about it. A browser makes that request when a human opens their DMs.
 * This makes it 17,280 times a day. That is not a rate Instagram has any reason
 * to read as a person, and it WILL eventually trip rate limiting, a challenge or
 * a checkpoint on the account. The project's own poller defaults to FIFTEEN
 * MINUTES for exactly this reason (`DEFAULT_MIN_INTERVAL_MS`), and the comment
 * there says what is being optimised: not freshness, but the account's survival.
 *
 * Five seconds is here because it was asked for, and because a developer sitting
 * in front of the app watching a reel land wants it to land. Use it while you
 * are watching. Do not leave it running overnight. `--interval` exists so the
 * number is yours to choose, and the number that is safe to leave alone is
 * closer to the default than to this one.
 *
 * THE CIRCUIT BREAKER IS HONOURED AND THE WATCHER STOPS WHEN IT TRIPS. There is
 * no retry, no backoff and no `--force`. When Instagram says it has noticed, the
 * only correct response is to stop completely — a poller that answers a
 * challenge by waiting and trying again is still polling, and retrying into a
 * challenge is specifically how an account gets banned. See the long note on
 * `InstagramPollSource.request`. Clearing the breaker is a human opening
 * Instagram, clearing whatever is waiting, capturing a fresh `IG_SESSION_ID` and
 * running `update ingest_state set breaker_tripped_at = null` by hand.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS AND NOT A CRON. Vercel Cron's floor is one minute and this project's
 * plan allows one invocation a day, so a five-second pull is not something the
 * platform can be asked for. It is a long-running local process or it is nothing.
 * That also means this is a DEVELOPMENT TOOL: it runs on somebody's laptop,
 * against the local database, for as long as they are looking.
 *
 * IT RUNS THE SAME PASS THE ROUTE RUNS — `runIngestPass` from
 * lib/ingest/run-pass.ts, imported, not reimplemented. There is no second
 * ingestion path here and none may be added. If this file ever grows a stage the
 * route does not have, the two have drifted and this one has become the liar.
 *
 * Usage:  ./scripts/watch-inbox.sh [--interval=5s] [--once]
 *         npm run watch:inbox
 */

import {
  DEFAULT_MIN_INTERVAL_MS,
  HARD_MIN_INTERVAL_MS,
  InboxBreakerTrippedError,
  InboxNotConfiguredError,
} from '../lib/ingest/inbox/instagram-poll';
import { runIngestPass, type IngestPassSummary } from '../lib/ingest/run-pass';
import { pool } from '../lib/db';

/** What the user asked for, and what this file exists to warn about. */
const DEFAULT_INTERVAL_MS = 5_000;

/**
 * Consecutive failures before the watcher gives up.
 *
 * NOT a retry budget for Instagram — the breaker owns that, and it stops on the
 * first refusal, not the fifth. This covers the other kind of failure: Postgres
 * is down, `GEMINI_API_KEY` was revoked, a DNS outage. Looping on one of those
 * at five-second intervals is a wall of identical stack traces that buries the
 * one line saying what broke. Five is enough to ride out a blip and few enough
 * to notice.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `--interval=5s`, `--interval=90000`, `2m`. Also read from `WATCH_INTERVAL_MS`.
 *
 * Parsed rather than taken as raw milliseconds because `--interval=900000` is
 * unreadable and `--interval=15m` is not, and the number a person types here is
 * the number this whole file is about.
 */
function parseInterval(argv: readonly string[]): number {
  const arg = argv.find((a) => a.startsWith('--interval='))?.slice('--interval='.length);
  const raw = arg ?? process.env.WATCH_INTERVAL_MS ?? String(DEFAULT_INTERVAL_MS);

  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) {
    throw new Error(`--interval must be a number with an optional ms/s/m/h suffix; got "${raw}".`);
  }
  const ms = Number(match[1]) * (units[match[2] ?? 'ms'] ?? 1);

  // Clamped rather than refused, and clamped by the SOURCE's own floor rather
  // than by a number invented here — see `HARD_MIN_INTERVAL_MS`. A caller who
  // typed 0 meant "as fast as possible", and the honest answer to that is the
  // fastest this poller is willing to go.
  return Math.max(HARD_MIN_INTERVAL_MS, Math.round(ms));
}

function formatMs(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10}m` : `${Math.round(ms / 100) / 10}s`;
}

/**
 * One line per pass, and one line only.
 *
 * Counts, never content. The summary carries no caption, no sender handle and no
 * URL by construction (lib/ingest/run-pass.ts), and this must not start adding
 * any: a terminal scrollback is a log, and a caption is a third party's writing.
 */
function line(pass: number, summary: IngestPassSummary, ms: number): string {
  const at = new Date().toISOString().slice(11, 19);
  if (summary.skipped) return `${at}  #${pass}  skipped (${summary.skipped})  ${ms}ms`;

  const parts = [
    `fetched=${summary.fetched}`,
    `saved=${summary.saved}`,
    `existed=${summary.already_existed}`,
  ];
  if (summary.bound_by_handle) parts.push(`bound=${summary.bound_by_handle}`);
  if (summary.dropped_unknown_sender) parts.push(`unknown-sender=${summary.dropped_unknown_sender}`);

  // THE MESSAGE-REQUEST FOLDER, ON EVERY LINE WHERE IT IS NOT 'ok'. Every other
  // field above is printed only when it is non-zero, because a zero is ordinary.
  // This one is printed when it is BROKEN, because a folder that cannot be read
  // looks exactly like an empty one from `fetched=0` — which is the bug this
  // watcher would otherwise help hide. `requests?` is Instagram's own count of
  // what is waiting behind it.
  const pending = summary.pending_inbox;
  if (pending.read !== 'ok') {
    parts.push(`pending=${pending.read}${pending.reason ? `(${pending.reason})` : ''}`);
    if (pending.requests_total) parts.push(`requests-waiting=${pending.requests_total}`);
  } else if (pending.threads_approved || pending.threads_seen) {
    parts.push(`pending-approved=${pending.threads_approved}/${pending.threads_seen}`);
  }
  if (summary.places_resolved || summary.places_unresolved) {
    parts.push(`places=${summary.places_resolved}/${summary.places_resolved + summary.places_unresolved}`);
  }
  if (summary.decided_by_video) parts.push(`by-video=${summary.decided_by_video}`);
  if (summary.thumbs_captured) parts.push(`thumbs=${summary.thumbs_captured}`);
  if (summary.thumbs_failed) parts.push(`thumbs-failed=${summary.thumbs_failed}`);
  if (summary.failed) parts.push(`failed=${summary.failed}`);

  return `${at}  #${pass}  ${parts.join(' ')}  ${ms}ms`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const intervalMs = parseInterval(argv);

  console.log(
    `watching the Instagram DM inbox every ${formatMs(intervalMs)}` +
      (once ? ' (--once: one pass)' : '') +
      `. Ctrl-C to stop.`,
  );
  if (intervalMs < DEFAULT_MIN_INTERVAL_MS) {
    // Printed every run, not buried in a header nobody opens. The person who
    // pays for this is the owner of the Instagram account.
    console.log(
      `  note: ${formatMs(intervalMs)} is far below the poller's ${formatMs(DEFAULT_MIN_INTERVAL_MS)} default. ` +
        `This is an undocumented Instagram endpoint and this rate will eventually trip rate\n` +
        `        limiting or a challenge. The circuit breaker will stop the watcher when it does; ` +
        `do not leave this running unattended.`,
    );
  }

  let pass = 0;
  let consecutiveFailures = 0;

  // A flag rather than a `process.exit` in the handler: the loop is mid-pass
  // when Ctrl-C arrives, and killing it there can leave a reel claimed and
  // `pending` with nothing to move it off. Finishing the pass takes seconds.
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nstopping after this pass — Ctrl-C again to stop now.');
  });

  for (;;) {
    pass += 1;
    const startedAt = Date.now();

    try {
      // `minIntervalMs` passed EXPLICITLY, so the decision is legible here rather
      // than hidden in a constant that the cron would inherit too. The poller
      // enforces it against `ingest_state.last_attempt_at`, which survives a
      // restart of this process — the floor is not the loop's `sleep`.
      const summary = await runIngestPass({ minIntervalMs: intervalMs });
      consecutiveFailures = 0;
      console.log(line(pass, summary, Date.now() - startedAt));
    } catch (e) {
      // ── The two named stops. Neither loops. ───────────────────────────────
      if (e instanceof InboxNotConfiguredError) {
        // The expected outcome on a fresh clone: `sessionid` is httpOnly, so no
        // script can read it out of a browser and somebody has to paste it in.
        // One clear line naming the variable — never a stack trace, and never
        // the value, which is a bearer credential for the whole account.
        console.error(
          `\nstopped: ${e.variable} is not set, so the Instagram inbox cannot be read.\n` +
            `\n` +
            `  The poller needs three cookies from a logged-in instagram.com session:\n` +
            `    IG_SESSION_ID, IG_CSRF_TOKEN, IG_DS_USER_ID\n` +
            `\n` +
            `  ${e.variable} is the one that is missing. Put it in .env.local (server-side\n` +
            `  only — never NEXT_PUBLIC_) and run this again.\n` +
            `\n` +
            `  Note that \`sessionid\` is httpOnly: it cannot be read by JavaScript in the\n` +
            `  page and no script can capture it for you. It has to be copied out of the\n` +
            `  browser's own cookie inspector by hand.`,
        );
        return 1;
      }

      if (e instanceof InboxBreakerTrippedError) {
        console.error(
          `\nstopped: the circuit breaker is tripped (${e.reason}).\n` +
            `\n` +
            `  Instagram has refused or challenged this account's requests, and polling is\n` +
            `  now refused. This is not retried and there is no flag to override it —\n` +
            `  continuing to poll an account that has been challenged is how the account\n` +
            `  gets banned.\n` +
            `\n` +
            `  To resume: open Instagram, clear whatever is waiting, capture a fresh\n` +
            `  IG_SESSION_ID, then clear the breaker by hand:\n` +
            `\n` +
            `    update ingest_state set breaker_tripped_at = null, breaker_reason = null\n` +
            `     where source = 'instagram-web-inbox-poll';`,
        );
        return 1;
      }

      // ── Everything else: ours, probably, and bounded. ─────────────────────
      consecutiveFailures += 1;
      console.error(
        `${new Date().toISOString().slice(11, 19)}  #${pass}  pass failed ` +
          `(${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
        e instanceof Error ? e.message : e,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`\nstopped: ${MAX_CONSECUTIVE_FAILURES} passes failed in a row.`);
        return 1;
      }
    }

    if (once || stopping) return 0;

    // Measured from the START of the pass, so a pass that took four seconds is
    // followed by one second of waiting rather than five. A fixed sleep after a
    // variable pass turns the interval into "interval plus however long the
    // work took", which is how a five-second loop quietly becomes a twenty-
    // second one on the days it has something to do.
    await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
  }
}

main()
  .then(async (code) => {
    // The pool holds an open socket; without this the process hangs after the
    // last pass instead of exiting.
    await pool.end();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
