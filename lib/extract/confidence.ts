/**
 * Where the ladder stops climbing — as data, not as an `if` in the sequencer.
 *
 * Spec H4 (docs/superpowers/specs/2026-09-20-extraction-harness-design.md):
 * "Confidence boundaries live in a table, not in code … They are tuning data and
 * will change often; a code change per tuning round is friction that stops
 * tuning happening." The numbers below are the first guess, taken from one
 * measured reel. They are expected to move, and moving them must stay an edit to
 * this table — if a threshold ever appears inside lib/extract/ladder.ts, the
 * seam has failed.
 *
 * What is NOT here: how `confidence` is computed. That is `deriveConfidence` in
 * lib/extract/caption-grammar.ts and it is shared by every path, so a `'high'`
 * means the same thing whichever rung produced it. This file only says which
 * values are good enough to stop on.
 */

import type { CaptionExtraction } from './types';

export type Confidence = CaptionExtraction['confidence'];

/** Which rung produced a result. `'none'` is a real outcome: every rung ran and none cleared. */
export type Rung = 'caption' | 'video';

/**
 * An ordering, so a threshold can be a comparison rather than a switch. Exported
 * because the sequencer needs it to choose between two results that both cleared.
 */
export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export type RungBand = {
  rung: Rung;
  /** Fewer than this many candidates and the rung has not answered, whatever its confidence says. */
  minPlaces: number;
  /** The lowest `deriveConfidence` value this rung may stop on. */
  minConfidence: Confidence;
};

/**
 * The boundary table, in ladder order.
 *
 * `caption` at `medium` is the economic argument made numeric, and it is worth
 * spelling out what each band means in `deriveConfidence`'s terms:
 *
 *   high   — counts agree and EVERY entry has an address. Geocodable; done.
 *   medium — counts agree, every entry is named, at least one has no address.
 *            Still a named venue list; the missing addresses cost a fuzzy
 *            name match, not a video call.
 *   low    — the caption has no numbered entries at all, or the model's place
 *            count disagrees with the count of `N.` markers in the source text.
 *            That is either a prose caption or a model that invented or
 *            swallowed a venue, and it is exactly the reel the video rung
 *            exists for.
 *
 * So the line sits between `medium` and `low`. Set it to `low` instead and the
 * video rung never runs; set it to `high` and every listicle whose creator
 * omitted one address pays for a 4 MB download and a model call to be told what
 * the caption already said. On the one measured reel the caption answered ten
 * venues at ~0 cost, and that reel must never reach the video rung.
 *
 * `video` at `low` is not slack, it is arithmetic. A transcript has no `N.`
 * markers, so `countNumberedBlocks` over it returns 0 and `deriveConfidence`
 * returns `'low'` by its first rule — UNLESS the reel's own on-screen text is a
 * numbered list, which is precisely the listicle case where it deserves to
 * score higher. Raising this line would therefore switch the rung off for the
 * vibe reels it was built for. What it costs is that most video-decided reels
 * land in `needs_review` via `reelStatus` in lib/ingest/save-reel.ts, and that
 * is the right place for a venue nobody wrote down.
 */
export const RUNG_BANDS: readonly RungBand[] = [
  { rung: 'caption', minPlaces: 1, minConfidence: 'medium' },
  { rung: 'video', minPlaces: 1, minConfidence: 'low' },
];

const BY_RUNG: Readonly<Record<Rung, RungBand>> = Object.freeze(
  Object.fromEntries(RUNG_BANDS.map((b) => [b.rung, b])) as Record<Rung, RungBand>,
);

export function bandFor(rung: Rung): RungBand {
  return BY_RUNG[rung];
}

/**
 * Does this result clear its rung's band?
 *
 * Pure and total, so the sequencer's policy can be exercised across the whole
 * table with stub results and no model in sight (spec §9).
 */
export function clearsBand(result: CaptionExtraction, rung: Rung): boolean {
  const band = bandFor(rung);
  return (
    result.places.length >= band.minPlaces &&
    CONFIDENCE_RANK[result.confidence] >= CONFIDENCE_RANK[band.minConfidence]
  );
}
