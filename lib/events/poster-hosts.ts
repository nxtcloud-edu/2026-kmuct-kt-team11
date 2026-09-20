/**
 * The image hosts `events.poster_url` is allowed to name.
 *
 * ONE LIST, TWO READERS, AND THAT IS THE WHOLE POINT OF THE FILE.
 *
 *   `next.config.ts` turns it into `images.remotePatterns`, which is what
 *   `next/image` checks at request time. An absolute `src` whose host is not
 *   listed there does not degrade — the optimizer answers 400 and the card
 *   renders as a broken image.
 *
 *   The scrapers check it BEFORE writing a row. A poster from an unexpected
 *   host is stored as `null` instead, so the card falls back to the tinted
 *   placeholder it already has for posterless records. That turns "Next refuses
 *   this URL" into "this listing has no poster", which is a state the screen was
 *   built for.
 *
 * Without the second reader, the day yanolja moves to `image7.` is the day a
 * batch of cards renders broken in production. With it, that day is a batch of
 * cards with no picture — visibly worse, not visibly wrong, and it does not
 * require a deploy to stop being an error.
 *
 * ZERO IMPORTS, deliberately: `next.config.ts` is loaded by Next's own TypeScript
 * loader before the app exists, so anything this file pulled in would have to
 * survive that environment too. It is a data file.
 */

export type PosterHostPattern = {
  /** Exact host, or one leading `*.` wildcard standing for exactly one label. */
  hostname: string;
  /** Everything served for these images sits under this prefix. */
  pathPrefix: string;
};

/**
 * Narrow on BOTH axes, because a remote pattern is an instruction to our own
 * image optimizer to go and fetch whatever it is handed. A whole-origin entry
 * would let a future bad row point the optimizer at any path on that host; a
 * bare-hostname entry with no path is how an optimizer becomes a proxy.
 *
 * Every entry below was observed in a live response while this was built:
 *
 *   cdn.popga.co.kr/spot/…                 60 of 60 popga records
 *   ticketimage.interpark.com/Play/image/… 174 of 176 yanolja records
 *   image6.yanolja.com/cx-ydm/…            the other 2
 *
 * The yanolja entry is the one wildcard, and it is the numbered-CDN shard —
 * `image6` today, and there is no reason to believe the number is stable. The
 * path is pinned to `/cx-ydm/` to keep the wildcard from widening into "any path
 * on any yanolja subdomain".
 */
export const POSTER_HOSTS: PosterHostPattern[] = [
  { hostname: 'cdn.popga.co.kr', pathPrefix: '/spot/' },
  { hostname: 'ticketimage.interpark.com', pathPrefix: '/Play/image/' },
  { hostname: '*.yanolja.com', pathPrefix: '/cx-ydm/' },
];

/** `*.example.com` matches exactly one label, the same as Next's own semantics. */
function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(1); // '.yanolja.com'
  if (!host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes('.');
}

/**
 * Whether `next/image` will accept this URL, decided by the same list Next is
 * configured from.
 *
 * `https` only: an `http` poster would be mixed content on an https page, and
 * both CDNs serve TLS. A URL that will not parse is not allowed rather than
 * throwing — the caller is a scraper reading a field a stranger controls.
 */
export function isAllowedPosterUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // A query string would let one stored row address many different upstream
  // images through one allowlisted path. Nothing we scrape uses one.
  if (url.search) return false;
  return POSTER_HOSTS.some(
    (p) => hostMatches(p.hostname, url.hostname) && url.pathname.startsWith(p.pathPrefix),
  );
}
