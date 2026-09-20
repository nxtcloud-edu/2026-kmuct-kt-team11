/**
 * The seam between "how a shared reel reaches us" and "what we do with it".
 *
 * Gaja gets reels by polling a logged-in Instagram account's DM inbox with its
 * own session cookies (lib/ingest/inbox/instagram-poll.ts). That is not a
 * supported interface, it carries real ban risk, and it is temporary — see
 * docs/gaja/reel-extraction-findings.md, "Pipeline facts worth keeping". The
 * replacement is the Meta Messaging API, which delivers the same `attachments`
 * payload by webhook with no polling and no risk.
 *
 * THAT REPLACEMENT IS THE ENTIRE POINT OF THIS FILE. When it lands it arrives as
 * a second `InboxSource` — `MessagingApiSource` — and nothing downstream changes:
 * not app/api/internal/ingest/instagram/route.ts's orchestration, not
 * resolveSenderToUser, not extractPlacesFromCaption, not saveReel. The webhook
 * has no cursor to resume from, so its `fetchNewClips` ignores `since` and drains
 * whatever it has buffered; the signature still fits, which is why `since` is
 * nullable rather than required.
 *
 * Anything Instagram-web-specific — cookie headers, the `X-IG-App-ID` value, the
 * shape of `inbox.threads[].items[]`, the circuit breaker — belongs behind this
 * interface and must not leak through `InboxClip`. If a field here can only be
 * produced by scraping, the seam has failed.
 */

/**
 * One candidate cover frame for a reel, already chosen.
 *
 * The payload offers fourteen of these per clip; `pickThumbCandidate`
 * (lib/ingest/inbox/parse.ts) picks one and only the winner crosses this seam. A
 * source that handed the whole ladder through would be pushing an
 * Instagram-shaped decision onto the caller, and the Messaging API's ladder is
 * not the same ladder.
 *
 * `url` IS EXPECTED TO DIE. It is a CDN link whose `oe=` parameter is an expiry
 * — roughly four and a half days in the sample that was measured. Nothing may
 * store it as the thumbnail; it is an instruction to go and fetch the bytes NOW,
 * which lib/ingest/thumbnail.ts does, once, at ingest time.
 */
export type InboxThumb = {
  url: string;
  /** As the payload reports them. The stored object is measured again after download. */
  width: number;
  height: number;
};

/**
 * The reel's own mp4, already chosen.
 *
 * `url` IS EXPECTED TO DIE, on exactly the terms `InboxThumb.url` does: it is a
 * signed CDN link whose `oe=` parameter is an expiry, measured at roughly four
 * and a half days. NOTHING MAY STORE IT. It is an instruction to spend the bytes
 * NOW, while the link is alive — lib/extract/asr.ts downloads it inside the
 * ingest pass and never again, and a design that fetched it when a user opened a
 * saved place would work in development and return 403 for anything saved last
 * week.
 *
 * Unlike the thumbnail there is no ladder to pick from here: the payload's
 * `video_versions` are the same reel at different bitrates, and the model reads
 * the first one as well as it reads the largest. See `videoOf` in ./parse.ts.
 */
export type InboxVideo = {
  url: string;
};

/**
 * One reel share, normalised. Seven fields, all of which the Messaging API can
 * also produce.
 */
export type InboxClip = {
  /**
   * The SENDER's Instagram-scoped id — who shared the reel, never the account
   * that received it.
   *
   * Named for the Messaging API's IGSID because that is the id space
   * `users.igsid` holds and `resolveSenderToUser` looks up. The web inbox does
   * not have one: it reports the sender's raw numeric pk, which is a DIFFERENT
   * id space and will not match an `igsid` written by a webhook. The poller puts
   * the pk here anyway rather than inventing a second field, and the mismatch is
   * survivable only because an unroutable sender is dropped and never saved —
   * see instagram-poll.ts. Do not read a match here as proof the two ids are
   * interchangeable; they are not, and the poller's routing is best-effort until
   * the Messaging API is the source.
   */
  igsid: string;

  /**
   * Stable per reel across shares and senders. The shortcode where one is
   * present (`DZrAQQMPiAt`), the media pk otherwise. Feeds
   * `reels.reel_video_id`, whose `unique (user_id, reel_video_id)` is what makes
   * a replayed pass harmless.
   */
  reelVideoId: string;

  /** Canonical permalink, or null when the payload carried no shortcode. */
  sourceUrl: string | null;

  /**
   * The full caption text, untruncated.
   *
   * This is the product. One observed share carried ten venues with addresses,
   * hours and menus in 1,226 characters of caption while `location` was null and
   * the on-screen title said only "ten cafés" — the caption is not metadata
   * about the reel, it is the payload. A source that returns a truncated or
   * absent caption has failed at its only job, even if every other field is
   * right.
   */
  caption: string | null;

  /**
   * The cover frame to copy, or null when the payload offered none usable.
   *
   * NULL IS ORDINARY AND MUST NOT COST THE REEL. A clip with no thumbnail still
   * carries the caption, and the caption is the product — dropping a ten-venue
   * listicle because its cover image was missing would trade the thing we want
   * for the picture of it. The deck falls back to lib/reel-thumb.ts.
   */
  thumb: InboxThumb | null;

  /**
   * The reel's mp4, or null when the payload carried none.
   *
   * NULL IS ORDINARY AND MUST NOT COST THE REEL, for the same reason a missing
   * thumbnail must not: the caption is the product and rung one of the ladder
   * runs on it alone. What a null costs is rung two — lib/extract/ladder.ts
   * records `{ ran: false, skipped: 'no-video' }` and the reel is judged on its
   * caption, which is the right answer for a listicle and a real loss for a vibe
   * reel that says everything on screen.
   *
   * This is the ONE field here that an unauthenticated server can use: the mp4
   * and the cover answer 200 to a plain fetch with no Instagram cookies —
   * verified — and only the inbox itself needs the session.
   */
  video: InboxVideo | null;

  /** When the share arrived. The cursor is a high-water mark over this. */
  sharedAt: Date;
};

/**
 * A place shared reels come from.
 *
 * `since` is a high-water mark, not a page token: implementations return clips
 * shared strictly after it, and everything they have when it is null. Returning
 * a clip twice is allowed and expected — the caller's write path is idempotent
 * on `(user_id, reel_video_id)` — but dropping one silently is not.
 *
 * Implementations throw rather than returning an empty array when they cannot
 * run. An empty array means "nothing new"; it must never mean "I am broken", or
 * the caller advances its cursor over a gap it never read.
 */
export interface InboxSource {
  fetchNewClips(since: Date | null): Promise<InboxClip[]>;
}
