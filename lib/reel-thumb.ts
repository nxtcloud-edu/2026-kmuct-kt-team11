/**
 * FALLBACK stand-in reel stills. No longer the only path.
 *
 * The real cover frame now arrives with the reel: the Instagram DM payload
 * carries `clip.image_versions2.candidates`, the poller picks a portrait one
 * (lib/ingest/inbox/parse.ts, `pickThumbCandidate`), and the bytes are copied
 * into Gaja's own storage at ingest time (lib/ingest/thumbnail.ts) because the
 * CDN URL expires in about four and a half days. `saved_places.thumb_url` is
 * that image, and app/(app)/home/deck.tsx renders it whenever it is there.
 *
 * THIS FILE SURVIVES FOR THE ROWS THAT HAVE NO SUCH IMAGE, and there are three
 * kinds. Seeded and demo rows, which never came from a reel at all. Hand-entered
 * places, same. And reels whose cover genuinely failed to download — the
 * capture is allowed to fail without costing the reel, so a null thumbnail is a
 * designed outcome and not a bug. A card with a hole where a picture belongs is
 * worse than a card with a picture that is not this reel's, so those rows get
 * one of 24 sample frames from `public/reels/`.
 *
 * It is still a single delete, just not yet: when every row that reaches the
 * deck carries a real thumbnail, remove this file, remove `public/reels/`, and
 * drop the `??` in deck.tsx.
 *
 * The mapping is a hash of the row id rather than the array index, so a place
 * keeps the same image across sorts, reloads and pagination. An image that
 * reshuffles every time you change the sort order reads as a bug even when the
 * data is right.
 */

const COUNT = 24;

export function reelThumb(id: string): string {
  // FNV-1a over the uuid. Any stable hash would do; this one avoids the
  // clustering a plain charcode sum produces on uuids, which share a lot of
  // their bytes.
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `/reels/reel-${String(h % COUNT).padStart(2, '0')}.jpg`;
}
