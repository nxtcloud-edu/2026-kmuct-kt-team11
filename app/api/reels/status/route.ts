import { after } from 'next/server';
import { withRoute, json } from '@/lib/route';
import { readIngestStatus } from '@/lib/ingest/status';
import { kickIngestPass } from '@/lib/ingest/kick';
import { requireUser } from '@/lib/session';

/**
 * What the signed-in user's reel ingestion is doing right now — and, after the
 * answer has been sent, the thing that makes the answer change.
 *
 * Its only consumer is the status card on the home screen
 * (app/(app)/home/ingest-status.tsx), which polls it every few seconds while the
 * tab is visible so a reel that lands while the user is looking appears without
 * a refresh. The read itself is one indexed aggregate over a handful of rows —
 * see lib/ingest/status.ts for why it is an aggregate and not a list.
 *
 * ─── IT IS NO LONGER READ ONLY, AND THAT WAS A DELIBERATE REVERSAL ──────────
 *
 * This file used to say: "Nothing here starts, retries or cancels a pass, and
 * nothing should: the ingest trigger lives behind CRON_SECRET and a user-session
 * endpoint that could kick the poller would be a way for any signed-in account
 * to spend the Instagram account's rate budget."
 *
 * The concern was right; the conclusion did not survive contact with the plan.
 * Vercel Cron here fires ONCE A DAY (vercel.ts — sub-daily schedules are a paid
 * feature), so the endpoint behind `CRON_SECRET` cannot deliver a reel while the
 * person who shared it is still holding their phone. This poll is the only
 * traffic that happens on the right timescale, so the pass is hung off it.
 *
 * WHAT ANSWERS THE OLD OBJECTION. A signed-in caller cannot spend the Instagram
 * account's budget, because the budget was never guarded by who was calling — it
 * is guarded by `ingest_state.last_attempt_at`, tested and moved in one
 * statement by `claimAttempt`. N users polling at once produce one pass and N-1
 * `skipped: 'min-interval'`. A caller hammering this endpoint gets the same
 * single pass and a lot of cheap aggregate reads. The floor is the rate limit;
 * the caller only decides how often it gets a chance to expire.
 *
 * `after()` is what keeps the promise this route still has to keep: the pass
 * starts once the response is on the wire, so the reader never waits for it. See
 * lib/ingest/kick.ts for the interval, the single-flight and the risk.
 *
 * Scoped to the caller by `requireUser()`, and there is no id parameter to
 * widen it with. A reel is one person's DM.
 */

// The status read is milliseconds. The PASS is not: one HTTP request to
// Instagram, then per clip a video download, a model call and ~10 geocodes — and
// `after()` runs inside this invocation, under this limit. Same 60s ceiling the
// cron route declares, for the same work.
export const maxDuration = 60;

// Counts rows on every call. Marked explicitly so it can never be mistaken for
// a prerenderable GET and served from a cache — a cached status is a card that
// says `분석 중` about a reel that finished four minutes ago, and a cached
// response would also mean the pass below never runs.
export const dynamic = 'force-dynamic';

export const GET = withRoute(async () => {
  const user = await requireUser();
  const status = await readIngestStatus(user.id);

  // AFTER THE RESPONSE, NOT BEFORE IT. Registered before the return only because
  // that is where the handler still has a request scope; the callback itself
  // runs once the response has been sent. It never throws — see kickIngestPass.
  after(kickIngestPass);

  return json(status);
});
