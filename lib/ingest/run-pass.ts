/**
 * ONE PASS OF THE REEL INGEST PIPELINE — the whole of it, in one place.
 *
 * This used to be the body of app/api/internal/ingest/instagram/route.ts, and it
 * moved here the moment a second caller appeared (scripts/watch-inbox.ts). The
 * alternative was a watcher that reimplemented the pass, and the header of
 * scripts/ingest-inbox-once.ts already says what happens then: "it must never
 * grow logic the route does not also have — if it does, the two drift and this
 * one silently becomes the liar." A route that is nothing but authentication and
 * an error mapping cannot drift from the thing it calls.
 *
 * FIVE STAGES, and the ORDER OF THE FIRST TWO IS THE PRODUCT:
 *
 *   1. `fetchNewClips`      — the inbox, behind `InboxSource`.
 *   2. `resolveSenderToUser`— whose reel is this? An unknown sender is dropped.
 *   3. `claimReel`          — the row, `status = 'pending'`, BEFORE any analysis.
 *   4. `runLadder` + `resolvePlaceCandidates` — the expensive part. Network and
 *      models, deliberately with no transaction open.
 *   5. `finishReel`         — the extraction and the venues, in one transaction.
 *
 * STAGES 3 TO 5 ARE NO LONGER IN THIS FILE. They are `ingestClip` in
 * lib/ingest/ingest-clip.ts, and they moved there on the same rule that moved
 * this function out of a route handler: a second caller appeared. `POST
 * /api/reels` saves a reel a person pasted the link of, and it has to claim,
 * analyse and finish exactly as this does — so neither of them owns that code.
 * What is left here is the POLLER's own half: the breaker, the source, the
 * sender routing, the cursor and this summary. The notes below on stages 3–5
 * describe code that now lives next door; they are kept because they explain why
 * the pass is shaped the way it is, and the two files say the same thing.
 *
 * Stage 3 exists for the user, not for the database. The analysis costs a video
 * download, a model call and ~10 sequential geocodes, so a reel is in flight for
 * ten-odd seconds; claiming it first means app/(app)/home/ingest-status.tsx can
 * say `릴스 1개 분석 중` about work that is genuinely happening, instead of the
 * reel materialising finished with no sign it was ever received. Nothing else
 * would have made that honest — `reels.status = 'pending'` was a column default
 * that no code path ever wrote.
 *
 * NOTHING IN STAGE 4 RUNS INSIDE A TRANSACTION, and that is not a style
 * preference. `tx()` checks out a pooled client and holds it for the duration,
 * and lib/db.ts runs a pool of ONE per instance on Vercel — a video download
 * plus ten HTTPS round trips inside a transaction is one connection held for
 * several seconds while every other request on that instance waits behind it.
 *
 * THE CIRCUIT BREAKER IS HONOURED, NEVER BYPASSED. It is checked here before the
 * source is touched, and again inside the source itself, and neither check has
 * an override parameter. See lib/ingest/inbox/instagram-poll.ts for why a
 * tripped breaker is cleared by a human with a SQL statement and by nothing else.
 */

import { ingestClip } from './ingest-clip';
import type { InboxSource } from './inbox/index';
import {
  DEFAULT_MIN_INTERVAL_MS,
  InboxBreakerTrippedError,
  InboxPollTooSoonError,
  InstagramPollSource,
} from './inbox/instagram-poll';
import { resolveSenderToUser } from './route-sender';
import { INSTAGRAM_POLL_SOURCE, getIngestState, markError, markOk } from './state';

export type IngestPassSummary = {
  source: string;
  fetched: number;
  routed: number;
  dropped_unknown_sender: number;
  /** Reels claimed and analysed to completion this pass. */
  saved: number;
  already_existed: number;
  failed: number;
  /** Candidates that became a `places` row. */
  places_resolved: number;
  /** Candidates that did not — no address, no category, a geocode that found nothing. */
  places_unresolved: number;
  /** Reels the video rung of the ladder decided, rather than the caption. */
  decided_by_video: number;
  /** Cover frames copied into our own storage this pass. */
  thumbs_captured: number;
  /**
   * Clips that saved fine and whose cover did not. Counted, never fatal — see
   * lib/ingest/thumbnail.ts. A number that climbs while `saved` climbs with it
   * means the deck is falling back to stock images, not that ingest is broken.
   */
  thumbs_failed: number;
  cursor_at: string | null;
  /** Present only when the pass did not run. */
  skipped?: 'min-interval';
};

export type RunIngestPassOptions = {
  /**
   * The inbox to read. Defaults to `InstagramPollSource`.
   *
   * Injectable for the same reason `InboxSource` exists at all: when the Meta
   * Messaging API webhook lands it arrives as a second implementation and
   * nothing in this file changes. See lib/ingest/inbox/index.ts.
   */
  source?: InboxSource;

  /**
   * The poller's own floor between two attempts, in milliseconds.
   *
   * Ignored when `source` is supplied — it belongs to `InstagramPollSource`, not
   * to this function. Passed through rather than defaulted here so the decision
   * stays at the call site that made it: scripts/watch-inbox.ts passes five
   * seconds and says in its header what that costs.
   */
  minIntervalMs?: number;
};

/**
 * Run one pass. Throws `InboxBreakerTrippedError` when the breaker is up, so
 * every caller has to decide what to do about it rather than inheriting a
 * summary that quietly says zero.
 *
 * `InboxPollTooSoonError` is NOT thrown: being called inside the interval is
 * ordinary — it is what happens whenever the caller ticks faster than the
 * poller's floor — and it comes back as a summary with `skipped: 'min-interval'`
 * because nothing failed and nothing was attempted.
 */
export async function runIngestPass(
  options: RunIngestPassOptions = {},
): Promise<IngestPassSummary> {
  const state = await getIngestState(INSTAGRAM_POLL_SOURCE);

  // CIRCUIT BREAKER. Refused here as well as inside the source, so a tripped
  // breaker produces the same named error whoever called, and so the caller's
  // own logs say plainly why nothing is being ingested. Clearing it is a manual
  // `update ingest_state set breaker_tripped_at = null` performed AFTER a person
  // has cleared the challenge in the Instagram app and captured a fresh
  // IG_SESSION_ID. There is no endpoint for it and no option here, on purpose.
  if (state.breakerTrippedAt) {
    // The reason is ours, not Instagram's response — a short tag written by
    // detectBlock. No body, no headers, no cookie anywhere near it.
    throw new InboxBreakerTrippedError(
      `${state.breakerReason ?? 'unknown'} (halted at ${state.breakerTrippedAt.toISOString()})`,
    );
  }

  const summary: IngestPassSummary = {
    source: INSTAGRAM_POLL_SOURCE,
    fetched: 0,
    routed: 0,
    dropped_unknown_sender: 0,
    saved: 0,
    already_existed: 0,
    failed: 0,
    places_resolved: 0,
    places_unresolved: 0,
    decided_by_video: 0,
    thumbs_captured: 0,
    thumbs_failed: 0,
    cursor_at: state.cursorAt?.toISOString() ?? null,
  };

  const source =
    options.source ??
    new InstagramPollSource({ minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS });

  let clips;
  try {
    clips = await source.fetchNewClips(state.cursorAt);
  } catch (e) {
    // Called again inside the minimum interval — normal whenever the caller ticks
    // more often than the poller's own floor, and not an error.
    if (e instanceof InboxPollTooSoonError) return { ...summary, skipped: 'min-interval' };
    throw e;
  }

  summary.fetched = clips.length;

  // Oldest first, which parseInboxClips guarantees, so the cursor below is the
  // last clip actually processed rather than the newest one merely seen.
  let processedThrough: Date | null = null;

  for (const clip of clips) {
    try {
      const routed = await resolveSenderToUser(clip.igsid);

      // UNRECOGNISED SENDER: DROPPED, COUNTED, NEVER SAVED. This is a product
      // requirement, not a shortcut — lib/ingest/route-sender.ts explains why
      // the alternative (park the payload and hope) is a retention question
      // nobody has answered. Counting it is the only trace that remains, and it
      // is also the number to watch: a large and growing count here means
      // `users.igsid` is not being populated, not that nobody is sharing reels.
      if (!routed) {
        summary.dropped_unknown_sender++;
        processedThrough = clip.sharedAt;
        continue;
      }
      summary.routed++;

      // ── 3, 4 AND 5, IN lib/ingest/ingest-clip.ts ───────────────────────────
      //
      // Claim, ladder, geocode, finish, cover frame — shared verbatim with
      // `POST /api/reels`, which saves a reel a person pasted the link of. The
      // stages and the reasons they are in that order are documented there; this
      // loop keeps only what is the POLLER's own: routing, the cursor, and these
      // counters. Two callers, one definition of what a saved reel is.
      //
      // It throws when the analysis does not land, having already moved the row
      // off `pending` — the outer catch below counts it and stops the cursor.
      const outcome = await ingestClip(routed.userId, clip);

      if (outcome.alreadySaved) {
        summary.already_existed++;
        processedThrough = clip.sharedAt;
        continue;
      }

      summary.saved++;
      if (outcome.decidedByVideo) summary.decided_by_video++;
      summary.places_resolved += outcome.resolved;
      summary.places_unresolved += outcome.extracted - outcome.resolved;
      if (outcome.thumb === 'captured') summary.thumbs_captured++;
      else if (outcome.thumb === 'failed') summary.thumbs_failed++;

      processedThrough = clip.sharedAt;
    } catch (e) {
      // One clip's failure costs that clip and the cursor, not the other nine.
      // The reel id is safe to log — it is a public shortcode. The caption is
      // not: it is a third party's writing and may carry anything.
      summary.failed++;
      console.error(`[ingest] clip ${clip.reelVideoId} failed:`, e);
      // Stop advancing the mark at the first failure. Everything from here on is
      // re-read next pass, which is harmless because `reels` is unique on
      // (user_id, reel_video_id) and a claimed reel reports its own status.
      break;
    }
  }

  if (summary.failed === 0) {
    await markOk(INSTAGRAM_POLL_SOURCE, processedThrough);
    if (processedThrough) summary.cursor_at = processedThrough.toISOString();
  } else {
    // Deliberately NOT a breaker trip. A caption model timing out is our bug,
    // not Instagram's verdict on the account, and locking the pipeline behind a
    // manual reset over one would make every transient error an incident.
    await markError(INSTAGRAM_POLL_SOURCE, `${summary.failed} clip(s) failed in one pass`);
  }

  return summary;
}
