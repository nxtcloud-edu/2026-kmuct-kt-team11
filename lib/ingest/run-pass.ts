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

import type { PlaceCategory } from '../api/types';
import { runLadder } from '../extract/ladder';
import { placeIdsByOrdinal, resolvePlaceCandidates } from '../research/resolve-place';
import type { InboxSource } from './inbox/index';
import {
  DEFAULT_MIN_INTERVAL_MS,
  InboxBreakerTrippedError,
  InboxPollTooSoonError,
  InstagramPollSource,
} from './inbox/instagram-poll';
import { resolveSenderToUser } from './route-sender';
import { claimReel, finishReel, markReelFailed } from './save-reel';
import { INSTAGRAM_POLL_SOURCE, getIngestState, markError, markOk } from './state';
import { captureReelThumbnail } from './thumbnail';

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
 * The fallback category for a reel whose extractor could not classify a venue.
 *
 * A LAST RESORT, and a narrow one. `PlaceCandidate.category` is the real answer
 * — the extractor classifies each venue with its own confidence — and this only
 * covers the entries it returned nothing for. `places.category` is NOT NULL with
 * a CHECK, so the choice for those is between a title's evidence and no row at
 * all; `여름 날에 다녀오기 좋은 카페 10곳` does actually say cafe, and a reel titled
 * `서울에서 꼭 가봐야 할 10곳` says nothing and gets null.
 *
 * Deliberately conservative. Every pattern here is a word that names a KIND of
 * place, never a word that merely co-occurs with one: `아메리카노` in a caption
 * does not make a venue a café, it makes it a place that sells coffee, and a
 * bakery, a bookshop and a gallery all do. A wrong category is a fact in a column
 * that reads as true; a null one costs a review.
 */
const TITLE_CATEGORIES: ReadonlyArray<readonly [RegExp, PlaceCategory]> = [
  [/전시|갤러리|미술관|박물관|팝업\s*스토어|exhibition/i, 'exhibition'],
  [/소품샵|편집샵|서점|책방|문구점|shop/i, 'shop'],
  [/클래스|공방|원데이|체험|액티비티|activity/i, 'activity'],
  [/카페|커피|coffee|caf[eé]|베이커리|디저트|빵집/i, 'cafe'],
  [/맛집|식당|밥집|restaurant|한식|일식|중식|양식|이자카야|포차|술집/i, 'restaurant'],
];

export function categoryFromTitle(title: string | null): PlaceCategory | null {
  if (!title) return null;
  for (const [pattern, category] of TITLE_CATEGORIES) if (pattern.test(title)) return category;
  return null;
}

/**
 * A caption's lead-in: its first non-empty line, and only that.
 *
 * The same thing `captionTitle` in lib/extract/caption-grammar.ts reads, and it
 * is here for the case that one returns nothing — a caption with no numbered
 * entries has no title by that parser's rule, but it still has a first line, and
 * the first line is where a creator writes what the reel is about.
 */
function leadIn(caption: string | null): string | null {
  if (!caption) return null;
  for (const line of caption.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

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

      // ── 3. CLAIM ────────────────────────────────────────────────────────────
      // The row exists from here on, `status = 'pending'`, and the home screen
      // can see it. A reel shared without a caption still gets one: the caption
      // is where the places live, but the reel was genuinely shared, and dropping
      // it would hide that from the person who shared it.
      const claim = await claimReel({
        userId: routed.userId,
        reelVideoId: clip.reelVideoId,
        sourceUrl: clip.sourceUrl,
        rawCaption: clip.caption,
      });

      // A redelivery of a reel that was already ANALYSED is an ack and nothing
      // more. One that is still 'pending' or that ended 'failed' has no venues —
      // `finishReel` writes the status and the saved_places in one transaction —
      // so the analysis is re-run rather than left stuck forever. That is the
      // only thing that recovers a pass killed halfway.
      if (claim.alreadyExisted && claim.status !== 'pending' && claim.status !== 'failed') {
        summary.already_existed++;
        processedThrough = clip.sharedAt;
        continue;
      }

      try {
        // ── 4. ANALYSE. No transaction is open across any of this. ────────────
        //
        // The ladder, not a bare caption call: rung one is the caption and rung
        // two hands the reel's mp4 to Gemini for speech AND burned-in on-screen
        // text in one call. `clip.video` is a signed CDN link with an `oe=`
        // expiry and is spent HERE, while it is alive — it is never stored, and
        // a design that transcribed lazily would return 403 for anything shared
        // last week. The ladder never throws for a rung failure; a model timeout
        // on rung one is recorded in `rungs` and the climb continues.
        const extraction = await runLadder({ caption: clip.caption, video: clip.video });
        if (extraction.decided_by === 'video') summary.decided_by_video++;

        // Geocode each candidate and find-or-create its `places` row. The
        // category comes from the candidate itself when the extractor was
        // confident, and falls back to the reel's title when it was not — see
        // `categoryFromTitle` and lib/research/resolve-place.ts.
        const resolved =
          extraction.places.length > 0
            ? await resolvePlaceCandidates(extraction.places, {
                // The TITLE, or failing that the caption's first line — which is
                // what a title is. Never the whole caption: a 1,200-character
                // listicle that mentions 카페 once in a venue's description would
                // make every venue in it a café, and this is the value that ends
                // up in a NOT NULL column reading as a fact.
                category: categoryFromTitle(extraction.title ?? leadIn(clip.caption)),
              })
            : [];
        const placeIds = placeIdsByOrdinal(resolved);
        summary.places_resolved += placeIds.size;
        summary.places_unresolved += resolved.length - placeIds.size;

        // ── 5. FINISH. One transaction: the extraction and every venue. ───────
        await finishReel({
          reelId: claim.reelId,
          userId: routed.userId,
          extraction,
          placeIds,
        });
        summary.saved++;
      } catch (e) {
        // The reel is claimed and the analysis did not land. Move it off
        // 'pending' so the home screen stops saying `분석 중` about it, then
        // rethrow into the outer catch, which counts it and stops the cursor.
        // The row stays, `failed`, with its caption — a later pass re-reads the
        // clip and re-analyses it, because `claim.status === 'failed'` is
        // explicitly not an ack above.
        //
        // Its own try, so that a database that is itself unreachable does not
        // replace the error that explains what actually broke. The original is
        // the one worth keeping; a row left on `pending` ages out of the home
        // screen's window on its own (lib/ingest/status.ts).
        try {
          await markReelFailed(claim.reelId);
        } catch (marking) {
          console.error(`[ingest] clip ${clip.reelVideoId} could not be marked failed:`, marking);
        }
        throw e;
      }

      // THE COVER FRAME, AFTER THE COMMIT AND OUTSIDE THE TRY THAT MATTERS.
      //
      // `finishReel` does not take a thumbnail and must not: it holds one pooled
      // client for the whole transaction, and this is a download plus an upload.
      // Same seam as `placeIds` — the networked, failable step happens outside,
      // and the write path stays un-killable by a remote host.
      if (clip.thumb) {
        // Its own try, and a deliberately narrow one. A thumbnail failure must
        // never reach the outer catch, because the outer catch stops the cursor
        // and re-reads this clip forever — an expired candidate URL would pin
        // the whole pipeline on one reel while the reel itself sat saved and
        // complete in the database.
        try {
          const shot = await captureReelThumbnail(claim.reelId, clip.thumb);
          if (shot.ok) summary.thumbs_captured++;
          else {
            summary.thumbs_failed++;
            // The reason is a short tag written by us, never a URL or a body.
            console.warn(`[ingest] clip ${clip.reelVideoId} thumbnail skipped: ${shot.reason}`);
          }
        } catch (e) {
          summary.thumbs_failed++;
          console.warn(`[ingest] clip ${clip.reelVideoId} thumbnail threw:`, e);
        }
      }

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
