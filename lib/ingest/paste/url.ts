/**
 * Reading an Instagram link a person pasted — the pure half of the paste source.
 *
 * Kept apart from ./instagram-media.ts, which owns the network and the session
 * cookies, for the same reason lib/ingest/inbox/parse.ts is kept apart from the
 * poller: the part with the interesting bugs should be readable and testable
 * without a socket. Nothing here fetches, reads an environment variable, or
 * touches a clock.
 *
 * TWO JOBS, AND THE SECOND ONE IS A SECURITY BOUNDARY.
 *
 *   1. `parseReelUrl` — decide whether this string names an Instagram post at
 *      all, and if so pull out the shortcode. Liberal in what it accepts
 *      (Postel): four path shapes, an optional profile segment, any query
 *      string, `www`/`m`/no subdomain, a missing protocol, surrounding
 *      whitespace. Strict in what it emits: a shortcode drawn from one fixed
 *      alphabet and nothing else.
 *
 *   2. `shortcodeToMediaPk` — convert that shortcode to the media id the API
 *      path is built from. THE RESULT IS INTERPOLATED INTO A URL, so it is
 *      returned as a decimal string that the caller re-checks with a digits-only
 *      test before use. The alphabet check in step 1 already makes a non-numeric
 *      result impossible; the second check is there because "impossible" is what
 *      every path-traversal bug was before somebody widened a regex.
 *
 * The refusals are typed rather than boolean because the remedies differ. A
 * TikTok link and an Instagram profile link are both "not this", but the first
 * person needs to be told which app and the second needs to be told which
 * screen — and neither should cost a request to Instagram to find out.
 */

/** Why a string was refused. Each one earns its own sentence at the call site. */
export type ReelUrlRefusal =
  /** Not an instagram.com link — a TikTok share, a YouTube link, plain prose. */
  | 'not-instagram'
  /**
   * An instagram.com link that does not name a post: a profile, a story, an
   * explore page, the bare domain. The person is usually one screen away — the
   * post's own 링크 복사 — so the message says which link to take.
   */
  | 'not-a-post';

export type ReelUrlResult =
  | { ok: true; shortcode: string; canonicalUrl: string }
  | { ok: false; reason: ReelUrlRefusal };

/**
 * The four path segments that precede a media shortcode.
 *
 * `reel` and `reels` are both live — Instagram's own share sheet emits the
 * first and its web app links the second. `p` is the generic post path and is
 * accepted deliberately: a reel opened from a profile grid copies as `/p/`, so
 * refusing it would reject the reel the user is actually looking at. Whether the
 * media behind a `/p/` link IS a reel is not a question a URL can answer — it is
 * settled by the payload, in ./instagram-media.ts. `tv` is the retired IGTV path
 * and still resolves.
 */
const MEDIA_SEGMENTS = new Set(['reel', 'reels', 'p', 'tv']);

/**
 * Instagram's shortcode alphabet — URL-safe base64, in the order the id encoding
 * uses. This is the ONLY set of characters that may reach `shortcodeToMediaPk`,
 * and by extension the only thing that can end up in the request path.
 */
const SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Lower and upper bounds on a shortcode's length.
 *
 * Eleven is what Instagram mints today and has for years; the range is wider
 * than that because the length is theirs to change and a hard 11 would start
 * refusing valid links on the day they do. The upper bound is not cosmetic —
 * `shortcodeToMediaPk` multiplies by 64 per character, so an unbounded input is
 * an unbounded BigInt and a way to spend CPU from outside.
 */
const SHORTCODE_MIN = 5;
const SHORTCODE_MAX = 24;

/** Hosts that are Instagram. Anything else is somebody else's link. */
function isInstagramHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  return h === 'instagram.com' || h === 'instagr.am';
}

function isShortcode(value: string): boolean {
  if (value.length < SHORTCODE_MIN || value.length > SHORTCODE_MAX) return false;
  for (const ch of value) if (!SHORTCODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * The shortcode in a pasted link, or why there isn't one.
 *
 * LIBERAL ON THE WAY IN. Everything below is a real thing people paste:
 *
 *   https://www.instagram.com/reel/DY7I6FYPhwZ/?igsh=MWx…   the share sheet
 *   https://www.instagram.com/reels/DY7I6FYPhwZ             the web app
 *   https://www.instagram.com/koh_min_/reel/DY7I6FYPhwZ/    from a profile grid
 *   instagram.com/p/DY7I6FYPhwZ/                            typed, no protocol
 *   "  https://instagram.com/tv/DY7I6FYPhwZ/  \n"           pasted with the line
 *
 * CONSERVATIVE ON THE WAY OUT. The `canonicalUrl` returned is rebuilt from the
 * shortcode rather than trimmed from the input, so the query string the share
 * sheet appends — `igsh`, which is a tracking parameter tied to the sharer —
 * never reaches `reels.source_url` and never reaches a log.
 */
export function parseReelUrl(input: string): ReelUrlResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'not-instagram' };

  // A pasted link often arrives without a protocol. Adding one is not a guess
  // about intent — `URL` simply cannot parse `instagram.com/reel/x` — and a
  // string that already carries a scheme keeps it, so `mailto:` or `javascript:`
  // is still parsed as itself and refused below on its host.
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return { ok: false, reason: 'not-instagram' };
  }

  // http and https only. A `data:` or `file:` URL has no host to check and no
  // business in a field that feeds a server-side fetch.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'not-instagram' };
  }
  if (!isInstagramHost(url.hostname)) return { ok: false, reason: 'not-instagram' };

  const segments = url.pathname.split('/').filter((s) => s !== '');

  // The media segment may be first (`/reel/CODE`) or second (`/user/reel/CODE`).
  // Searching for it rather than indexing by position is what makes both work
  // without two regexes that can disagree.
  const at = segments.findIndex((s) => MEDIA_SEGMENTS.has(s.toLowerCase()));
  if (at === -1 || at > 1) return { ok: false, reason: 'not-a-post' };

  // `decodeURIComponent` before the alphabet check, never after: a `%2F` that is
  // decoded downstream by something else would smuggle a path separator past a
  // test performed on the encoded form.
  let candidate: string;
  try {
    candidate = decodeURIComponent(segments[at + 1] ?? '');
  } catch {
    return { ok: false, reason: 'not-a-post' };
  }

  if (!isShortcode(candidate)) return { ok: false, reason: 'not-a-post' };

  return {
    ok: true,
    shortcode: candidate,
    // Rebuilt, not echoed. `/reel/` is the canonical path for a clip and is what
    // lib/ingest/inbox/parse.ts writes for a DM'd one, so a reel saved both ways
    // carries the same permalink either way.
    canonicalUrl: `https://www.instagram.com/reel/${candidate}/`,
  };
}

/**
 * The media id behind a shortcode: base64 over `SHORTCODE_ALPHABET`, big-endian.
 *
 * BIGINT AND NOT NUMBER, and this is the bug that would otherwise be invisible.
 * A media pk is past 2^53 — the one measured against this code is
 * 3,907,756,277,551,209,497 — so accumulating in a double silently rounds, and
 * the rounded id is still a perfectly well-formed number that the API answers
 * `Media not found` to. The symptom would be "some reels just do not work".
 *
 * Returned as a decimal STRING because that is what goes in a URL path, and
 * because handing a BigInt to a template literal is one refactor away from
 * handing it something else. Null when the shortcode contains a character
 * outside the alphabet — which `parseReelUrl` has already ruled out, and which
 * is checked again here so this function is safe for any caller.
 */
export function shortcodeToMediaPk(shortcode: string): string | null {
  if (!isShortcode(shortcode)) return null;

  // `BigInt(n)` rather than the `0n` literal: tsconfig targets ES2017 and
  // BigInt literals are an ES2020 syntax error there.
  const base = BigInt(64);
  let n = BigInt(0);
  for (const ch of shortcode) {
    const i = SHORTCODE_ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * base + BigInt(i);
  }

  // Zero is not a media id — it is what an all-`A` string encodes to, and the
  // API answers `Invalid media_id 0`. Refusing here saves the round trip.
  if (n <= BigInt(0)) return null;
  return n.toString(10);
}

/**
 * The digits-only gate, at the boundary where the id becomes a URL.
 *
 * Exported and used rather than inlined so the assertion is impossible to
 * forget: ./instagram-media.ts calls it immediately before building the path,
 * and a future caller that builds its own path has this to reach for.
 */
export function isMediaPk(value: string): boolean {
  return /^[1-9][0-9]{0,24}$/.test(value);
}
