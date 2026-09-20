import { timingSafeEqual } from 'node:crypto';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { runEventsPass } from '@/lib/events/run';
import { listEventSources } from '@/lib/events/state';

/**
 * The HTTP door onto one pass of the events scrape.
 *
 * THE PASS ITSELF IS NOT HERE. It is `runEventsPass` in lib/events/run.ts. What
 * is left in this file is authentication and the shape of the reply — the same
 * split app/api/internal/ingest/instagram/route.ts makes, and for the same
 * reason: a pass that lives in a route handler can only ever be run by an HTTP
 * request, and this one also has to be runnable by hand while the project has no
 * deployment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A DAILY CRON THAT USUALLY DOES NOTHING.
 *
 * The product cadence is EVERY SEVEN DAYS. Vercel Cron cannot express that:
 * it floors at one invocation and this project's plan allows DAILY at best (see
 * vercel.ts, which has the same constraint written out for the reel poller). A
 * weekly schedule is therefore not a schedule — it is a daily invocation plus a
 * cooldown that survives the invocation, because each call is a fresh process
 * and an in-memory timer would reset on every cold start.
 *
 * That cooldown is `event_sources.last_attempt_at` and the rule is in
 * lib/events/state.ts `claimCategory`. Six days out of seven this endpoint
 * answers 200 with every category `skipped: "cooldown"` and makes no outbound
 * request at all. That is the success case, not a no-op worth suppressing: the
 * reply still says when each category last ran and what it found, which is what
 * makes a cron log worth reading.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * GET, not POST, because Vercel Cron invokes the path with GET and an
 * `Authorization: Bearer $CRON_SECRET` header. A GET that mutates is not
 * something to be pleased about; it is the platform's contract, and the secret
 * is what keeps it from being a drive-by. POST is exported alongside it so the
 * route can be driven by hand with the same header.
 */

// Six categories: six HTTP requests, plus up to five geocodes for the popga half
// at a deliberate 120ms gap (lib/events/resolve.ts). Measured end to end at a few
// seconds; 60s is the Hobby ceiling and the margin is for a slow genre page.
export const maxDuration = 60;

// Reads a header and writes to Postgres on every call. Marked explicitly so the
// route can never be mistaken for a prerenderable GET and served from a cache — a
// cached pass would report a stale summary and quietly stop running.
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req: Request) => run(req));
export const POST = withRoute(async (req: Request) => run(req));

async function run(req: Request) {
  requireCronSecret(req);

  const summary = await runEventsPass();

  // The state of all six afterwards, not just what this pass touched. A cron log
  // line that says "everything was on cooldown" is not useful on its own; the
  // question a human actually has is "is anything stuck", and the answer is in
  // the breaker and the last outcome of the five categories that did not run.
  //
  // Nothing here quotes a response body, a URL with a credential in it, or a
  // listing's text beyond the title-free counts — this reply goes to whoever
  // holds CRON_SECRET.
  const sources = (await listEventSources()).map((s) => ({
    category: s.category,
    source: s.source,
    last_attempt_at: s.lastAttemptAt?.toISOString() ?? null,
    last_ok_at: s.lastOkAt?.toISOString() ?? null,
    last_outcome: s.lastOutcome,
    last_count: s.lastCount,
    peak_count: s.peakCount,
    // A tripped breaker is the one thing in this reply that needs a person. It
    // does not clear itself and it does not expire; see lib/events/state.ts.
    breaker_tripped_at: s.breakerTrippedAt?.toISOString() ?? null,
    breaker_reason: s.breakerReason,
    last_error: s.lastError,
  }));

  return json({ ...summary, sources });
}

/**
 * The only thing standing between this endpoint and the open internet.
 *
 * Constant-time, copied in substance from
 * app/api/internal/ingest/instagram/route.ts rather than imported, because that
 * file is another agent's and a shared helper across two internal routes is a
 * refactor, not a feature. The reasoning it states applies unchanged:
 *
 * A plain `===` on a secret short-circuits at the first differing byte, and the
 * difference between "wrong at byte 0" and "wrong at byte 20" is measurable
 * across enough requests — a byte-at-a-time recovery of the secret, from
 * outside, with no rate limit involved.
 *
 * The length guard is not paranoia about `timingSafeEqual`: it THROWS on unequal
 * lengths rather than returning false, so without it a caller could turn a probe
 * into a 500 and read the length off the status code. Length is still leaked by
 * the early return, and that is accepted — knowing a 64-character secret is 64
 * characters long buys an attacker nothing.
 */
function requireCronSecret(req: Request): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Unset means the door has no lock. Refusing is the only safe reading: the
    // alternative — treating "no secret configured" as "no secret required" —
    // publishes the trigger the moment someone forgets an env var.
    console.error('[events] CRON_SECRET is not set; refusing to run.');
    throw new ProblemError('internal-error');
  }

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ProblemError('unauthenticated');
  }
}
