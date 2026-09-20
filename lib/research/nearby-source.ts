/**
 * The discovery half of place research: posts ABOUT AN AREA, not about a place.
 *
 * `ReviewSource` (./review-source.ts) answers "what did people say about THIS
 * venue?" and its implementations filter hard on the venue's name. This asks a
 * different question — "what venues does this neighbourhood's writing name?" —
 * and the two cannot share an interface without one of them lying about what its
 * `place` argument means. So this is a sibling, exactly as `ReviewSource` is a
 * sibling of `PlaceSource` and for the same reason.
 *
 * The seam the discovery spec §4 draws is unchanged: nothing above
 * `lib/research` knows Apify exists, and nothing above `sources/` knows whether
 * the post came from Naver or Instagram beyond the `source` tag it carries for
 * attribution. A caller sees `NearbyPost[]`.
 *
 * THE ONE FIELD THAT IS NOT OPTIONAL IS `url`.
 *
 * Every card this pipeline eventually renders carries a link back to the post it
 * was lifted from, and a post that cannot be linked to cannot become a card. That
 * is not a nicety: a scraped venue name with no receipt is an unattributable
 * claim, and the user's only way to check us is to read the thing we read. A
 * source that cannot produce a URL for a row drops the row.
 */

import type { PlaceCategory } from '../api/types';

/** Which scraper produced the row. Travels to the card as an attribution label. */
export type NearbySourceName = 'naver_blog' | 'instagram';

export type NearbyPost = {
  source: NearbySourceName;
  /** THE RECEIPT. Never null, never synthesised. See the header. */
  url: string;
  /** Post title, or the reel's first line. Empty string when the post had none. */
  title: string;
  /** What the extractor reads. A blog body or a reel caption. */
  body: string;
  /** Null when the source did not date the post; a post we cannot date is not aged out, it is dropped. */
  postedAt: Date | null;
  /**
   * A remote URL, never a stored image. Gaja does not copy third-party media —
   * see `app/(app)/saved-places/[saved_place_id]/nearby/nearby-screen.tsx` for
   * why these are rendered with a plain `<img>` rather than `next/image`.
   */
  thumbUrl: string | null;
  /** The author's handle, without the `@`. Null when the source does not name one. */
  authorHandle: string | null;
};

/**
 * What a source reports about its own run, so the screen can tell four different
 * silences apart (discovery spec §8's empty-result alarm, minus the history).
 *
 *   `ok`              — rows came back and at least one was parseable.
 *   `not-configured`  — no credential, so nothing was attempted and nothing was billed.
 *   `failed`          — the actor errored, timed out, or answered with a shape we cannot read.
 *   `no-rows`         — the actor succeeded and returned NOTHING. Suspicious, not quiet.
 *   `no-posts`        — rows came back and none survived parsing or the recency filter.
 *
 * `no-rows` and `no-posts` are deliberately not one state. §8: "A crawl that
 * returns zero reels for a 상권 that previously returned many is the signature of
 * actor rot, not of a quiet neighbourhood." Gaja stores no crawl history yet, so
 * "previously returned many" is unavailable — but the weaker distinction below is
 * available for free and carries most of the signal: an actor that returns an
 * empty dataset for a busy 동 is behaving differently from one that returns
 * twenty posts none of which name a venue.
 */
export type NearbySourceStatus = 'ok' | 'not-configured' | 'failed' | 'no-rows' | 'no-posts';

export type NearbySourceResult = {
  source: NearbySourceName;
  status: NearbySourceStatus;
  /** How many rows the actor returned, before parsing. 0 for `not-configured` and `failed`. */
  rows: number;
  posts: NearbyPost[];
};

export type NearbyQuery = {
  /** The anchor's 동 — `성수동`. The search is built around this word. */
  area: string;
  /** The anchor's category, used to pick the search word. Null is legal and falls back. */
  category: PlaceCategory | null;
  /** No post older than this is ever returned. Re-applied after mapping, never trusted to the transport. */
  since: Date;
};

export interface NearbySource {
  name: NearbySourceName;
  /** Runs the scraper. Throws only for a credential or transport failure; see `NearbySourceStatus`. */
  find(query: NearbyQuery): Promise<NearbyPost[]>;
}

/**
 * The search word, per category.
 *
 * Korean writing about neighbourhoods is indexed by these words and not by the
 * English enum — nobody blogs about a `cafe`, they blog about 성수동카페. The
 * fallback is `가볼만한곳` rather than the empty string, because an unqualified
 * area name returns property listings and apartment complexes.
 */
const SEARCH_WORD: Record<PlaceCategory, string> = {
  cafe: '카페',
  restaurant: '맛집',
  exhibition: '전시',
  shop: '소품샵',
  activity: '가볼만한곳',
};

export function searchWord(category: PlaceCategory | null): string {
  return category ? SEARCH_WORD[category] : '가볼만한곳';
}

/**
 * NFC so a decomposed Hangul jamo sequence compares equal to its composed form,
 * whitespace-stripped so `성수 커피` matches `성수커피`, case-folded for Latin
 * aliases. The same normalisation `sources/naver-blog.ts` uses, lifted here
 * because three files now need it and a second copy would eventually disagree.
 */
export function fold(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, '').toLowerCase();
}
