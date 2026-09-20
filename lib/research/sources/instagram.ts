/**
 * The only Instagram-aware file in discovery. SERVER ONLY.
 *
 * Implements `NearbySource` (../nearby-source.ts) over an Apify Instagram
 * hashtag actor, and is written to the shape `./naver-blog.ts` established:
 * pin the actor by full id with an env override, read every plausible output
 * key, map defensively, re-apply every filter the transport was asked for, and
 * shout when rows arrive but nothing parses. Read that file first; the comments
 * there argue most of this and are not repeated.
 *
 * `APIFY_TOKEN` is a real, billed secret — never `NEXT_PUBLIC_`, never logged,
 * never echoed into an error message. Same rule as ../geocode.ts and
 * ../../extract/caption.ts.
 *
 * ── WHY A HASHTAG SEARCH AND NOT A LOCATION SEARCH ─────────────────────────
 * Instagram's location pages are keyed by a numeric place id Gaja does not hold
 * and cannot derive from a 도로명 address; the actors that accept one want the
 * id, not a name, so a location search would need a whole second resolution step
 * whose failure mode is "silently searched the wrong 성수". A hashtag is what
 * Korean food and cafe creators actually tag — `#성수동카페` is a real, dense,
 * self-maintaining index of the neighbourhood — and it needs nothing but the 동
 * this app already stores on every place.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * It does not parse venues. A caption goes out of here verbatim in
 * `NearbyPost.body` and is read by `lib/extract/caption.ts`, which is the parser
 * that was built for exactly this text and measured against real reel captions.
 * A second caption parser living in a scraper adapter is how two answers to
 * "what venues did this creator name?" get into one codebase.
 */

import { runActor, ApifyError } from '../../ingest/apify';
import { searchWord, type NearbyPost, type NearbyQuery, type NearbySource } from '../nearby-source';

/**
 * Pinned by full id, overridable by env for the one reason ./naver-blog.ts gives:
 * an actor that is renamed, forked or retired is a deployment change, not a code
 * change. `apify/instagram-hashtag-scraper` is Apify's own first-party actor for
 * this, which matters more here than elsewhere — a community Instagram scraper is
 * the single most likely thing in this repo to rot without notice.
 */
const ACTOR = process.env.APIFY_INSTAGRAM_ACTOR ?? 'apify/instagram-hashtag-scraper';

/**
 * TWELVE POSTS. The cap is the cost control, and it is here rather than at the
 * call site so that no caller can raise it by accident.
 *
 * Twelve because a hashtag feed is ordered by Instagram's own ranking and the
 * tail is 협찬 and reposts, because a listicle caption routinely names ten venues
 * so twelve posts is already a hundred-odd candidates before dedupe, and because
 * every post costs a second time downstream — each caption is a Gemini call in
 * `lib/research/nearby.ts`. Doubling this doubles two bills, not one.
 */
const MAX_POSTS = 12;

/** Under the 300s function ceiling with room for the other source running beside it. */
const TIMEOUT_SECS = 90;

type RawPost = Record<string, unknown>;

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function pick(raw: RawPost, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(raw[k]);
    if (v) return v;
  }
  return null;
}

/**
 * An unparseable timestamp becomes null, never `now`. A post that claims no date
 * must not survive a recency filter it was never measured against — and on this
 * surface it is dropped outright rather than shown undated, because "is this
 * still open?" is most of what a nearby list is being asked.
 */
function parsePostedAt(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // Some actor versions emit a unix seconds integer (`taken_at`), others an ISO
  // string (`timestamp`). Both appear in the wild; neither is worth a probe.
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = str(v);
  if (!s) return null;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A shortcode into a canonical post URL, for the actor versions that return the
 * code but not the link. Built rather than dropped because a missing `url` is the
 * one thing that disqualifies a row entirely, and `instagram.com/p/<code>/` is a
 * stable, documented address — not a guess.
 */
function postUrl(raw: RawPost): string | null {
  const direct = pick(raw, ['url', 'postUrl', 'link']);
  if (direct) return direct;
  const code = pick(raw, ['shortCode', 'shortcode', 'code']);
  return code ? `https://www.instagram.com/p/${encodeURIComponent(code)}/` : null;
}

function mapPost(raw: RawPost): NearbyPost | null {
  const url = postUrl(raw);
  const body = pick(raw, ['caption', 'text', 'description', 'edge_media_to_caption']);
  const postedAt = parsePostedAt(raw.timestamp ?? raw.takenAt ?? raw.taken_at ?? raw.postedAt);

  // No link, no card (see ../nearby-source.ts). No caption, nothing to extract.
  // No date, nothing to age out against.
  if (!url || !body || !postedAt) return null;

  return {
    source: 'instagram',
    url,
    // A reel caption has no title. Its first line is the closest honest thing —
    // it is what the creator wrote as a lead-in — and it is trimmed here rather
    // than in the view so the view never has to decide what a title is.
    title: body.split('\n', 1)[0]?.trim().slice(0, 120) ?? '',
    body,
    postedAt,
    thumbUrl: pick(raw, ['displayUrl', 'thumbnailUrl', 'imageUrl', 'display_url']),
    authorHandle: pick(raw, ['ownerUsername', 'username', 'owner_username'])?.replace(/^@+/, '') ?? null,
  };
}

export class InstagramSource implements NearbySource {
  readonly name = 'instagram' as const;

  async find({ area, category, since }: NearbyQuery): Promise<NearbyPost[]> {
    // Hashtags carry no spaces, so the area and the search word are concatenated:
    // `성수동` + `카페`. That is the form creators actually type, which is the only
    // form that indexes anything.
    const hashtag = `${area}${searchWord(category)}`.replace(/[#\s]/g, '');

    const items = await runActor(
      ACTOR,
      {
        // Sent under several spellings for the reason ./naver-blog.ts gives: the
        // actor ignores keys it does not know, so a wrong guess degrades to
        // "unfiltered", never to "wrong results" — and that is cheaper than a
        // version probe.
        hashtags: [hashtag],
        search: hashtag,
        searchType: 'hashtag',
        resultsLimit: MAX_POSTS,
        resultsType: 'posts',
        maxItems: MAX_POSTS,
        // Comments and likers are a different bill for data no card shows.
        addParentData: false,
      },
      { timeoutSecs: TIMEOUT_SECS },
    );

    const mapped = items
      .map((i) => mapPost((i ?? {}) as RawPost))
      .filter((p): p is NearbyPost => p !== null);

    if (items.length > 0 && mapped.length === 0) {
      // A shape change, not an empty neighbourhood. The two have different fixes,
      // so they must not look the same in the logs (discovery spec §8).
      console.error(
        `[instagram] actor ${ACTOR} returned ${items.length} rows and 0 parseable posts for #${hashtag}. Output shape may have changed.`,
      );
    }

    // RECENCY, applied here because this actor has no date parameter to ask with.
    return mapped.filter((p) => p.postedAt !== null && p.postedAt >= since).slice(0, MAX_POSTS);
  }
}

export const instagram = new InstagramSource();
export { ApifyError };
