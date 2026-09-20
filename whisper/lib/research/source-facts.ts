/**
 * The contract between the two layers of place research (design §4, §5.3).
 *
 *   Layer 1 — a `PlaceSource` adapter — is the ONLY code that knows a source
 *             (naver / kakao / google) exists. It scrapes AND parses the
 *             source-specific formats (e.g. Naver's `newBusinessHours`) into the
 *             source-neutral shape below. Anything it cannot parse is preserved
 *             verbatim in `raw` rather than dropped.
 *
 *   Layer 2 — fusion + grading + LLM digest + persistence — never sees a source
 *             format. It reads only `SourceFacts` and writes `place_facts`. It
 *             may branch on `source` for provenance (`source_trace`) but never to
 *             re-parse a source's data.
 *
 * `SourceFacts` is that boundary: layer 1's output and layer 2's input.
 *
 * Field names below were confirmed against a live m.place.naver.com response
 * (restaurant/cafe 21627288, 2026-09-20): visitorReviewsScore, newBusinessHours
 * .businessStatusDescription, VisitorReviewStatsAnalysisThemes (waitingtime),
 * menu price.displayText. Crowd fields (weeklyPopularity/today) exist in the
 * schema but were null for that venue — layer 2 must not assume they arrive.
 */

export type PlaceSourceName = 'naver' | 'kakao' | 'google';

/** A single weekday's hours, already parsed by layer 1 into a stable shape. */
export type DayHours = {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** "HH:MM" 24h, or null when the source only says "영업 중" without times. */
  open: string | null;
  close: string | null;
  /** Break windows, e.g. [{ start: "15:00", end: "17:00" }]. */
  breaks: { start: string; end: string }[];
  /** Last order "HH:MM" if the source states one. */
  lastOrder: string | null;
};

export type WeeklyHours = {
  days: DayHours[];
  /** Free-text the source showed but layer 1 could not structure, e.g. "명절 당일 휴무". */
  notes: string[];
};

export type ClosedDays = {
  /** ISO weekdays closed every week. */
  regular: number[];
  /** Irregular closures the source named, e.g. ["설날", "임시휴무 9/30"]. */
  irregular: string[];
};

/**
 * What one source asserts about one place. Every analytical field is optional:
 * a source that does not expose hours simply omits `hours`. `raw` always exists
 * so parse failures are recoverable downstream.
 */
export type SourceFacts = {
  source: PlaceSourceName;
  /** The source's own place id — becomes place_refs.source_id. */
  sourceId: string;
  /** When layer 1 fetched this. ISO 8601. */
  fetchedAt: string;

  // ── Confirmed fields (parsed by layer 1) ──────────────────────────────────
  hours?: WeeklyHours;
  closedDays?: ClosedDays;
  /** This source's own rating only. Layer 2 keeps sources separate — never averages. */
  rating?: number;

  // NOTE: review text deliberately does NOT live here. A bare `string[]` cannot
  // carry the url and postedAt that §4.3's evidence rule needs — a quote without
  // a followable receipt and a date is not evidence — and reviews are not a
  // `PlaceSource` concern at all: §7.1 marks Naver Blog ✓ under reviews/wait and
  // blank under identity, coords and hours. Review text arrives as `ReviewText`
  // from a `ReviewSource` (lib/research/review-source.ts), on its own schedule.

  /**
   * Anything the source returned that layer 1 chose not to (or could not) map to
   * a field above — kept verbatim so layer 2 can retry, hand to an LLM, or store
   * for the admin console. Keyed by the source's own field name.
   */
  raw: Record<string, string>;
};
