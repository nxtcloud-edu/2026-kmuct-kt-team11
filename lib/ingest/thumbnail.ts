import { randomUUID } from 'node:crypto';
import { query } from '../db';
import { deleteReelThumb, putReelThumb, reelThumbStorageConfigured } from '../storage';
import { probeImage } from './image-probe';
import type { InboxThumb } from './inbox/index';

/**
 * Copy a reel's cover frame out of Instagram's CDN and into our own bucket.
 *
 * THE ONE RULE THIS FILE EXISTS TO HOLD: a thumbnail failure never costs the
 * reel. The caption is the product — one observed share carried ten venues with
 * addresses and hours — and losing all ten because a CDN hiccuped, or because a
 * response was 14 bytes of HTML, would be a far worse bug than the missing
 * picture it replaced. So this is called AFTER `saveReel` has committed, it
 * returns a reason instead of throwing, and the deck falls back to
 * lib/reel-thumb.ts when `thumb_path` is null. Same principle the geocoder
 * follows: the slow, failable, networked step happens outside the transaction.
 *
 * IT IS ALSO WHY THIS IS NOT INSIDE `saveReel`. That function holds one pooled
 * client (a pool of ONE per instance on Vercel — see lib/db.ts) for the whole
 * duration of its transaction, and a download plus an upload is two network
 * round trips. Putting them in there would hold a connection open across them.
 *
 * IDEMPOTENT ON TWO LEVELS. The caller skips this entirely when `saveReel`
 * reports `alreadyExisted`, so a redelivered DM re-downloads nothing; and the
 * UPDATE below is guarded by `thumb_path is null`, so if two passes do race, the
 * loser deletes its own upload rather than orphaning it in the bucket.
 */

/** Ten seconds. An unbounded fetch is a hang, not an error, and the pass has 60s for everything. */
const DOWNLOAD_TIMEOUT_MS = 10_000;

/**
 * 4 MiB, against an observed largest candidate of ~150 KB — a factor of about
 * 28. The bound is not about disk; it is about what happens when a URL that
 * promised a thumbnail answers with a video: without a cap the function buffers
 * it, and the memory ceiling of the whole ingest pass becomes whatever the other
 * end decided to send.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Sanity bounds on the decoded size. A 12x12 favicon and a 20000px panorama are
 * both technically images and neither is a reel cover; storing one would put a
 * visibly wrong picture in the deck rather than the honest fallback.
 */
const MIN_EDGE = 120;
const MAX_EDGE = 8000;

export type ThumbCapture = {
  /** Path inside `REEL_THUMB_BUCKET`. Random, never derived from the reel. */
  path: string;
  /** Decoded from the stored bytes, not copied from the candidate. */
  width: number;
  height: number;
  bytes: number;
  contentType: string;
};

export type ThumbOutcome =
  | { ok: true; capture: ThumbCapture }
  /** A short tag, safe to log and to count. Never a URL, never a response body. */
  | { ok: false; reason: string };

/**
 * Reject anything that is not a plain public HTTPS fetch.
 *
 * The URL arrives inside an undocumented third-party payload, which makes it
 * attacker-influenced input to a server-side fetch — the definition of SSRF. A
 * `file://` URL, or one pointing at 169.254.169.254, would otherwise be
 * downloaded by our server, with our network position, and its contents uploaded
 * to a bucket that serves them publicly.
 *
 * Deliberately NOT an allowlist of `*.cdninstagram.com`: the Meta Messaging API
 * replacement serves its media from different hosts, and a domain list here
 * would fail closed on the day the seam is swapped, silently, as a missing
 * picture. The dangerous thing is the private address space, and that is what is
 * named.
 */
function fetchableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host.startsWith('fd') ||
    host.startsWith('fe80:') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host)
  ) {
    return null;
  }
  return url;
}

/**
 * Read the body with a hard ceiling.
 *
 * `res.arrayBuffer()` would buffer whatever arrives before anyone could check
 * its size, and `Content-Length` is a claim by the sender — it can be absent, or
 * it can lie. Streaming and counting is the only version where the ceiling is
 * actually enforced.
 */
async function readBounded(res: Response, limit: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'));
  // A truthful oversize header saves the download entirely; a false one changes
  // nothing, because the loop below stops at the same limit.
  if (Number.isFinite(declared) && declared > limit) return null;

  const body = res.body;
  if (!body) return null;

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Releases the socket on the oversize path too; without it the connection
    // stays open until GC, once per oversize response.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Download, verify, upload, record. Returns a reason rather than throwing.
 *
 * `reelId` is the row `saveReel` just wrote. It is NOT used to build the object
 * path — see below.
 */
export async function captureReelThumbnail(
  reelId: string,
  thumb: InboxThumb,
): Promise<ThumbOutcome> {
  if (!reelThumbStorageConfigured()) return { ok: false, reason: 'storage-not-configured' };

  const url = fetchableUrl(thumb.url);
  if (!url) return { ok: false, reason: 'url-refused' };

  let bytes: Buffer | null;
  try {
    const res = await fetch(url, {
      // No cookies, no Instagram headers, no credentials of any kind. This was
      // measured: the candidate URLs answer 200 to a plain server-side fetch —
      // they are pre-signed public links, which is also why they expire. Sending
      // the poller's session cookie to a CDN would leak the account's strongest
      // credential to a host that never asked for it.
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    bytes = await readBounded(res, MAX_BYTES);
  } catch {
    // The URL is not logged. It carries a signature and an expiry and there is
    // nothing a reader could do with it hours later but confuse themselves.
    return { ok: false, reason: 'download-failed' };
  }
  if (!bytes) return { ok: false, reason: 'too-large' };

  // The bytes decide what this is, not the header. See lib/ingest/image-probe.ts.
  const probed = probeImage(bytes);
  if (!probed) return { ok: false, reason: 'not-an-image' };
  if (
    probed.width < MIN_EDGE ||
    probed.height < MIN_EDGE ||
    probed.width > MAX_EDGE ||
    probed.height > MAX_EDGE
  ) {
    return { ok: false, reason: 'implausible-dimensions' };
  }

  // THE PATH IS THE CAPABILITY. The bucket is public (argued in
  // 20260920000009_reel_thumbnails.sql), so the only thing standing between a
  // stranger and a given object is not being able to name it. A path built from
  // the reel id, the user id, the Instagram shortcode or a counter would all be
  // guessable or enumerable from information people already have. A random uuid
  // is not, and nothing needs to derive the path from the row — the row stores it.
  const path = `${randomUUID()}.${EXTENSION[probed.contentType]}`;

  // The content type comes from the probe, so the browser is told what the file
  // actually is rather than what the CDN said it was. `putReelThumb` refuses to
  // overwrite; see lib/storage.ts.
  const uploaded = await putReelThumb(path, bytes, probed.contentType);
  if (!uploaded.ok) return { ok: false, reason: uploaded.reason };

  // `thumb_path is null` is the idempotency guard, not a formality: two passes
  // racing the same fresh reel both upload, and exactly one gets to record it.
  const recorded = await query<{ id: string }>(
    `update reels
        set thumb_path = $2, thumb_width = $3, thumb_height = $4,
            thumb_captured_at = now(), thumb_source_url = $5
      where id = $1 and thumb_path is null
      returning id`,
    [reelId, path, probed.width, probed.height, thumb.url],
  );

  if (recorded.length === 0) {
    // Lost the race, or the reel was deleted under us. Either way this object is
    // referenced by nothing and would sit in the bucket forever — a public,
    // unreferenced file is exactly the litter a storage bill is made of.
    await deleteReelThumb(path).catch(() => false);
    return { ok: false, reason: 'already-captured' };
  }

  return {
    ok: true,
    capture: {
      path,
      width: probed.width,
      height: probed.height,
      bytes: bytes.length,
      contentType: probed.contentType,
    },
  };
}
