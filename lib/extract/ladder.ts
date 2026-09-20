/**
 * The extraction ladder: which rung runs, in what order, and when to stop.
 *
 * This file owns SEQUENCING AND SHORT-CIRCUIT POLICY AND NOTHING ELSE. Spec H3
 * and §4 (docs/superpowers/specs/2026-09-20-extraction-harness-design.md):
 * "`ladder.ts` owns sequencing alone. Short-circuit policy lives here and
 * nowhere else, so changing the policy is a one-file change." The boundaries
 * themselves are data in lib/extract/confidence.ts — no threshold belongs in
 * here, and no parsing does either.
 *
 * THE ECONOMIC ARGUMENT, WHICH IS THE WHOLE DESIGN. Rung one is the caption, and
 * on the one reel measured end to end it answered TEN venues with names,
 * addresses, hours and menus for the price of a 1.2 KB text call
 * (docs/gaja/reel-extraction-findings.md). Rung two is a 4.35 MB video download
 * plus a ~966-prompt-token model call. A reel whose caption already names venues
 * must never pay for the second, which is why the caption result is tested
 * BEFORE the video is touched: the `{ url }` handed in is not fetched unless
 * `transcribeReel` is actually called, and it is not called when rung one
 * cleared. Reordering these two statements would silently multiply the cost of
 * every ordinary listicle.
 *
 * WHY THERE ARE TWO RUNGS AND NOT THREE. The spec's rung 2 (frames -> vision)
 * and rung 3 (audio -> ASR) are one call here. See the header of
 * lib/extract/asr.ts for the measurement that collapsed them — briefly: the same
 * Gemini call returns the burned-in on-screen text and the spoken audio, so
 * asking for them separately is two bills for one video.
 *
 * WHEN THIS RUNS: AT INGEST, NEVER LAZILY. The video URL carries an `oe=`
 * expiry, exactly like the thumbnail URLs, measured at roughly four and a half
 * days. Calling this when a user opens a saved place would work in development,
 * where every reel is hours old, and return `download-status-403` for anything
 * saved last week. See the note on `runLadder` for where the call belongs.
 */

import type { AsrResult, AsrVideo } from './asr';
import { transcribeReel } from './asr';
import { extractPlacesFromCaption } from './caption';
import { CONFIDENCE_RANK, clearsBand, type Confidence, type Rung } from './confidence';
import type { CaptionExtraction } from './types';

/** What the ASR rung cost and produced, kept beside the extraction it fed. */
export type AsrObservation = {
  model: string;
  ms: number;
  tokens?: number;
  transport: AsrResult['transport'];
  bytes: number;
  /**
   * Kept, not discarded. When a video-decided reel lands in `needs_review`, the
   * transcript is the only thing a reviewer has to check the candidate against —
   * throwing it away would make the queue unanswerable.
   */
  speech: string | null;
  onScreenText: string | null;
};

export type RungRecord =
  /** Not attempted. `skipped` says why, and "the rung below already answered" is the common reason. */
  | { ran: false; skipped: string }
  | {
      ran: true;
      ok: true;
      ms: number;
      /** The pinned id of whatever produced the candidates on this rung. */
      model: string;
      places: number;
      confidence: Confidence;
      /** Whether it cleared its band in lib/extract/confidence.ts. */
      cleared: boolean;
      /** Video rung only. */
      asr?: AsrObservation;
    }
  | { ran: true; ok: false; ms: number; error: string };

/**
 * The ladder's answer: a `CaptionExtraction`, plus the record of how it was
 * reached.
 *
 * Deliberately the SAME SHAPE rung one already returns, extended rather than
 * replaced. `saveReel` takes a `CaptionExtraction` and `reelStatus` reads
 * `confidence` off it; a second, video-shaped result type would have forced
 * every consumer to branch on which rung ran, which is exactly the knowledge
 * this file exists to keep in one place.
 */
export type LadderExtraction = CaptionExtraction & {
  /** Which rung produced the surviving candidates. `'none'` when nothing cleared. */
  decided_by: Rung | 'none';
  rungs: { caption: RungRecord; video: RungRecord };
};

export type LadderInput = {
  /** The reel's caption, verbatim and untruncated. Null is ordinary — some shares carry none. */
  caption: string | null;
  /**
   * The reel's video, or null when the payload carried none.
   *
   * A `{ url }` is NOT fetched unless the video rung actually runs. That is the
   * short circuit; see the note at the top of this file.
   */
  video?: AsrVideo | null;
};

/**
 * Injection points, present for tests and for spec H8 ("model vendors are
 * swappable").
 *
 * Both default to the real implementations, so production calls `runLadder(input)`
 * with one argument. What they buy is that the sequencing above can be exercised
 * across the whole boundary table with stubbed rung results and no model, no
 * network and no key (spec §9) — including the test that matters most, which
 * asserts the video rung is never touched when the caption cleared.
 */
export type LadderDeps = {
  extractCaption?: (caption: string) => Promise<CaptionExtraction>;
  transcribe?: (video: AsrVideo) => Promise<AsrResult>;
};

/**
 * Truncated, with any URL removed. An error message is the one string that
 * always gets logged, and the URLs in this pipeline are signed CDN links — a
 * `download-failed` line that quotes one has published a credential with a
 * four-day life. `AsrMediaError` already refuses to carry them; this is the
 * second fence, for the errors we did not write.
 */
function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 200);
}

/**
 * Turn a transcript back into something the caption extractor can read.
 *
 * ON-SCREEN TEXT FIRST, AND THE ORDER IS LOAD-BEARING. `deriveConfidence` scores
 * a result by comparing the model's place count against the number of `N.`
 * markers `countNumberedBlocks` finds in the SOURCE TEXT. A listicle reel burns
 * its numbering into the frames — "1. 우이그", "2. …" — so putting the on-screen
 * text at the top is the only arrangement in which a video-decided result can
 * score above `'low'`. Speech goes second because it is prose and contributes no
 * markers.
 *
 * Exported so the arrangement is testable without a model call.
 */
export function transcriptToText(asr: Pick<AsrResult, 'speech' | 'onScreenText'>): string | null {
  const parts = [asr.onScreenText, asr.speech].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** Higher confidence wins; ties go to the longer candidate list. Used only when BOTH rungs produced something. */
function better(a: CaptionExtraction, b: CaptionExtraction): CaptionExtraction {
  const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (byConfidence !== 0) return byConfidence > 0 ? a : b;
  return a.places.length >= b.places.length ? a : b;
}

const EMPTY: CaptionExtraction = { places: [], title: null, confidence: 'low', model: 'ladder', ms: 0 };

/**
 * Run the ladder over one reel.
 *
 * NEVER THROWS for a rung failure. A model timeout on rung one is not a reason
 * to lose the reel, and it is not a reason to skip rung two either — the record
 * says `{ ran: true, ok: false, error }` and the climb continues. The only thing
 * that can come out of here is a `LadderExtraction`, which is what lets the
 * ingest pass treat "we found nothing" and "we could not look" as the same kind
 * of row while still telling them apart in `rungs`. This mirrors spec §8: "a
 * failed rung is not a failed run."
 *
 * CALL THIS AT INGEST, INSIDE THE PASS, WHILE THE CDN LINK IS ALIVE — and
 * OUTSIDE `saveReel`'s transaction, for the same reason geocoding and thumbnail
 * capture are outside it: `tx()` holds one pooled client (a pool of ONE per
 * instance on Vercel, see lib/db.ts) and this is a download plus one or two
 * model round trips. Holding a Postgres connection across them would be a bug
 * whose symptom is connection exhaustion under load, not a slow reel.
 */
export async function runLadder(input: LadderInput, deps: LadderDeps = {}): Promise<LadderExtraction> {
  const extractCaption = deps.extractCaption ?? extractPlacesFromCaption;
  const transcribe = deps.transcribe ?? transcribeReel;

  // ── Rung 1: the caption. Always first, always cheap. ──────────────────────
  let captionResult: CaptionExtraction | null = null;
  let captionRung: RungRecord;

  const caption = input.caption?.trim();
  if (!caption) {
    captionRung = { ran: false, skipped: 'no-caption' };
  } else {
    const startedAt = Date.now();
    try {
      captionResult = await extractCaption(caption);
      captionRung = {
        ran: true,
        ok: true,
        ms: captionResult.ms,
        model: captionResult.model,
        places: captionResult.places.length,
        confidence: captionResult.confidence,
        cleared: clearsBand(captionResult, 'caption'),
      };
    } catch (e) {
      captionRung = { ran: true, ok: false, ms: Date.now() - startedAt, error: safeError(e) };
    }
  }

  // THE SHORT CIRCUIT. Everything below this line costs a video download and a
  // model call on ~4 MB of input; everything above it cost a text call on ~1 KB.
  if (captionResult && clearsBand(captionResult, 'caption')) {
    return {
      ...captionResult,
      decided_by: 'caption',
      rungs: { caption: captionRung, video: { ran: false, skipped: 'caption-sufficient' } },
    };
  }

  // ── Rung 2: the video. One Gemini call for both on-screen text and speech. ─
  let videoResult: CaptionExtraction | null = null;
  let videoRung: RungRecord;

  if (!input.video) {
    videoRung = { ran: false, skipped: 'no-video' };
  } else {
    const startedAt = Date.now();
    try {
      const asr = await transcribe(input.video);
      const observation: AsrObservation = {
        model: asr.model,
        ms: asr.ms,
        tokens: asr.tokens,
        transport: asr.transport,
        bytes: asr.bytes,
        speech: asr.speech,
        onScreenText: asr.onScreenText,
      };

      const text = transcriptToText(asr);
      // A reel that is silent AND carries no burned-in text is a real outcome,
      // not a failure: the ladder looked and there was nothing to read. Recording
      // it as `ok` with zero places is what keeps it out of the error count,
      // where it would look like a broken pipeline for years.
      videoResult = text
        ? // Rung 2's output goes back through rung 1's extractor ON PURPOSE. One
          // parser, one `deriveConfidence`, one output shape — a second extractor
          // tuned for transcripts would be a second place for the venue-vs-tail
          // bug to come back.
          await extractCaption(text)
        : { ...EMPTY, ms: 0 };

      videoRung = {
        ran: true,
        ok: true,
        ms: Date.now() - startedAt,
        model: videoResult.model,
        places: videoResult.places.length,
        confidence: videoResult.confidence,
        cleared: clearsBand(videoResult, 'video'),
        asr: observation,
      };
    } catch (e) {
      // Covers both `AsrMediaError` (the link expired, the bytes were an HTML
      // error page, the file was absurd) and a model failure. They are different
      // problems, and `error` carries which — `Reel video unusable: <reason>`
      // for the first, the model's own message for the second.
      videoRung = { ran: true, ok: false, ms: Date.now() - startedAt, error: safeError(e) };
    }
  }

  if (videoResult && clearsBand(videoResult, 'video')) {
    // Both rungs produced something and the caption's was merely below ITS OWN
    // band — which is a higher bar than the video's. Taking the video result
    // unconditionally here would throw away a three-venue low-confidence caption
    // for a one-venue low-confidence transcript.
    const winner = captionResult ? better(captionResult, videoResult) : videoResult;
    return {
      ...winner,
      decided_by: winner === videoResult ? 'video' : 'caption',
      rungs: { caption: captionRung, video: videoRung },
    };
  }

  // Nothing cleared. Return the best thing anyone found anyway — the candidates
  // are still worth writing, they are just not worth trusting, and `decided_by:
  // 'none'` plus a `'low'` confidence is what routes the reel to needs_review in
  // lib/ingest/save-reel.ts rather than to a user's saved list.
  const fallback = captionResult && videoResult ? better(captionResult, videoResult) : (captionResult ?? videoResult ?? EMPTY);

  return {
    ...fallback,
    decided_by: 'none',
    rungs: { caption: captionRung, video: videoRung },
  };
}
