import type { NextConfig } from "next";

import { POSTER_HOSTS } from "./lib/events/poster-hosts";

/**
 * Supabase Storage's public object route, which is where reel cover frames live
 * (lib/storage.ts).
 *
 * `next/image` refuses any absolute `src` whose host is not listed here — by
 * design, so that a compromised or careless row cannot turn our image optimizer
 * into an open proxy for arbitrary URLs. A missing entry is not a soft failure:
 * the request 400s and the card renders broken.
 *
 * BUILT FROM `SUPABASE_URL` rather than hardcoded, because the host is
 * per-project (`<ref>.supabase.co` hosted, `127.0.0.1:54321` locally) and a
 * literal would be wrong in at least one environment. This is read at BUILD
 * time, so a deployment that sets `SUPABASE_URL` only at runtime will not have
 * the pattern — the thumbnails then 400 while everything else works, which is a
 * confusing failure and worth knowing about before it happens.
 *
 * The pathname is narrowed to this one bucket's public prefix. Allowing the
 * whole Storage origin would also allow any other bucket a future migration
 * creates, including a private one whose objects were only ever meant to be
 * reachable with a signature.
 */
const supabase = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL) : null;

/**
 * `supabase start` serves Storage from 127.0.0.1:54321, and Next 16 refuses to
 * optimize an upstream image whose hostname resolves to a private IP —
 * measured, not guessed: the optimizer answers 400 and logs "hostname resolved
 * to private IP". Without the escape hatch below, every real thumbnail is a
 * broken card in local development while production works fine, which is the
 * kind of divergence that gets debugged twice.
 *
 * Scoped to exactly that case. The flag is derived from the configured Supabase
 * host, so it is true only when Storage IS the loopback address — a hosted
 * `<ref>.supabase.co` leaves it false and the SSRF protection intact. It is not
 * keyed on NODE_ENV, because what makes this safe is the destination being
 * local, not the build being a dev build.
 */
const supabaseIsLoopback =
  supabase !== null &&
  ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(supabase.hostname.replace(/^\[|\]$/g, ''));

/**
 * The events feed's poster hosts: popga's CDN and the two yanolja/interpark ones.
 *
 * READ FROM lib/events/poster-hosts.ts RATHER THAN WRITTEN OUT HERE, because the
 * scrapers check the same list before they store a URL. That second reader is
 * what turns "Next refuses this host" — a 400 and a visibly broken card — into
 * "this listing has no poster", which is a state the feed card was built for. A
 * copy of the list in this file would let the two drift, and they would drift
 * silently in the direction that breaks production.
 *
 * Unlike the Supabase entry above, these are NOT conditional on an environment
 * variable. They are fixed third-party hosts, the same in every environment, and
 * a config that only allows them when some unrelated variable happens to be set
 * is a config that fails in exactly one deployment.
 *
 * NOTE ON `next/image` AND THESE FILES. interpark serves its posters as
 * `…_p.gif` with `content-type: image/gif`, which the optimizer re-encodes. That
 * is fine and is not the trap this repo has hit before: the pure-black renders
 * in components/mbti-picker.tsx came from a gAMA+sRGB chunk pair in a PNG, and
 * GIF has no such chunk. If a poster ever does render black, the first thing to
 * check is whether the host started serving PNG.
 */
const posters = POSTER_HOSTS.map((p) => ({
  // https only. Both CDNs serve TLS, and an http poster would be mixed content
  // on an https page — the browser blocks it and the card breaks anyway.
  protocol: 'https' as const,
  hostname: p.hostname,
  pathname: `${p.pathPrefix}**`,
  // No query string, for the reason the Supabase entry gives: a stored row that
  // could vary its own `?` would address many upstream images through one
  // allowlisted path.
  search: '',
}));

const nextConfig: NextConfig = {
  images: {
    // Only ever true when Supabase Storage IS the loopback address; see above.
    dangerouslyAllowLocalIP: supabaseIsLoopback,
    remotePatterns: [
      ...(supabase
        ? [
            {
              // http locally (`supabase start` serves 127.0.0.1:54321 plain),
              // https everywhere else. Taken from the URL rather than forced, so
              // this cannot quietly downgrade a hosted project to http.
              protocol: supabase.protocol === 'http:' ? ('http' as const) : ('https' as const),
              hostname: supabase.hostname,
              port: supabase.port,
              pathname: '/storage/v1/object/public/reel-thumbs/**',
              // Objects are addressed by a random uuid path and never by query
              // string; refusing a search string keeps the optimizer from being
              // asked to fetch `…?download=1` or any other variant as a new image.
              search: '',
            },
          ]
        : []),
      ...posters,
    ],
  },
};

export default nextConfig;
