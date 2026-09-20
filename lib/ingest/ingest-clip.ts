/**
 * STAGES 3–5 OF THE REEL PIPELINE: claim, analyse, finish, cover frame.
 *
 * This is the body that used to live inside `runIngestPass`'s per-clip loop, and
 * it moved here the moment a second caller appeared — `POST /api/reels`, which
 * saves a reel a person pasted the URL of. Everything in lib/ingest/run-pass.ts's
 * own header applies verbatim, because this is the same code: the order of the
 * stages IS the product, nothing in stage 4 runs inside a transaction, and the
 * claim happens before any analysis so app/(app)/home/ingest-status.tsx can say
 * `릴스 1개 분석 중` about work that is genuinely happening.
 *
 * WHAT STAYED BEHIND, and why the split is here rather than anywhere else. The
 * two callers differ in exactly one thing: how they learn whose reel this is.
 *
 *   the poller  a DM carries an `igsid`, which `resolveSenderToUser` turns into
 *               an account — or does not, in which case the reel is DROPPED.
 *   the paste   the person is holding a session cookie. There is nothing to
 *               resolve and nothing that can fail.
 *
 * So routing, the cursor, the circuit breaker and the pass summary stay in
 * run-pass.ts, and everything from "we have a user and a payload" onwards is
 * here. A reel saved by DM and the same reel saved by paste go through the same
 * claim, the same ladder, the same geocoder and the same transaction, and there
 * is no second definition of what a saved reel is for the two to drift apart on.
 *
 * IT THROWS, and the throw is load-bearing. An analysis that does not land moves
 * the row off `pending` (so the home screen stops saying 분석 중 about it) and
 * then rethrows, because the poller needs to stop advancing its cursor and the
 * route needs to answer 500 rather than 200. Swallowing it here would make both
 * callers report success over a reel with no places.
 */

import type { PlaceCategory } from '../api/types';
import { runLadder } from '../extract/ladder';
import { placeIdsByOrdinal, resolvePlaceCandidates } from '../research/resolve-place';
import type { InboxClip } from './inbox/index';
import { claimReel, finishReel, markReelFailed } from './save-reel';
import { captureReelThumbnail } from './thumbnail';

/**
 * A reel, as either source produces it: the five fields, minus who sent it and
 * when.
 *
 * `Omit` off `InboxClip` rather than a fresh declaration, so the per-field
 * documentation on that type — what a null caption costs, why the urls are
 * expected to die — is the documentation for this one too, and a field added
 * there cannot be silently missing here.
 *
 * `senderUsername` is omitted alongside `igsid` because it is the other half of
 * the same answer — WHO sent this — and a pasted link has no sender at all: the
 * person who pasted it is the signed-in user, already known, and is not
 * necessarily whoever shared the reel. Routing is the caller's job on both
 * paths; by the time a payload reaches this function it has already been
 * decided whose reel it is.
 */
export type ReelPayload = Omit<InboxClip, 'igsid' | 'senderUsername' | 'sharedAt'>;

export type IngestClipOutcome = {
  reelId: string;
  /**
   * True when this reel was already ours AND already analysed — a redelivered
   * DM, or a second paste of the same link. Nothing was re-run and nothing was
   * written; every count below is zero.
   *
   * A reel still `pending`, or one that ended `failed`, is NOT this: it has no
   * saved_places, because `finishReel` writes the status and the venues in one
   * transaction, so the analysis is re-run over it. That is the only thing that
   * recovers a pass killed halfway, and it is why pasting a link that failed
   * yesterday is a retry rather than a no-op.
   */
  alreadySaved: boolean;
  /** Venues the extractor named. Zero is ordinary — a vibe reel names none. */
  extracted: number;
  /** Of those, the ones that became a `places` row and so a resolved saved place. */
  resolved: number;
  /** True when the video rung decided, rather than the caption. */
  decidedByVideo: boolean;
  /** `'none'` when the payload offered no cover frame at all. */
  thumb: 'captured' | 'failed' | 'none';
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
 * Take one reel for one user, analyse it, and write what came out.
 *
 * `userId` is the caller's answer to "whose reel is this", already settled —
 * from `resolveSenderToUser` for the poller, from the session cookie for the
 * paste route. Nothing in here re-derives it and nothing in here may: a function
 * that could pick a different user than its caller intended is how one person's
 * places end up filed under another's.
 */
export async function ingestClip(
  userId: string,
  clip: ReelPayload,
): Promise<IngestClipOutcome> {
  // ── 3. CLAIM ──────────────────────────────────────────────────────────────
  // The row exists from here on, `status = 'pending'`, and the home screen can
  // see it. A reel with no caption still gets one: the caption is where the
  // places live, but the reel was genuinely sent, and dropping it would hide
  // that from the person who sent it.
  const claim = await claimReel({
    userId,
    reelVideoId: clip.reelVideoId,
    sourceUrl: clip.sourceUrl,
    rawCaption: clip.caption,
  });

  // A second arrival of a reel that was already ANALYSED is an ack and nothing
  // more. One still 'pending' or ended 'failed' has no venues, so the analysis
  // is re-run rather than left stuck forever.
  if (claim.alreadyExisted && claim.status !== 'pending' && claim.status !== 'failed') {
    return {
      reelId: claim.reelId,
      alreadySaved: true,
      extracted: 0,
      resolved: 0,
      decidedByVideo: false,
      thumb: 'none',
    };
  }

  let extracted = 0;
  let resolved = 0;
  let decidedByVideo = false;

  try {
    // ── 4. ANALYSE. No transaction is open across any of this. ──────────────
    //
    // The ladder, not a bare caption call: rung one is the caption and rung two
    // hands the reel's mp4 to Gemini for speech AND burned-in on-screen text in
    // one call. `clip.video` is a signed CDN link with an `oe=` expiry and is
    // spent HERE, while it is alive — it is never stored, and a design that
    // transcribed lazily would return 403 for anything saved last week. The
    // ladder never throws for a rung failure; a model timeout on rung one is
    // recorded in `rungs` and the climb continues.
    const extraction = await runLadder({ caption: clip.caption, video: clip.video });
    decidedByVideo = extraction.decided_by === 'video';
    extracted = extraction.places.length;

    // Geocode each candidate and find-or-create its `places` row. The category
    // comes from the candidate itself when the extractor was confident, and
    // falls back to the reel's title when it was not.
    const candidates =
      extraction.places.length > 0
        ? await resolvePlaceCandidates(extraction.places, {
            // The TITLE, or failing that the caption's first line — which is
            // what a title is. Never the whole caption: a 1,200-character
            // listicle that mentions 카페 once in a venue's description would
            // make every venue in it a café, and this is the value that ends up
            // in a NOT NULL column reading as a fact.
            category: categoryFromTitle(extraction.title ?? leadIn(clip.caption)),
          })
        : [];
    const placeIds = placeIdsByOrdinal(candidates);
    resolved = placeIds.size;

    // ── 5. FINISH. One transaction: the extraction and every venue. ─────────
    await finishReel({ reelId: claim.reelId, userId, extraction, placeIds });
  } catch (e) {
    // The reel is claimed and the analysis did not land. Move it off 'pending'
    // so the home screen stops saying `분석 중` about it, then rethrow — the
    // poller counts it and stops its cursor, the route answers 500. The row
    // stays, `failed`, with its caption, and a later delivery or a second paste
    // re-analyses it, because `failed` is explicitly not an ack above.
    //
    // Its own try, so that a database that is itself unreachable does not
    // replace the error that explains what actually broke. The original is the
    // one worth keeping; a row left on `pending` ages out of the home screen's
    // window on its own (lib/ingest/status.ts).
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
  // Same seam as `placeIds` — the networked, failable step happens outside, and
  // the write path stays un-killable by a remote host.
  let thumb: IngestClipOutcome['thumb'] = 'none';
  if (clip.thumb) {
    // Its own try, and a deliberately narrow one. A thumbnail failure must never
    // reach the caller's catch, because for the poller that catch stops the
    // cursor and re-reads this clip forever — an expired candidate URL would pin
    // the whole pipeline on one reel while the reel itself sat saved and
    // complete in the database.
    try {
      const shot = await captureReelThumbnail(claim.reelId, clip.thumb);
      thumb = shot.ok ? 'captured' : 'failed';
      // The reason is a short tag written by us, never a URL or a body.
      if (!shot.ok) console.warn(`[ingest] clip ${clip.reelVideoId} thumbnail skipped: ${shot.reason}`);
    } catch (e) {
      thumb = 'failed';
      console.warn(`[ingest] clip ${clip.reelVideoId} thumbnail threw:`, e);
    }
  }

  return { reelId: claim.reelId, alreadySaved: false, extracted, resolved, decidedByVideo, thumb };
}
