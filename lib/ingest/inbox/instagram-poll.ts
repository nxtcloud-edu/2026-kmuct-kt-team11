/**
 * `InstagramPollSource` — reads shared reels out of a logged-in Instagram
 * account's DM inbox, server side, with that account's own session cookies.
 *
 * This is not a supported interface. It is `GET /api/v1/direct_v2/inbox/`, the
 * endpoint the instagram.com web client calls, and Instagram owes us nothing
 * about it. docs/gaja/reel-extraction-findings.md records what was actually
 * observed on 2026-09-20 and this file is built to that, not to what a direct-
 * messaging API ought to offer:
 *
 *   - `/inbox/` returns thread items WITH the full caption. That is the whole
 *     reason polling is viable at all — no second fetch per reel, no media
 *     endpoint, no OCR.
 *   - `/pending_inbox/` 404s on the web host, so message requests are not
 *     reachable here. A share from someone who does not follow the account lands
 *     there and this poller will never see it until a human accepts the request
 *     in the app. That is a product gap, not a bug to code around.
 *   - `/threads/{id}/` 500s, so there is no per-thread fallback and no way to
 *     re-read one thread after a partial parse. The inbox response is the only
 *     read.
 *
 * The replacement is the Meta Messaging API, which delivers the same payload by
 * webhook with no polling and no ban risk. It arrives as a second `InboxSource`
 * (lib/ingest/inbox/index.ts) and this file is then deleted, not adapted.
 */

import type { InboxClip, InboxSource } from './index';
import { detectBlock, parseInboxClips } from './parse';
import { INSTAGRAM_POLL_SOURCE, getIngestState, markAttempt, tripBreaker } from '../state';

const INBOX_URL = 'https://www.instagram.com/api/v1/direct_v2/inbox/';

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

/**
 * Minimum gap between two polls, enforced against `ingest_state.last_attempt_at`
 * so it survives cold starts — an in-process timer resets on every new serverless
 * isolate, which is to say constantly.
 *
 * Fifteen minutes is a deliberate under-use of what the endpoint would tolerate.
 * The thing being optimised is not freshness; a reel that lands in Gaja twelve
 * minutes after it was shared is indistinguishable, to the person who shared it,
 * from one that lands in one minute. The thing being optimised is the account's
 * survival, and every request is a draw against it.
 */
const MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Up to two minutes shaved off the floor, and up to eight seconds of delay before
 * the request goes out.
 *
 * A poller that fires at :00, :15, :30, :45 every hour of every day is a
 * metronome, and a metronome is what automation looks like from the other side.
 * The subtraction keeps a fixed cron from being quantised into an exact cadence
 * by the floor itself; the sleep keeps two consecutive passes from landing the
 * same number of milliseconds after their trigger.
 */
const JITTER_FLOOR_MS = 2 * 60 * 1000;
const JITTER_DELAY_MS = 8 * 1000;

/** Nothing hangs forever. An unbounded fetch holds a function until the platform kills it. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The breaker is already tripped, or was tripped by this call. Either way the
 * source did not run and no cursor may move.
 */
export class InboxBreakerTrippedError extends Error {
  constructor(readonly reason: string) {
    super(`instagram poll refused: breaker tripped (${reason})`);
    this.name = 'InboxBreakerTrippedError';
  }
}

/** Called again inside the minimum interval. Not a failure; nothing was attempted. */
export class InboxPollTooSoonError extends Error {
  constructor(readonly nextAllowedAt: Date) {
    super(`instagram poll skipped: next attempt allowed at ${nextAllowedAt.toISOString()}`);
    this.name = 'InboxPollTooSoonError';
  }
}

/**
 * The three cookies that make the request a logged-in one.
 *
 * ALL THREE ARE SECRETS. `sessionid` in particular is a bearer credential for the
 * entire Instagram account — not scoped, not read-only, not revocable per use.
 * Anyone holding it is the account. Therefore:
 *   - never `NEXT_PUBLIC_`, which would compile them into the browser bundle;
 *   - never logged, including inside an error message, which is why the throw
 *     below names the variable and never touches its value;
 *   - never returned in a response body, which is why the route returns counts.
 */
function readCredentials(): { sessionId: string; csrfToken: string; dsUserId: string } {
  const sessionId = required('IG_SESSION_ID');
  const csrfToken = required('IG_CSRF_TOKEN');
  const dsUserId = required('IG_DS_USER_ID');
  return { sessionId, csrfToken, dsUserId };
}

function required(name: string): string {
  const value = process.env[name];
  // Names the variable, never the value — an error message is the most likely
  // place a secret escapes, because it is the one string that gets logged,
  // forwarded to an error tracker and pasted into a chat.
  if (!value) throw new Error(`${name} is not set; the Instagram inbox poller cannot run.`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InstagramPollSource implements InboxSource {
  /**
   * `since` comes from the caller's cursor rather than from state read here, so
   * the route stays the one place that decides what has been processed. This
   * method still reads `ingest_state` for the breaker and the interval floor:
   * those are the source's own safety limits and must hold no matter who calls
   * it or what they pass.
   */
  async fetchNewClips(since: Date | null): Promise<InboxClip[]> {
    const { sessionId, csrfToken, dsUserId } = readCredentials();

    const state = await getIngestState(INSTAGRAM_POLL_SOURCE);

    // CHECKED AGAIN HERE, even though the route checks it before calling. The
    // breaker is the one control protecting a real person's real account, and a
    // guard that lives only in the caller is a guard that a second caller —
    // a script, a test, next month's backfill job — does not have.
    if (state.breakerTrippedAt) {
      throw new InboxBreakerTrippedError(state.breakerReason ?? 'unknown');
    }

    const floor = MIN_INTERVAL_MS - Math.floor(Math.random() * JITTER_FLOOR_MS);
    if (state.lastAttemptAt) {
      const nextAllowed = new Date(state.lastAttemptAt.getTime() + floor);
      if (nextAllowed.getTime() > Date.now()) throw new InboxPollTooSoonError(nextAllowed);
    }

    // Before the request, so a pass that dies mid-flight has still spent its
    // budget. See markAttempt's comment.
    await markAttempt(INSTAGRAM_POLL_SOURCE);
    await sleep(Math.floor(Math.random() * JITTER_DELAY_MS));

    const payload = await this.request(sessionId, csrfToken, dsUserId);
    return parseInboxClips(payload, { selfUserId: dsUserId, since });
  }

  /**
   * One request, and at most one.
   *
   * THERE IS NO RETRY IN THIS FUNCTION AND NONE MAY BE ADDED. Not a retry on
   * 429, not an exponential backoff, not a "just one more attempt" on a
   * challenge. The reasoning, written down so that a future reader who finds
   * this fragile does not fix it:
   *
   * The account on the other end is the user's real production Instagram
   * account, with their real followers and their real DMs. 401, 429,
   * `challenge_required` and `checkpoint_required` are not transport errors that
   * a second attempt might get past. They are Instagram saying it has noticed
   * this traffic. A poller that answers that by backing off and trying again is
   * still polling — it has only made itself slower to detect, while every
   * request continues to accumulate against an account already flagged. Retrying
   * into a challenge is, specifically, how an account gets banned.
   *
   * So the response is to stop completely, write down why, and refuse to poll
   * again until a person has opened Instagram, cleared whatever is waiting, and
   * cleared `breaker_tripped_at` by hand. There is no automatic reset and no
   * expiry (see lib/ingest/state.ts). Losing a few hours of reel ingestion is
   * recoverable; losing the account is not.
   */
  private async request(sessionId: string, csrfToken: string, dsUserId: string): Promise<unknown> {
    const url = new URL(INBOX_URL);
    // The parameters the web client sends. `thread_message_limit` is what makes
    // the captions arrive in this one response instead of needing a fetch per
    // thread — which matters doubly because `/threads/{id}/` 500s and there is
    // no per-thread fallback to fall back to.
    url.searchParams.set('visual_message_return_type', 'unseen');
    url.searchParams.set('persistentBadging', 'true');
    url.searchParams.set('limit', '20');
    url.searchParams.set('thread_message_limit', '20');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          // The credential. Three cookies, exactly as a browser would send them.
          Cookie: `sessionid=${sessionId}; csrftoken=${csrfToken}; ds_user_id=${dsUserId}`,
          // Without this the endpoint answers as if signed out. It is the header
          // that makes the request a web-client request rather than an anonymous one.
          'X-IG-App-ID': IG_WEB_APP_ID,
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          // The page a browser would be on when it makes this call. A missing or
          // wrong Referer on an endpoint that is only ever called from
          // /direct/inbox/ is a mismatch worth not creating.
          Referer: 'https://www.instagram.com/direct/inbox/',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // No cookie jar, no redirect-following into a login page: a 302 to
        // /accounts/login/ followed automatically would return HTML that parses
        // to zero clips and look exactly like a quiet inbox.
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // A transport failure — DNS, TLS, the timeout above — is not a verdict on
      // the account, so it does not trip the breaker. It also does not retry:
      // the next cron tick is the retry, fifteen minutes from now.
      throw new Error(`instagram inbox request failed: ${describe(e)}`);
    }

    // A redirect here is a signed-out response wearing a 302. Treated as a dead
    // session rather than as a transport hiccup, because that is what it is.
    if (res.status >= 300 && res.status < 400) {
      await this.stop('http-redirect-to-login');
    }

    const text = await res.text();
    const payload = safeJson(text);

    const blocked = detectBlock(res.status, payload);
    if (blocked) await this.stop(blocked);

    if (!res.ok) {
      // Everything else that is not 2xx: recorded and thrown, breaker untouched.
      // A 500 from Instagram is Instagram's problem and says nothing about us.
      throw new Error(`instagram inbox returned ${res.status}`);
    }

    if (payload === null) {
      // 200 with a body that is not JSON is almost always the login page or an
      // interstitial served as HTML. Nothing is parsed out of it and, critically,
      // it is not reported as an empty inbox.
      throw new Error('instagram inbox returned a non-JSON body');
    }

    return payload;
  }

  /** Trip, then throw. Never returns. */
  private async stop(reason: string): Promise<never> {
    // console.error, loudly and on purpose: this is the line a human needs to see
    // in the function logs. It names the source and the reason and nothing else —
    // no cookies, no headers, no response body, all three of which would carry
    // the session credential or a stranger's DM into a log aggregator.
    console.error(
      `[ingest] CIRCUIT BREAKER TRIPPED for ${INSTAGRAM_POLL_SOURCE}: ${reason}. ` +
        `Polling is now refused. Clear the challenge in the Instagram app, capture a ` +
        `fresh IG_SESSION_ID, then reset ingest_state.breaker_tripped_at by hand.`,
    );
    await tripBreaker(INSTAGRAM_POLL_SOURCE, reason);
    throw new InboxBreakerTrippedError(reason);
  }
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
