/**
 * What a reel caption yields, and nothing more.
 *
 * Rung one of the extraction ladder (docs/gaja/reel-extraction-findings.md).
 * The finding this shape exists to serve: the places are in the CAPTION, not the
 * video. One real reel's caption carried ten venues with names, addresses, hours,
 * menus and handles, and nobody had to look at a frame.
 *
 * These are CANDIDATES, not places. Nothing here has been geocoded, deduped
 * against `places`, or checked against a place source — a `PlaceCandidate` is a
 * creator's claim, parsed. The fusion step in lib/research turns claims into
 * rows; this file must not grow fields that presume it already happened.
 */

/**
 * The five values `places.category` accepts, restated rather than imported.
 *
 * `PlaceCategory` in lib/api/types.ts is the canonical list and this must equal
 * it — lib/research/resolve-place.ts holds a compile-time assertion that they
 * agree, so a value added there and not here is a build error, not a runtime
 * surprise. The duplication is not laziness: scripts/test-ladder.mjs compiles
 * lib/extract/ alone with `--rootDir lib/extract`, and a single `import type`
 * reaching up to lib/api/ makes tsc refuse the whole directory (TS6059). The
 * extraction modules are testable without the rest of the app precisely because
 * they import nothing from it, and that is worth five repeated string literals.
 */
export type PlaceCandidateCategory = 'cafe' | 'restaurant' | 'exhibition' | 'shop' | 'activity';

export type PlaceCandidate = {
  /**
   * 1-based, read off the `N.` marker rather than the array index.
   *
   * The two differ the moment one entry fails to parse, and the ordinal is how a
   * result is matched back to the caption a human is reading. Keep the creator's
   * number even when the array is short.
   */
  ordinal: number;

  /** The 📍 venue name, in the creator's own script. Never romanised or translated. */
  name: string;

  /**
   * The romanised alias a creator parenthesises after the Korean name —
   * `우이그 (UIG)` yields name `우이그`, name_alt `UIG`.
   *
   * Kept separate rather than folded into `name` because it is the string that
   * matches a Google Places record, while `name` is the one that matches Naver
   * and Kakao. Collapsing them loses whichever source you were not looking at.
   */
  name_alt: string | null;

  /**
   * The venue's OWN @handle, stored without the leading `@`.
   *
   * Not the creator's. A naive regex over the whole caption returned eleven
   * handles for ten venues, because the self-promo tail carries the creator's —
   * see lib/extract/caption-grammar.ts for the rule that keeps them apart.
   */
  handle: string | null;

  /**
   * The unmarked line under the 📍 line: a full street address.
   *
   * 도로명 (`서울 용산구 후암로40길 3`) OR jibun (`서울 용산구 후암동 2-1`) — the same
   * venue appears both ways across reels, so BOTH must be accepted here and
   * downstream. This is the field that geocodes, which is why it, not the name,
   * decides `confidence`: an address makes a candidate resolvable without the
   * fuzzy cross-source name matching the design otherwise needs.
   */
  address: string | null;

  /**
   * The 🕰️ text, stored RAW and UNPARSED — `매일 11:00-22:30 금,토 11:00-23:00`.
   *
   * Deliberately not `WeeklyHours`. Caption hours are a creator's claim, not
   * ground truth; structuring them here would launder a claim into a fact and
   * put it a field access away from the `영업 종료` check. Parse at the point
   * something verifies them, against lib/research/source-facts.ts.
   */
  hours_raw: string | null;

  /** The 📓 text, stored raw. Nothing models prices today; captured so it is not lost. */
  menu_raw: string | null;

  /**
   * What kind of place this is — the one field here that is a JUDGEMENT rather
   * than a copy, and the only reason it is allowed to be one.
   *
   * `places.category` is NOT NULL with a CHECK, so a candidate cannot become a
   * row without an answer, and a caption never states one: it says 📍 and a
   * name, never "restaurant". The two ways out were to hardcode `'cafe'` for
   * every reel — writing a guess into a column that reads as a fact, the same
   * laundering `hours_raw` exists to avoid — or to ask the step that is already
   * reading the caption. This is that answer, and `category_confidence` is what
   * keeps it from becoming the first option with extra steps.
   *
   * NULL IS THE HONEST ANSWER and must stay available. A reel about a hotel, a
   * hiking trail or a festival is none of these five, and inventing one is worse
   * than leaving the candidate unresolved with its name and address intact in
   * `reels.extracted`.
   */
  category: PlaceCandidateCategory | null;

  /**
   * How sure the classification is. Null exactly when `category` is null.
   *
   * `'low'` is treated as no answer by lib/research/resolve-place.ts and sends
   * the whole reel to `needs_review` in lib/ingest/save-reel.ts. That is the
   * point of carrying a confidence at all: a category the extractor was not sure
   * of must cost a human glance, not a fact in a NOT NULL column.
   *
   * Deliberately separate from `CaptionExtraction.confidence`, which answers a
   * different question — "did we find the right NUMBER of venues" — and is
   * derived from the source text rather than asked of the model.
   */
  category_confidence: 'low' | 'medium' | 'high' | null;
};

export type CaptionExtraction = {
  places: PlaceCandidate[];

  /**
   * The caption's own lead-in — usually the same line as the reel's on-screen
   * text (`여름 날에 다녀오기 좋은 싱그러운 카페 10곳`). It tells you the reel is about
   * ten cafés and nothing about which ten, so it is a label for the set, never a
   * source of places.
   */
  title: string | null;

  /**
   * Derived, never asked of the model — see `deriveConfidence` in
   * lib/extract/caption-grammar.ts. A model that scores its own extraction
   * reports its own fluency; counting numbered blocks in the source text is an
   * independent check that can actually disagree with it.
   */
  confidence: 'low' | 'medium' | 'high';

  /** Which extractor produced this — a pinned model id, or `caption-grammar` for the model-free path. */
  model: string;

  /** Wall-clock milliseconds. Cost and latency of rung one are the case for keeping it rung one. */
  ms: number;
};
