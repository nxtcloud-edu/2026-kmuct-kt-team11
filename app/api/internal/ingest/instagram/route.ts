import { timingSafeEqual } from 'node:crypto';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import {
  INSTAGRAM_POLL_SOURCE,
  getIngestState,
  markError,
  markOk,
} from '@/lib/ingest/state';
import {
  InboxBreakerTrippedError,
  InboxPollTooSoonError,
  InstagramPollSource,
} from '@/lib/ingest/inbox/instagram-poll';
import { resolveSenderToUser } from '@/lib/ingest/route-sender';
import { extractPlacesFromCaption } from '@/lib/extract/caption';
import { saveReel } from '@/lib/ingest/save-reel';
import { captureReelThumbnail } from '@/lib/ingest/thumbnail';

/**
 * One pass of the reel ingest pipeline.
 *
 * `fetchNewClips` → `resolveSenderToUser` → `extractPlacesFromCaption` →
 * `saveReel`. Every one of those four is behind an interface or a module
 * boundary, and this handler knows nothing about Instagram beyond the name of
 * the source it constructs — which is what lets the Meta Messaging API webhook
 * replace `InstagramPollSource` later without this file changing at all. See
 * lib/ingest/inbox/index.ts.
 *
 * GET, not POST, because Vercel Cron invokes the path with GET and a
 * `Authorization: Bearer $CRON_SECRET` header. A GET that mutates is not
 * something to be pleased about; it is the platform's contract and the secret is
 * what keeps it from being a drive-by. POST is exported alongside it so the
 * route can be driven by hand with the same header, which matters here because
 * this project has no Vercel deployment yet (see vercel.ts) and manual
 * invocation is the only way it runs today.
 */

// The whole pass — one HTTP request to Instagram plus a caption model call per
// clip — happens inside one invocation. 60s is the Hobby ceiling; a pass that
// needs longer than this is a pass that should be fetching fewer threads.
export const maxDuration = 60;

// Reads a header and writes to Postgres on every call. Marked explicitly so the
// route can never be mistaken for a prerenderable GET and served from a cache —
// a cached ingest pass would report a stale summary and quietly stop running.
export const dynamic = 'force-dynamic';

type Summary = {
  source: string;
  fetched: number;
  routed: number;
  dropped_unknown_sender: number;
  saved: number;
  already_existed: number;
  failed: number;
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

export const GET = withRoute(async (req: Request) => run(req));
export const POST = withRoute(async (req: Request) => run(req));

async function run(req: Request) {
  requireCronSecret(req);

  const state = await getIngestState(INSTAGRAM_POLL_SOURCE);

  // CIRCUIT BREAKER. Refused here as well as inside the source, so a tripped
  // breaker produces a documented problem response rather than an opaque 500 —
  // and so the cron's own logs say plainly why nothing is being ingested.
  // Clearing it is a manual `update ingest_state set breaker_tripped_at = null`
  // performed AFTER a person has cleared the challenge in the Instagram app and
  // captured a fresh IG_SESSION_ID. There is no endpoint for it on purpose.
  if (state.breakerTrippedAt) {
    throw new ProblemError('ingest-breaker-tripped', {
      // The reason is ours, not Instagram's response — a short tag written by
      // detectBlock. No body, no headers, no cookie anywhere near it.
      detail: `Halted at ${state.breakerTrippedAt.toISOString()}: ${state.breakerReason ?? 'unknown'}. Reset by hand once the account is clear.`,
    });
  }

  const summary: Summary = {
    source: INSTAGRAM_POLL_SOURCE,
    fetched: 0,
    routed: 0,
    dropped_unknown_sender: 0,
    saved: 0,
    already_existed: 0,
    failed: 0,
    thumbs_captured: 0,
    thumbs_failed: 0,
    cursor_at: state.cursorAt?.toISOString() ?? null,
  };

  let clips;
  try {
    clips = await new InstagramPollSource().fetchNewClips(state.cursorAt);
  } catch (e) {
    // Tripped during this call. The source has already written the reason down
    // and logged it; this turns it into the same documented response a caller
    // would get on the next attempt.
    if (e instanceof InboxBreakerTrippedError) {
      throw new ProblemError('ingest-breaker-tripped', {
        detail: `Halted: ${e.reason}. Reset by hand once the account is clear.`,
      });
    }
    // Called again inside the minimum interval — normal whenever the cron runs
    // more often than the poller's own floor, and not an error. 200 with a
    // `skipped`, because nothing failed and nothing was attempted.
    if (e instanceof InboxPollTooSoonError) return json({ ...summary, skipped: 'min-interval' });
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

      // A reel shared without a caption still gets a row. The caption is where
      // the places live, so no caption means no places — but the reel was
      // genuinely shared, and dropping it would hide that from the user who
      // shared it. `extraction: null` is the honest record of "we have this and
      // found nothing in it".
      const extraction = clip.caption ? await extractPlacesFromCaption(clip.caption) : null;

      // NO `placeIds` YET, so every row here is still born `place_id = null,
      // status = 'pending'`. The resolver exists and is proven
      // (lib/research/resolve-place.ts, ./scripts/verify-geocode.sh); what is
      // missing is an answer to the one thing it requires and a caption cannot
      // supply — `places.category` is NOT NULL with a CHECK, and a 📍 line says
      // a name and never "restaurant". Passing 'cafe' for every reel would write
      // a guess into a column that reads as a fact, which is a product decision
      // and not one to make silently here. Resolve that, then add:
      //
      //   placeIds: placeIdsByOrdinal(
      //     await resolvePlaceCandidates(extraction?.places ?? [], { category }),
      //   )
      //
      // Note the ordering: resolution is ~10 sequential HTTPS calls and must stay
      // outside saveReel's transaction, which is why it is a separate statement
      // and not a flag on the call below.
      const result = await saveReel({
        userId: routed.userId,
        reelVideoId: clip.reelVideoId,
        sourceUrl: clip.sourceUrl,
        rawCaption: clip.caption,
        extraction,
      });

      if (result.alreadyExisted) summary.already_existed++;
      else summary.saved++;

      // THE COVER FRAME, AFTER THE COMMIT AND OUTSIDE THE TRY THAT MATTERS.
      //
      // `saveReel` does not take a thumbnail and must not: it holds one pooled
      // client for the whole transaction (a pool of ONE per instance on Vercel),
      // and this is a download plus an upload. Same seam as `placeIds` — the
      // networked, failable step happens outside, and the write path stays
      // un-killable by a remote host.
      //
      // Skipped when the reel was already ours. That is the idempotency: a
      // redelivered DM re-downloads nothing, and `alreadyExisted` is the signal
      // that was already being returned for exactly this kind of decision.
      if (clip.thumb && !result.alreadyExisted) {
        // Its own try, and a deliberately narrow one. A thumbnail failure must
        // never reach the outer catch, because the outer catch stops the cursor
        // and re-reads this clip forever — an expired candidate URL would pin
        // the whole pipeline on one reel while the reel itself sat saved and
        // complete in the database.
        try {
          const shot = await captureReelThumbnail(result.reelId, clip.thumb);
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
      // (user_id, reel_video_id) and saveReel reports `alreadyExisted`.
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

  // Counts only. No cookie value, no caption text, no sender handle — this
  // response goes to whoever holds CRON_SECRET, and a summary that quoted a
  // caption would put a third party's writing behind a shared secret.
  return json(summary);
}

/**
 * The only thing standing between this endpoint and the open internet.
 *
 * Compared in constant time. A plain `===` on a secret short-circuits at the
 * first differing byte, and the difference between "wrong at byte 0" and "wrong
 * at byte 20" is measurable across enough requests — that is a byte-at-a-time
 * recovery of the secret, from outside, with no rate limit involved.
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
    // publishes the ingest trigger the moment someone forgets an env var.
    console.error('[ingest] CRON_SECRET is not set; refusing to run.');
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
