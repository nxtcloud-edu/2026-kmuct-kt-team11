/**
 * Reading `GET /api/v1/direct_v2/inbox/` and the message-request folder beside
 * it — the pure half of the Instagram poller.
 *
 * Kept apart from instagram-poll.ts, which owns the network, the cookies and the
 * circuit breaker, so that the part with the interesting bugs can be tested
 * against a committed fixture without a socket. Nothing in this file may import
 * anything with a side effect: it takes parsed JSON and returns `InboxClip[]`.
 * `parse.test.ts` compiles this module ALONE (scripts/test-ingest.sh), so a
 * runtime import added here breaks the test run, not just its purity.
 *
 * Every shape below is defended rather than asserted. The payload is not a
 * contract — it is whatever a logged-in browser happened to be served on
 * 2026-09-20, from an interface with no versioning, no deprecation notice and no
 * obligation to us. `item.clip.clip` becoming `item.clip` overnight is a
 * Tuesday. The rule this file follows: an unrecognised item is skipped, never
 * guessed at and never thrown over, because one malformed item in a thread must
 * not cost us the other nine.
 *
 * THERE IS A SECOND CALLER. `readMedia` below is exported for
 * lib/ingest/paste/instagram-media.ts, which fetches one media by shortcode from
 * `GET /api/v1/media/{pk}/info/` and gets back `items[0]` — verified 2026-09-20
 * to be the SAME media object this file reads out of a DM, with `code`,
 * `caption.text`, `video_versions` and `image_versions2` all present and all the
 * same shape. That is why the paste feature is a second source and not a second
 * pipeline: one definition of how an Instagram media object becomes a reel, used
 * by both, so the two can never disagree about which cover frame to keep or how
 * much of a caption counts.
 *
 * AND A THIRD READER, added 2026-09-20: `parsePendingThreads`, for the message
 * REQUEST folder — where a reel from somebody who does not follow the Gaja
 * account lands, and where every new user's first share therefore lands. It
 * shares `clipsInThread` with the ordinary inbox because the two return the same
 * thread shape, and two readers would be two chances to disagree about what a
 * clip is. What it does NOT share is the return type: a pending thread comes back
 * with its `thread_id`, because accepting a message request is a write to
 * somebody else's conversation and the caller has to be able to name the one
 * thread it is accepting.
 */

import type { InboxClip, InboxThumb, InboxVideo } from './index';

/** Records are read field by field; nothing here trusts a shape it has not checked. */
type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  // Instagram sends media pks and user ids as JSON numbers in some payloads and
  // as strings in others, sometimes both in the same response (`pk` vs `pk_id`).
  // A pk is past 2^53 and a Number round-trip corrupts it, so the string form is
  // preferred everywhere it exists — but a number that IS exact still beats
  // dropping the item.
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Instagram timestamps the direct inbox in MICROseconds since the epoch, which
 * is the single easiest thing to get wrong here: read as milliseconds,
 * 1,758,000,000,000,000 is the year 57,700, every clip sorts after every cursor,
 * and the poller re-ingests the entire inbox on every pass while reporting
 * success. The magnitude test is deliberate — it costs nothing and it means a
 * payload that quietly switches unit does not silently break the cursor.
 */
function toDate(v: unknown): Date | null {
  const raw = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e14 ? raw / 1000 : raw > 1e11 ? raw : raw * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The media object inside a clip item.
 *
 * Observed as `item.clip.clip` — a `clip` envelope wrapping the media, which
 * also carries share metadata. Older captures and some item variants put the
 * media directly at `item.clip`. Both are accepted by looking for the field that
 * identifies a medium (`code` or `pk`) rather than by trusting either path.
 */
function mediaOf(item: Json): Json | null {
  const envelope = obj(item.clip);
  if (!envelope) return null;
  const inner = obj(envelope.clip);
  if (inner && (str(inner.code) ?? str(inner.pk))) return inner;
  if (str(envelope.code) ?? str(envelope.pk)) return envelope;
  return null;
}

/**
 * The caption, in full.
 *
 * `caption` is an object with a `.text`, and it is null on reels posted without
 * one — null is a real, common answer, not a parse failure. The string fallback
 * exists because `caption` has been seen flattened; it is one line and it costs
 * nothing to keep the ten venues when it happens.
 *
 * Nothing here truncates, trims to a preview, or strips emoji. The emoji ARE the
 * grammar the extractor parses (📍 name, 🕰️ hours, 📓 menu), and a caption
 * clipped to a preview length is the failure this pipeline cannot detect
 * downstream — a 200-character prefix of a listicle parses cleanly as two
 * venues and reports high confidence.
 */
function captionOf(media: Json): string | null {
  const caption = media.caption;
  if (typeof caption === 'string') return caption.length > 0 ? caption : null;
  const c = obj(caption);
  if (c && typeof c.text === 'string' && c.text.length > 0) return c.text;
  return null;
}

/**
 * The width the deck actually needs, in device pixels.
 *
 * The phone canvas is 430px and the thumbnail occupies 62% of a card inset by
 * 13 units of padding — call it ~260 CSS px, which `deck.tsx` already declares
 * as its `sizes`. At the 2x DPR of every phone this ships to that is ~520 real
 * pixels; 860 is that rounded up hard, because the same object is also what a
 * future full-bleed or 3x surface will reach for and re-downloading a reel's
 * cover a year later is not possible — the URL will be long dead.
 *
 * Deliberately a width and not an index. `candidates[3]` is a guess about the
 * order of an array nobody promised us; a width is a statement about the screen.
 */
export const THUMB_TARGET_WIDTH = 860;

/**
 * Pick the frame to copy out of the ladder the payload offers.
 *
 * THE RULE, in one line: the smallest PORTRAIT candidate at least
 * `THUMB_TARGET_WIDTH` wide, else the largest portrait there is.
 *
 * Portrait first, and not as a tie-break. A reel is 9:16 and the payload carries
 * square variants (1080x1080 down to 150x150) alongside the portrait ladder
 * (1215x2160 … 240x427). A square is not a smaller version of the frame — it is a
 * centre crop of it, and the venue, the sign and the plate are what a centre crop
 * of a vertical composition throws away. A visibly cropped cover is worse than a
 * slightly soft one.
 *
 * Smallest-that-suffices, not largest-available: the bytes are ours to store and
 * serve forever, 1215x2160 is roughly four times the area we will ever paint, and
 * the extra pixels cost storage on every reel of every user to be discarded by
 * the browser on every render.
 *
 * Falling back to the largest portrait when none reaches the target is the honest
 * end of the ladder — a soft cover beats no cover, and there is no second chance
 * to fetch a bigger one.
 *
 * Pure, total, and exported for its own test: no fetch, no clock, no randomness.
 * Feed it nonsense and it returns null.
 */
export function pickThumbCandidate(candidates: readonly InboxThumb[]): InboxThumb | null {
  const usable = candidates.filter(
    (c) =>
      typeof c.url === 'string' &&
      c.url.length > 0 &&
      Number.isFinite(c.width) &&
      Number.isFinite(c.height) &&
      c.width > 0 &&
      c.height > 0,
  );
  if (usable.length === 0) return null;

  // Strictly taller than wide. A 1080x1080 square is not portrait, and treating
  // it as one is exactly the mistake this function exists to prevent.
  const portrait = usable.filter((c) => c.height > c.width);
  // If Instagram ever stops shipping a portrait ladder the same rule is applied
  // to whatever IS there, rather than returning null — a square cover is a
  // degraded cover, but no cover at all is a hole in the deck.
  const pool = portrait.length > 0 ? portrait : usable;

  // Sorted rather than reduced so ties are resolved by a stated rule instead of
  // by the array's order: two candidates of the same width are separated by
  // height, and two of the same size by url, so the choice is reproducible
  // across two passes over the same payload.
  const bySize = [...pool].sort(
    (a, b) => a.width - b.width || a.height - b.height || a.url.localeCompare(b.url),
  );

  return bySize.find((c) => c.width >= THUMB_TARGET_WIDTH) ?? bySize[bySize.length - 1];
}

/**
 * `media.image_versions2.candidates`, read defensively and handed to the picker.
 *
 * Every field is checked rather than asserted, on the same rule as the rest of
 * this file: `image_versions2` is an undocumented shape on an unversioned
 * endpoint, and an item whose thumbnail block has gone strange must lose its
 * thumbnail, not its caption.
 */
function thumbOf(media: Json): InboxThumb | null {
  const block = obj(media.image_versions2);
  if (!block) return null;

  const candidates: InboxThumb[] = [];
  for (const raw of arr(block.candidates)) {
    const c = obj(raw);
    if (!c) continue;
    const url = typeof c.url === 'string' && c.url.length > 0 ? c.url : null;
    const width = typeof c.width === 'number' ? c.width : Number(str(c.width) ?? NaN);
    const height = typeof c.height === 'number' ? c.height : Number(str(c.height) ?? NaN);
    if (!url || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    candidates.push({ url, width, height });
  }

  return pickThumbCandidate(candidates);
}

/**
 * `media.video_versions[0].url` — the reel's mp4, read defensively.
 *
 * NO PICKER, unlike `thumbOf`. The thumbnail ladder mixes squares with portraits
 * and the choice between them decides whether the venue survives the crop; the
 * video ladder is the same 9:16 reel at several bitrates, and rung two of the
 * extraction ladder is reading burned-in text and listening to speech off it.
 * Instagram orders these highest-quality-first, and the first entry is what the
 * measurement in lib/extract/asr.ts was taken against: 720x1280, 4,350,463 bytes
 * for 9.6s, transcribed in 3.9s. Sorting by a `width` this payload does not
 * reliably carry would be a guess dressed as a rule.
 *
 * What IS defended is the shape. `video_versions` is an undocumented field on an
 * unversioned endpoint, and a clip whose video block has gone strange must lose
 * its video, not its caption — the caption is the product and rung one runs on
 * it alone.
 */
function videoOf(media: Json): InboxVideo | null {
  for (const raw of arr(media.video_versions)) {
    const v = obj(raw);
    if (!v) continue;
    const url = typeof v.url === 'string' && v.url.length > 0 ? v.url : null;
    // http, never anything else. A `data:` or `file:` url here would be handed
    // straight to a fetch in lib/extract/asr.ts, and the payload is not ours.
    if (url && /^https?:\/\//i.test(url)) return { url };
  }
  return null;
}

/**
 * One Instagram media object, read into the five fields a reel is made of.
 *
 * THE SHARED DEFINITION, and the only place the five reads live. A reel that
 * arrives as a DM and the same reel fetched by its shortcode go through this
 * function, so they cannot end up with different captions, different cover
 * frames or different ids — which matters because `reels.reel_video_id` is what
 * `unique (user_id, reel_video_id)` dedupes on. If the two paths disagreed about
 * whether the id is the shortcode or the pk, the same reel saved twice would be
 * two rows.
 *
 * Null when the object carries neither a `code` nor a `pk` — there is then
 * nothing to key the reel by, and a reel with no stable id cannot be deduped and
 * must not be written.
 *
 * Takes the MEDIA, not the DM item that wraps it. Unwrapping `item.clip.clip` is
 * the inbox payload's problem and stays in `mediaOf`.
 */
export function readMedia(
  value: unknown,
): Omit<InboxClip, 'igsid' | 'senderUsername' | 'sharedAt'> | null {
  const media = obj(value);
  if (!media) return null;

  // Shortcode first: it is what a permalink is built from, what a human can
  // paste into a browser to check a row, and what a support conversation will
  // quote. The pk is the fallback for a payload that omits it.
  const code = str(media.code);
  const reelVideoId = code ?? str(media.pk);
  if (!reelVideoId) return null;

  return {
    reelVideoId,
    sourceUrl: code ? `https://www.instagram.com/reel/${code}/` : null,
    caption: captionOf(media),
    thumb: thumbOf(media),
    video: videoOf(media),
  };
}

/**
 * Is this media a reel, rather than a photo post?
 *
 * `product_type: 'clips'` is Instagram's own answer and is what the observed
 * payload carries for a reel; `media_type: 2` means video. Either one is taken
 * as a yes, because this is a gate on a user's paste and the cost of the two
 * errors is not symmetric — refusing a real reel because a field was renamed
 * strands the user with a link that works in their browser, while letting a
 * video post through costs nothing at all: it has a caption and the same
 * extractor reads it.
 *
 * `video_versions` is the last resort and the most honest signal of the three:
 * if there is an mp4, there is something the ladder's video rung can read.
 *
 * Exported for the paste source, which is the only caller — a DM item is already
 * filtered by `item_type === 'clip'` upstream and never reaches this.
 */
export function isReelMedia(value: unknown): boolean {
  const media = obj(value);
  if (!media) return false;
  if (str(media.product_type) === 'clips') return true;
  if (media.media_type === 2) return true;
  return videoOf(media) !== null;
}

export type ParseOptions = {
  /**
   * `IG_DS_USER_ID` — the polling account's own id. Items it authored are its
   * own outgoing messages; ingesting them would file the account's own shares
   * under whichever Gaja user happens to have that igsid.
   */
  selfUserId: string;
  /** High-water mark. Clips at or before it have already been through a pass. */
  since: Date | null;
};

/**
 * Who the people in a thread are, by id.
 *
 * `thread.users[]` is the ONLY place a sender's @handle appears; the items carry
 * a bare `user_id` and nothing else. Both `pk` and `pk_id` are indexed because
 * the payload carries both and has been seen to supply one without the other —
 * they are the same number, one as a JSON number and one as a string, and
 * `str()` already prefers the exact form.
 *
 * Lowercased here rather than at the caller so there is exactly one place the
 * casing rule lives. `users_instagram_handle_lower_idx` and the
 * `users_instagram_handle_shape` CHECK both hold the lowercase form; a handle
 * that reached `resolveSenderToUser` as typed by Instagram would miss its own
 * row over a capital letter.
 */
function usernamesById(thread: Json): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of arr(thread.users)) {
    const u = obj(raw);
    if (!u) continue;
    const username = str(u.username);
    if (!username) continue;
    for (const key of [str(u.pk), str(u.pk_id)]) {
      if (key) out.set(key, username.toLowerCase());
    }
  }
  return out;
}

/**
 * Every clip share in one thread's `items[]`, unsorted.
 *
 * Shared by the ordinary inbox and the message-request folder, which return the
 * SAME thread shape on the same endpoint family — verified against the live
 * inbox on 2026-09-20, where a pending thread differs from an accepted one by a
 * `pending: true` flag and nothing that matters here. Two readers would be two
 * chances to disagree about what a clip is.
 */
function clipsInThread(thread: Json, opts: ParseOptions): InboxClip[] {
  const handles = usernamesById(thread);
  const out: InboxClip[] = [];

  for (const rawItem of arr(thread.items)) {
    const item = obj(rawItem);
    if (!item) continue;

    // The one filter that is not defensive: a thread carries text, reactions,
    // link shares and post shares alongside clips, and only `clip` is a reel.
    // `product_type: 'clips'` on the media says the same thing, but it lives
    // one level down and is absent in some captures, so the item-level type is
    // the gate.
    if (item.item_type !== 'clip') continue;

    const sender = str(item.user_id);
    if (!sender) continue;
    if (sender === opts.selfUserId) continue;

    const sharedAt = toDate(item.timestamp);
    if (!sharedAt) continue;
    if (opts.since && sharedAt.getTime() <= opts.since.getTime()) continue;

    const media = mediaOf(item);
    if (!media) continue;

    // The five fields, read by the shared definition above rather than here.
    // A media with no id at all is skipped, on this file's standing rule: one
    // malformed item must not cost the other nine.
    const payload = readMedia(media);
    if (!payload) continue;

    // NULL WHEN THE THREAD DID NOT NAME THIS SENDER, and null must stay
    // survivable: a missing handle costs the handle route, never the clip. The
    // igsid route still runs, and an unroutable clip is dropped and counted.
    out.push({
      igsid: sender,
      senderUsername: handles.get(sender) ?? null,
      ...payload,
      sharedAt,
    });
  }

  return out;
}

/**
 * Every clip share in an inbox payload, oldest first.
 *
 * Oldest first matters: the caller advances its cursor to the last clip it
 * processed, so a descending order would move the high-water mark past clips it
 * had not reached yet if the pass stopped early.
 */
export function parseInboxClips(payload: unknown, opts: ParseOptions): InboxClip[] {
  const root = obj(payload);
  const inbox = root ? obj(root.inbox) : null;
  if (!inbox) return [];

  const out: InboxClip[] = [];
  for (const rawThread of arr(inbox.threads)) {
    const thread = obj(rawThread);
    if (!thread) continue;
    out.push(...clipsInThread(thread, opts));
  }

  out.sort((a, b) => a.sharedAt.getTime() - b.sharedAt.getTime());
  return out;
}

/**
 * Instagram's own count of waiting message requests, off any inbox response.
 *
 * THE CROSS-CHECK THAT MAKES AN UNREADABLE REQUEST FOLDER LOUD. The ordinary
 * `/inbox/` response carries `pending_requests_total` at the top level — a
 * number the account holder sees as the "Requests" badge — and it arrives on the
 * read the poller already makes, for free. When the message-request folder
 * cannot be read, this is the difference between "nobody is DMing us" and
 * "somebody is DMing us and we are blind to it".
 *
 * Null when the field is absent, which is NOT zero: a payload that stopped
 * carrying the field must not be reported as an empty request folder.
 */
export function parsePendingRequestsTotal(payload: unknown): number | null {
  const root = obj(payload);
  if (!root) return null;
  const raw = root.pending_requests_total;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * One message-request thread: the id needed to accept it, and the reels in it.
 *
 * `threadId` DOES NOT CROSS THE `InboxSource` SEAM and must not start to. It is
 * an Instagram thread identifier — it names a private conversation, it means
 * nothing to the Messaging API, and the only thing that consumes it is the
 * approve call two functions away in instagram-poll.ts. It is kept out of
 * `InboxClip` for exactly that reason.
 */
export type PendingThread = {
  threadId: string;
  /** Clips already filtered by `since` and by sender, oldest first. */
  clips: InboxClip[];
};

/**
 * The message-request folder, as threads rather than as a flat clip list.
 *
 * THE SHAPE IS THE POINT. Accepting a message request is a write to somebody
 * else's conversation, so the caller has to be able to say "approve THIS thread
 * because it has a reel in it" — which a flat list of clips cannot express. A
 * thread with no clips in it comes back with an empty `clips` array rather than
 * being dropped here, because "seen but not worth approving" and "not seen" are
 * different facts and the pass summary reports both.
 *
 * Pure, like everything else in this file: it approves nothing and requests
 * nothing. It reads a payload and returns what is in it.
 */
export function parsePendingThreads(payload: unknown, opts: ParseOptions): PendingThread[] {
  const root = obj(payload);
  const inbox = root ? obj(root.inbox) : null;
  if (!inbox) return [];

  const out: PendingThread[] = [];
  for (const rawThread of arr(inbox.threads)) {
    const thread = obj(rawThread);
    if (!thread) continue;

    // No id, no approve call — and a thread that cannot be approved cannot be
    // ingested from either, because its reels stay behind the request wall.
    const threadId = str(thread.thread_id);
    if (!threadId) continue;

    const clips = clipsInThread(thread, opts);
    clips.sort((a, b) => a.sharedAt.getTime() - b.sharedAt.getTime());
    out.push({ threadId, clips });
  }

  return out;
}

/**
 * Does this response mean "stop"?
 *
 * Separated from the fetch so it can be tested against captured bodies, and so
 * the list of things that trip the breaker is readable in one place rather than
 * scattered through a request function.
 *
 * Returns a short reason to persist, or null when the response is ordinary.
 * Deliberately NOT a boolean: the reason is the only thing a human resetting the
 * breaker has to go on, and "429" and "checkpoint_required" call for very
 * different next moves.
 */
export function detectBlock(status: number, payload: unknown): string | null {
  // 401: the session cookie is dead or revoked. Retrying re-submits a known-bad
  // credential, which is the signature of a compromised-account probe.
  if (status === 401) return 'http-401-session-invalid';
  // 429: Instagram has already decided we are too fast. Backing off and
  // continuing is still polling; the account stays flagged either way.
  if (status === 429) return 'http-429-rate-limited';
  // 403 is not automatically a block — it is also what a stale CSRF token
  // returns — so it is judged on the body below rather than on the status.

  const body = obj(payload);
  if (!body) return null;

  // Instagram's own vocabulary for "a human must go and clear this". Any of
  // these means the account is in an interstitial; the next request is a request
  // made against an account already under review.
  const message = typeof body.message === 'string' ? body.message : '';
  if (message === 'challenge_required') return 'challenge_required';
  if (message === 'checkpoint_required') return 'checkpoint_required';
  if (message === 'login_required') return 'login_required';
  if (obj(body.challenge)) return 'challenge_required';
  if (typeof body.checkpoint_url === 'string' && body.checkpoint_url.length > 0) {
    return 'checkpoint_required';
  }
  if (body.require_login === true) return 'login_required';
  // `status: 'fail'` alone is not a block — a malformed cursor returns it too —
  // so it is reported only when paired with a spelled-out reason above.

  return null;
}
