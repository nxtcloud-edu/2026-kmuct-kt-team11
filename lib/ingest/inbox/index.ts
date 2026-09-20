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
 * One reel share, normalised. Five fields, all of which the Messaging API can
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
