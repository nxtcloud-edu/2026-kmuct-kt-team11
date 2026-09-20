/**
 * MOCK. Stand-in reel stills for slice 3.
 *
 * `saved_places` has no thumbnail column and `places` has no photo: the real
 * still is captured when the extraction ladder runs, which is slice 3's work.
 * Until then the deck would be a wall of text, so each saved place is given one
 * of 24 sample frames.
 *
 * This is the one place in the product that shows a picture it did not earn, and
 * it is deliberately quarantined here so it is a single delete later — remove
 * this file, remove `public/reels/`, and read the real still off the row.
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
