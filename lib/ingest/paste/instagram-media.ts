/**
 * `InstagramMediaSource` — fetches ONE reel by its shortcode, server side, with
 * the Gaja Instagram account's own session cookies.
 *
 * The sibling of lib/ingest/inbox/instagram-poll.ts and built on the same terms.
 * This is `GET /api/v1/media/{pk}/info/`, the endpoint the instagram.com web
 * client calls when you open a post, and Instagram owes us nothing about it.
 * What was actually observed on 2026-09-20, against a live reel:
 *
 *   /reel/DY7I6FYPhwZ/ → pk 3907756277551209497 → 200, 64,914 bytes.
 *   items[0] carries `code`, `caption.text` (740 chars), `video_versions` (3),
 *   `image_versions2.candidates` (14), `product_type: 'clips'`, `media_type: 2`
 *   — the SAME media object a DM share carries, which is why `readMedia` in
 *   lib/ingest/inbox/parse.ts reads both and there is no second parser here.
 *
 *   A shortcode that does not resolve answers 400 with
 *   `{"message":"Media not found or unavailable"}`. A malformed pk answers 400
 *   with `{"message":"Invalid media_id ..."}`. Neither is a block signal and
 *   neither trips the breaker.
 *
 * THE CREDENTIALS NEVER MOVE. The URL comes from the client; the fetch does not.
 * `sessionid` is a bearer credential for the whole Instagram account, it is read
 * from the environment inside this module, and nothing it touches — not an error
 * message, not a log line, not a response body — carries it outward. Same rule
 * as the poller, for the same reason, and see `readCredentials` there.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * THE CIRCUIT BREAKER IS SHARED WITH THE POLLER, AND THAT IS DELIBERATE.
 *
 * `ingest_state` keys the breaker by source, and this source reads and trips the
 * POLLER's key rather than one of its own. It is one Instagram account: a 401
 * here means the same dead session the poller would hit, and a 429 here is the
 * same account being told it is going too fast. Two independent breakers would
 * mean a user pasting links could keep hammering an account the poller has
 * already stopped for — which is precisely the behaviour instagram-poll.ts
 * refuses to have, written down at length in its `request` method.
 *
 * The cost is real and is accepted: one user's paste can halt DM ingestion for
 * everyone until a human clears the challenge and resets `breaker_tripped_at` by
 * hand. That is the correct trade. Losing a few hours of ingestion is
 * recoverable; losing the account is not.
 *
 * THERE IS NO RETRY IN THIS FILE AND NONE MAY BE ADDED, on exactly the terms the
 * poller states.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { detectBlock, isReelMedia, readMedia } from '../inbox/parse';
import {
  InboxBreakerTrippedError,
  InboxNotConfiguredError,
} from '../inbox/instagram-poll';
import { INSTAGRAM_POLL_SOURCE, getIngestState, tripBreaker } from '../state';
import type { ReelPayload } from '../ingest-clip';
import type { ReelUrlSource } from './index';
import { isMediaPk, shortcodeToMediaPk } from './url';

/**
 * The web client's own app id. A public constant baked into instagram.com's
 * JavaScript, not a credential — it identifies the surface, and the request is
 * rejected outright without it.
 */
const IG_WEB_APP_ID = '936619743392459';

/**
 * A real browser's UA, because the request is claiming to be one. A library
 * default ("node", "undici") on an endpoint only a browser calls is the single
 * loudest signal we could send, and the account pays for it.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';

/** Nothing hangs forever. An unbounded fetch holds a function until the platform kills it. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Instagram answered, and the answer was "there is no such post, or you may not
 * see it".
 *
 * ONE CLASS FOR THREE CAUSES — deleted, private, and never-existed — because
 * Instagram does not distinguish them either: all three come back as the same
 * 400 with the same body. Inventing three problem codes over one response would
 * be telling the user something we do not know. Worse, distinguishing "private"
 * from "deleted" would leak the existence of a private post to anyone holding a
 * shortcode, which is a thing Instagram is careful not to do and we should not
 * undo for them.
 */
export class ReelUnavailableError extends Error {
  constructor(readonly shortcode: string) {
    super(`instagram media ${shortcode} is not available to this session`);
    this.name = 'ReelUnavailableError';
  }
}

/**
 * The link resolved to a post that is not a reel — a photo, a carousel of
 * photos.
 *
 * Its own class because the remedy is the user's and is specific: they pasted a
 * `/p/` link to a photo. Nothing is wrong with the account, the session or the
 * pipeline, and telling them "저장하지 못했어요" would send them looking for a
 * fault that is not there.
 */
export class NotAReelError extends Error {
  constructor(readonly shortcode: string) {
    super(`instagram media ${shortcode} is not a reel`);
    this.name = 'NotAReelError';
  }
}

/**
 * A 200 whose body did not contain a media we could read.
 *
 * Separate from `ReelUnavailableError` because it means something different:
 * Instagram said yes and handed us a shape we do not recognise, which is the
 * payload drifting rather than the post being gone. It is the error that should
 * send someone to look at the parser, and conflating it with "deleted post"
 * would hide a schema change behind a message users are used to seeing.
 */
export class ReelPayloadError extends Error {
  constructor(readonly shortcode: string) {
    super(`instagram media ${shortcode} returned an unreadable payload`);
    this.name = 'ReelPayloadError';
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new InboxNotConfiguredError(name);
  return value;
}

export class InstagramMediaSource implements ReelUrlSource {
  async fetchByShortcode(shortcode: string): Promise<ReelPayload> {
    // THE PATH SEGMENT, COMPUTED AND THEN RE-CHECKED. `shortcodeToMediaPk`
    // already refuses anything outside the base64 alphabet, so a non-numeric
    // result is unreachable — and the digits-only assertion runs anyway, because
    // the thing standing between a user-supplied string and a server-side URL
    // path should not be one function's word for it.
    const pk = shortcodeToMediaPk(shortcode);
    if (!pk || !isMediaPk(pk)) throw new ReelUnavailableError(shortcode);

    // Credentials read before the breaker check so a deployment with no
    // `IG_SESSION_ID` reports the missing variable rather than a tripped
    // breaker — the two have very different fixes and only one of them is ours.
    const sessionId = required('IG_SESSION_ID');
    const csrfToken = required('IG_CSRF_TOKEN');
    const dsUserId = required('IG_DS_USER_ID');

    // THE SHARED BREAKER, checked before a single byte goes out. The poller
    // checks its own twice for the reason its header gives — a guard that lives
    // only in one caller is a guard the next caller does not have — and this is
    // that next caller.
    const state = await getIngestState(INSTAGRAM_POLL_SOURCE);
    if (state.breakerTrippedAt) {
      throw new InboxBreakerTrippedError(state.breakerReason ?? 'unknown');
    }

    const payload = await this.request(pk, sessionId, csrfToken, dsUserId);

    const media = firstItem(payload);
    if (!media) throw new ReelUnavailableError(shortcode);

    // Order matters: "not a reel" is checked before the fields are read, so a
    // photo post reports what it is rather than reporting that its video was
    // missing.
    if (!isReelMedia(media)) throw new NotAReelError(shortcode);

    const reel = readMedia(media);
    if (!reel) throw new ReelPayloadError(shortcode);
    return reel;
  }

  /**
   * One request, and at most one. See this file's header, and the much longer
   * argument in `InstagramPollSource.request`, for why there is no retry here
   * and why a challenge is answered by stopping rather than by backing off.
   */
  private async request(
    pk: string,
    sessionId: string,
    csrfToken: string,
    dsUserId: string,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`https://www.instagram.com/api/v1/media/${pk}/info/`, {
        method: 'GET',
        headers: {
          // The credential. Three cookies, exactly as a browser would send them.
          Cookie: `sessionid=${sessionId}; csrftoken=${csrfToken}; ds_user_id=${dsUserId}`,
          // Without this the endpoint answers as if signed out. It is the header
          // that makes the request a web-client request rather than an anonymous one.
          'X-IG-App-ID': IG_WEB_APP_ID,
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://www.instagram.com/',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // No redirect-following into a login page: a 302 to /accounts/login/
        // followed automatically would return HTML that parses to no media and
        // look exactly like a deleted post.
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // A transport failure — DNS, TLS, the timeout above — is not a verdict on
      // the account, so it does not trip the breaker and it does not retry.
      throw new Error(`instagram media request failed: ${describe(e)}`);
    }

    // A redirect here is a signed-out response wearing a 302. Treated as a dead
    // session rather than as a transport hiccup, because that is what it is.
    if (res.status >= 300 && res.status < 400) await this.stop('http-redirect-to-login');

    const text = await res.text();
    const payload = safeJson(text);

    // THE SAME DETECTOR THE POLLER USES, on the same list of signals. 401, 429
    // and the challenge/checkpoint vocabulary mean Instagram has noticed this
    // traffic, and the account does not care which endpoint noticed it.
    const blocked = detectBlock(res.status, payload);
    if (blocked) await this.stop(blocked);

    // 400 is the ordinary answer for a shortcode that resolves to nothing this
    // session may see — verified against `Media not found or unavailable` and
    // `Invalid media_id`. It is NOT a block and must not trip the breaker, or a
    // user pasting a link to a deleted reel would stop ingestion for everyone.
    if (res.status === 400) return null;

    if (!res.ok) throw new Error(`instagram media returned ${res.status}`);

    // 200 with a body that is not JSON is almost always the login page or an
    // interstitial served as HTML. Nothing is parsed out of it and, critically,
    // it is not reported as a missing post.
    if (payload === null) throw new Error('instagram media returned a non-JSON body');

    return payload;
  }

  /** Trip, then throw. Never returns. */
  private async stop(reason: string): Promise<never> {
    // console.error, loudly and on purpose: this is the line a human needs to
    // see in the function logs. It names the source and the reason and nothing
    // else — no cookies, no headers, no response body.
    console.error(
      `[ingest] CIRCUIT BREAKER TRIPPED for ${INSTAGRAM_POLL_SOURCE} from a pasted link: ${reason}. ` +
        `Instagram requests are now refused. Clear the challenge in the Instagram app, capture a ` +
        `fresh IG_SESSION_ID, then reset ingest_state.breaker_tripped_at by hand.`,
    );
    await tripBreaker(INSTAGRAM_POLL_SOURCE, reason);
    throw new InboxBreakerTrippedError(reason);
  }
}

/** `items[0]`, defended. `null` from a 400 arrives here and falls straight through. */
function firstItem(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return null;
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? (items[0] ?? null) : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** An error's message, never the error — a thrown Response would serialise its body. */
function describe(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}
