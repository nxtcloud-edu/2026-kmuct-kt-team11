/**
 * The review half of place research (wait-digest spec §2).
 *
 * §4 of the 2026-09-18 design states the rule this must not break: "`PlaceSource`
 * is the only code that knows Naver exists. Everything above it sees
 * `VerifiedPlace`." Naver Blog is not a `PlaceSource`: §7.1's table marks it ✓
 * under `reviews` and `wait` and BLANK under identity, coords, hours, break and
 * price. Implementing `search()`/`facts()` as two throwing methods would push
 * that lie into every caller's types, so review sources get a narrower sibling
 * interface instead of being bent into `PlaceSource`.
 *
 * The caller owns `since` — the refresh job passes `now() - 6 months` per §7.3.
 * Each source translates it into whatever its transport wants (the Apify actor's
 * `dateFrom`, a query parameter, a post-filter). A source that cannot filter by
 * date server-side filters after, so the contract holds either way:
 * **no `ReviewText` older than `since` is ever returned.**
 *
 * Interface only. `sources/` does not exist yet; three implementations are
 * expected — Naver Blog now, Naver Place and Google reviews in slice 2 proper —
 * the same cardinality `PlaceSource` has. Nothing above `lib/research` knows
 * Apify exists, and nothing above `sources/naver-blog.ts` will know Naver does.
 */

import type { Place } from '../api/types';

export type ReviewText = {
  source: 'naver_blog' | 'naver_place' | 'google';
  /** The receipt the evidence links back to. */
  url: string;
  /** Full text; the substring check in §4.3 runs against this. */
  body: string;
  /** §7.3's recency filter and the evidence date. */
  postedAt: Date;
  title: string;
};

export interface ReviewSource {
  name: 'naver_blog' | 'naver_place' | 'google';
  reviews(place: Place, since: Date): Promise<ReviewText[]>;
}
