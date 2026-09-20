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
 *   - `/pending_inbox/` — the message REQUEST folder, where a share from someone
 *     who does not follow the account lands, which is to say where EVERY new
 *     user's first share lands. This poller now probes for it on both hosts and
 *     accepts the threads it finds (`readPending`, `approveThread` below).
 *     Measured again on 2026-09-20 with the production session:
 *       www.instagram.com  → 404, an HTML "Page Not Found", on every path and
 *                            header variant tried. The web host does not route it.
 *       i.instagram.com    → 400 `{"status":"fail","content":{"status":"Prompt
 *                            has contribution","error_code":4415001}}` — and the
 *                            SAME 400 for `/inbox/`, which works fine on www. The
 *                            mobile host is rejecting a web session outright, not
 *                            rejecting this endpoint.
 *     So today neither host answers, and the code says so LOUDLY rather than
 *     reporting an empty folder: `pendingRead: 'unreachable'` in the pass summary,
 *     a console.error, and `pending_requests_total` off the ordinary inbox
 *     response as the cross-check that says whether anything was missed.
 *   - `/threads/{id}/` 500s, so there is no per-thread fallback and no way to
 *     re-read one thread after a partial parse. The inbox response is the only
 *     read.
 *
 * The replacement is the Meta Messaging API, which delivers the same payload by
 * webhook with no polling and no ban risk. It arrives as a second `InboxSource`
 * (lib/ingest/inbox/index.ts) and this file is then deleted, not adapted.
 */

import type { InboxClip, InboxSource, InboxSourceReport } from './index';
import {
  detectBlock,
  parseInboxClips,
  parsePendingRequestsTotal,
  parsePendingThreads,
} from './parse';
import { INSTAGRAM_POLL_SOURCE, claimAttempt, getIngestState, tripBreaker } from '../state';

/**
 * The two hosts that serve `/api/v1/direct_v2/`, and which one answers what.
 *
 * `www` is the web client's own origin and is where `/inbox/` works. `i` is the
 * mobile private API's origin, which the message-request folder is documented
 * (by everyone outside Meta) to live on. Both are probed for the pending folder
 * because neither is reliable and the answer is allowed to change under us; see
 * the measurements in this file's header for what each returned on 2026-09-20.
 */
const WEB_HOST = 'https://www.instagram.com';
const MOBILE_HOST = 'https://i.instagram.com';

const INBOX_URL = `${WEB_HOST}/api/v1/direct_v2/inbox/`;

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
 * The UA for `i.instagram.com`, which is the phone app's origin and answers a
 * browser UA with the same rejection it answers everything else. Sent ONLY to
 * that host: claiming to be an Android app while calling the web origin with a
 * web session cookie is a mismatch, and a mismatch is the thing the UA above
 * exists to avoid.
 */
const MOBILE_USER_AGENT =
  'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; ' +
  'o1s; exynos2100; en_US; 458229237)';

/**
 * Minimum gap between two polls, enforced against `ingest_state.last_attempt_at`
 * so it survives cold starts — an in-process timer resets on every new serverless
 * isolate, which is to say constantly.
 *
 * THE DEFAULT, not the rule. A caller may pass its own `minIntervalMs` to the
 * constructor, and the one that does — scripts/watch-inbox.ts — passes five
 * seconds. That is deliberately a visible argument at a call site rather than an
 * edit to this constant: the day someone wants a faster loop, the cost of it
 * should be written in their file, next to the loop, and not buried here where
 * the cron would inherit it too.
 *
 * Fifteen minutes is a deliberate under-use of what the endpoint would tolerate.
 * The thing being optimised is not freshness; a reel that lands in Gaja twelve
 * minutes after it was shared is indistinguishable, to the person who shared it,
 * from one that lands in one minute. The thing being optimised is the account's
 * survival, and every request is a draw against it.
 */
export const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The floor below which no caller may set the floor.
 *
 * `minIntervalMs` is configurable because a local watcher needs a shorter loop
 * than a cron does, and a constant that has to be edited to be changed is a
 * constant that gets edited to zero. It is not configurable to NOTHING: a floor
 * of 0 is not a faster poller, it is a `while (true)` against an undocumented
 * endpoint on somebody's real account, and that is a decision no call site gets
 * to make by passing a number. One second is still far more aggressive than
 * anything that should run unattended — see the header of scripts/watch-inbox.ts.
 */
export const HARD_MIN_INTERVAL_MS = 1_000;

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

/**
 * Jitter scaled to the interval it is jittering.
 *
 * Subtracting up to two minutes from a five-second floor leaves a negative
 * number, which is not a jittered floor — it is no floor at all, and the
 * configurability above would have quietly deleted the thing it was meant to
 * make adjustable. Both amounts are therefore capped at a fraction of the
 * interval: a quarter off the floor, an eighth as delay. At fifteen minutes both
 * caps are far above the constants and the behaviour is exactly what it was.
 */
function scaledJitter(minIntervalMs: number): { floorMs: number; delayMs: number } {
  return {
    floorMs: Math.min(JITTER_FLOOR_MS, Math.floor(minIntervalMs / 4)),
    delayMs: Math.min(JITTER_DELAY_MS, Math.floor(minIntervalMs / 8)),
  };
}

/** Nothing hangs forever. An unbounded fetch holds a function until the platform kills it. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The most message requests one pass will accept.
 *
 * APPROVING IS A WRITE TO SOMEBODY'S ACCOUNT, and it is the only write this
 * poller makes. A bug that approved in a loop would not merely waste requests —
 * it would accept every stranger's message request on a real person's Instagram
 * account, which is not undoable from here. Five is more than a real pass needs
 * and small enough that a runaway is bounded at five.
 */
const MAX_APPROVALS_PER_PASS = 5;

/** A pause between approvals, so five accepts are not one burst. */
const APPROVE_GAP_MS = 700;

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
 * A required environment variable is not set, so no request was attempted.
 *
 * A CLASS AND NOT A BARE `Error`, because the callers need to tell this apart
 * from everything else and none of them can do it by reading a message. A
 * missing `IG_SESSION_ID` is a deployment fact, not a runtime failure: the route
 * turns it into a documented problem response, and scripts/watch-inbox.ts prints
 * one line naming the variable and stops, rather than printing a stack trace and
 * looping on it every five seconds forever.
 *
 * `variable` is the NAME. The value is never read into this error, never logged
 * and never returned — `sessionid` is a bearer credential for the whole
 * Instagram account, and an error message is the single most likely place a
 * secret escapes, because it is the one string that gets logged, forwarded to an
 * error tracker and pasted into a chat.
 */
export class InboxNotConfiguredError extends Error {
  constructor(readonly variable: string) {
    super(`${variable} is not set; the Instagram inbox poller cannot run.`);
    this.name = 'InboxNotConfiguredError';
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
  if (!value) throw new InboxNotConfiguredError(name);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type InstagramPollOptions = {
  /**
   * The floor between two polls, in milliseconds. Defaults to
   * `DEFAULT_MIN_INTERVAL_MS` (fifteen minutes) and is clamped up to
   * `HARD_MIN_INTERVAL_MS`.
   *
   * Pass it explicitly or not at all. A call site that wants a shorter loop is
   * making a decision about somebody's Instagram account, and the number should
   * be legible where that decision is taken.
   */
  minIntervalMs?: number;
};

/**
 * Everything one pass did besides producing clips, reset at the top of every
 * `fetchNewClips` so a stale report can never be read as a fresh one.
 */
type Credentials = { sessionId: string; csrfToken: string; dsUserId: string };

/** One HTTP answer, already checked against the breaker rules. */
type Answer = { status: number; payload: unknown };

/**
 * Thrown when the message-request folder could not be read on ANY host.
 *
 * A CLASS AND NOT AN EMPTY ARRAY. Returning `[]` from a pending read that never
 * happened is the exact bug this whole change exists to fix: "no message
 * requests" and "the message-request endpoint would not answer" are the same
 * empty array, and the second one silently drops every new user. It is caught by
 * `fetchNewClips` — a pending folder that cannot be read must not cost us the
 * ordinary inbox, which is working — and it is what puts
 * `pendingRead: 'unreachable'` and a reason into the pass summary.
 */
export class PendingInboxUnreachableError extends Error {
  constructor(readonly reason: string) {
    super(`instagram pending inbox unreachable: ${reason}`);
    this.name = 'PendingInboxUnreachableError';
  }
}

export class InstagramPollSource implements InboxSource {
  private readonly minIntervalMs: number;
  private report: InboxSourceReport | null = null;

  constructor(options: InstagramPollOptions = {}) {
    // Clamped, not validated-and-thrown: a caller that passed 0 meant "as fast as
    // possible", and the honest answer to that is the fastest this source is
    // willing to go, not a crash three layers down inside a loop.
    this.minIntervalMs = Math.max(
      HARD_MIN_INTERVAL_MS,
      options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    );
  }

  /** What the last `fetchNewClips` did beyond returning clips. See `InboxSourceReport`. */
  lastReport(): InboxSourceReport | null {
    return this.report;
  }

  /**
   * `since` comes from the caller's cursor rather than from state read here, so
   * the route stays the one place that decides what has been processed. This
   * method still reads `ingest_state` for the breaker and the interval floor:
   * those are the source's own safety limits and must hold no matter who calls
   * it or what they pass.
   *
   * ONE ATTEMPT IS NOT ONE REQUEST, and it never was — the floor below buys a
   * pass, not a packet. A pass is now the inbox read, one probe per host for the
   * message-request folder, and up to `MAX_APPROVALS_PER_PASS` accepts. That is
   * a handful of requests where it used to be one, and it is the price of seeing
   * a new sender at all; the floor is what keeps the handful from becoming a
   * stream.
   */
  async fetchNewClips(since: Date | null): Promise<InboxClip[]> {
    const creds = readCredentials();

    const state = await getIngestState(INSTAGRAM_POLL_SOURCE);

    // CHECKED AGAIN HERE, even though the route checks it before calling. The
    // breaker is the one control protecting a real person's real account, and a
    // guard that lives only in the caller is a guard that a second caller —
    // a script, a test, next month's backfill job — does not have.
    if (state.breakerTrippedAt) {
      throw new InboxBreakerTrippedError(state.breakerReason ?? 'unknown');
    }

    // THE FLOOR AND THE SINGLE-FLIGHT, IN ONE STATEMENT. `claimAttempt` both
    // tests `last_attempt_at` and moves it, so two invocations that arrive
    // together cannot both be admitted — see lib/ingest/state.ts for why that
    // used to be a read followed by a write and why that stopped being good
    // enough. The attempt is spent before the request leaves, so a pass that
    // dies mid-flight has still spent it.
    const jitter = scaledJitter(this.minIntervalMs);
    const floor = this.minIntervalMs - Math.floor(Math.random() * jitter.floorMs);
    if (!(await claimAttempt(INSTAGRAM_POLL_SOURCE, floor))) {
      throw new InboxPollTooSoonError(new Date(Date.now() + floor));
    }

    await sleep(Math.floor(Math.random() * jitter.delayMs));

    // Reset before anything can throw, so `lastReport()` can never hand a caller
    // the previous pass's numbers as if they were this one's.
    this.report = {
      pendingRead: 'skipped',
      pendingReason: null,
      pendingThreadsSeen: 0,
      pendingThreadsApproved: 0,
      pendingRequestsTotal: null,
    };

    // ── The ordinary inbox, first ──────────────────────────────────────────
    // FIRST ON PURPOSE. It is the path that works today, and it must not be
    // hostage to the one that does not: a pending probe that hangs, 404s or
    // throws has to find the accepted threads' clips already in hand.
    const inboxPayload = await this.request(creds);
    const clips = parseInboxClips(inboxPayload, { selfUserId: creds.dsUserId, since });

    // Instagram's own count of waiting requests, free on the read we just made.
    // It is what makes an unreadable request folder a statement rather than a
    // silence — see `InboxSourceReport.pendingRequestsTotal`.
    this.report.pendingRequestsTotal = parsePendingRequestsTotal(inboxPayload);

    // ── The message-request folder ─────────────────────────────────────────
    const pendingClips = await this.drainPending(creds);

    // Deduped because an approval takes effect immediately: a thread accepted
    // this pass can appear in BOTH reads, and the merge is what stops one share
    // being walked through the pipeline twice in one pass. `ingestClip` would
    // survive it — `unique (user_id, reel_video_id)` — but it would spend a
    // video download and a model call to learn that.
    const seen = new Set(clips.map((c) => `${c.igsid}:${c.reelVideoId}`));
    for (const clip of pendingClips) {
      const key = `${clip.igsid}:${clip.reelVideoId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clips.push(clip);
    }

    // Oldest first over the MERGED list. A message request may have been sitting
    // unread for days, so a pending clip is routinely older than everything in
    // the inbox; sorting here is what keeps `runIngestPass`'s cursor walking
    // forwards through the batch instead of jumping back and forth.
    clips.sort((a, b) => a.sharedAt.getTime() - b.sharedAt.getTime());
    return clips;
  }

  /**
   * Read the message-request folder, accept the threads that carry reels, and
   * return those reels.
   *
   * NEVER THROWS FOR ITS OWN FAILURE, and always throws for the account's. The
   * distinction is the whole function: a 404 from a folder Instagram may simply
   * not route on this host is OUR problem and costs this pass its message
   * requests, while a 401, a 429 or a challenge is INSTAGRAM'S verdict on the
   * account and must stop everything exactly as it does on the inbox read. So
   * `InboxBreakerTrippedError` and `InboxNotConfiguredError` propagate and
   * everything else is recorded in the report.
   *
   * `since` IS DELIBERATELY NOT APPLIED to what comes back. The cursor is a
   * high-water mark over clips we could already SEE, and nothing in this folder
   * was ever visible to a pass before this one. A message request sent at 10:00
   * while the cursor sat at 10:05 — because some accepted thread had a newer
   * share — would be filtered out by `since` and never seen again. That is the
   * silent drop this change exists to end, so the pending read takes everything
   * and lets `unique (user_id, reel_video_id)` absorb the repeats.
   */
  private async drainPending(creds: Credentials): Promise<InboxClip[]> {
    const report = this.report;
    if (!report) return [];

    let host: string;
    let payload: unknown;
    try {
      const found = await this.readPending(creds);
      host = found.host;
      payload = found.payload;
    } catch (e) {
      if (e instanceof InboxBreakerTrippedError || e instanceof InboxNotConfiguredError) throw e;
      const reason = e instanceof PendingInboxUnreachableError ? e.reason : describe(e);
      report.pendingRead = 'unreachable';
      report.pendingReason = reason;

      // LOUD, and with the cross-check in the same line, because this is the
      // sentence someone has to be able to find in the function logs when a
      // tester says "I sent it and nothing happened". `pending_requests_total`
      // is Instagram's own badge count: above zero here means somebody IS
      // waiting in a folder we cannot open.
      const waiting = report.pendingRequestsTotal;
      console.error(
        `[ingest] message requests could not be read (${reason}). ` +
          `Instagram reports ${waiting === null ? 'an unknown number of' : waiting} waiting ` +
          `request(s). A reel from anyone who does not follow @${process.env.IG_INBOX_HANDLE ?? 'the inbox account'} ` +
          `lands there, so those senders are invisible to this pass until a human ` +
          `accepts the request in the Instagram app.`,
      );
      return [];
    }

    report.pendingRead = 'ok';

    const threads = parsePendingThreads(payload, { selfUserId: creds.dsUserId, since: null });
    report.pendingThreadsSeen = threads.length;

    const out: InboxClip[] = [];
    let approvals = 0;

    for (const thread of threads) {
      // ONLY THREADS WE ARE ABOUT TO INGEST FROM. Accepting a message request is
      // a write to a real person's account and is not undoable from here, so a
      // thread whose items are text, a photo or a "started following you" notice
      // is counted and left exactly where it is. It is seen, not accepted.
      if (thread.clips.length === 0) continue;
      if (approvals >= MAX_APPROVALS_PER_PASS) break;

      if (approvals > 0) await sleep(APPROVE_GAP_MS);
      const accepted = await this.approveThread(creds, host, thread.threadId);
      if (!accepted) continue;

      approvals++;
      out.push(...thread.clips);
    }

    report.pendingThreadsApproved = approvals;
    return out;
  }

  /**
   * The message-request folder, from whichever host will serve it.
   *
   * PROBES BOTH AND ACCEPTS ONLY JSON. A 404 here is an HTML "Page Not Found"
   * page, and a source that took `res.ok === false` as its only test would be
   * one `safeJson` away from parsing a login interstitial into an empty folder
   * and reporting zero message requests forever.
   *
   * Throws `PendingInboxUnreachableError` naming what every host did. The reason
   * string is a short tag plus status codes — never a response body, which on
   * this endpoint is somebody's private conversation.
   */
  private async readPending(creds: Credentials): Promise<{ host: string; payload: unknown }> {
    const failures: string[] = [];

    // THREE CANDIDATES, IN ORDER OF HOW SPECIFIC THEY ARE — the third is the one
    // that actually answers today.
    //
    //   1. www  /pending_inbox/   the documented path. Hard 404s, an HTML
    //                             "Page Not Found", every spelling and query.
    //   2. i.   /pending_inbox/   400 `Prompt has contribution` (4415001). NOT a
    //                             header or path problem: /inbox/, a path that
    //                             unquestionably exists and 200s on www with
    //                             these same cookies, returns the byte-identical
    //                             400 on this host. i.instagram.com is the phone
    //                             app's origin and wants a device-bound session
    //                             with signed device headers; a browser
    //                             `sessionid` is not accepted there at all. No
    //                             header will fix it — do not re-probe it.
    //   3. www  /inbox/?folder=1  200 application/json, with the same
    //                             `inbox.threads` shape the main folder returns,
    //                             so it parses with no special case.
    //
    // Candidate 3 is UNPROVEN as *the request folder* rather than merely a
    // different one: every time it has been read, `pending_requests_total` was 0
    // and it returned zero threads, which is consistent with both readings. It
    // is tried anyway because it cannot do worse — a wrong folder yields zero
    // threads, which is exactly what `unreachable` already yields, while a right
    // one ends the silent drop. `pendingRequestsTotal` is the check that settles
    // it: a pass reporting a non-zero total beside zero threads means this is the
    // wrong folder and says so in the summary, rather than looking like calm.
    const candidates: URL[] = [];
    for (const host of [WEB_HOST, MOBILE_HOST]) {
      const u = new URL(`${host}/api/v1/direct_v2/pending_inbox/`);
      u.searchParams.set('limit', '20');
      u.searchParams.set('thread_message_limit', '20');
      candidates.push(u);
    }
    const folder = new URL(`${WEB_HOST}/api/v1/direct_v2/inbox/`);
    folder.searchParams.set('folder', '1');
    folder.searchParams.set('limit', '20');
    folder.searchParams.set('thread_message_limit', '20');
    candidates.push(folder);

    for (const url of candidates) {
      const host = url.origin;

      let answer: Answer;
      try {
        answer = await this.call(creds, { url, host, method: 'GET' });
      } catch (e) {
        if (e instanceof InboxBreakerTrippedError) throw e;
        failures.push(`${hostLabel(host)}=${describe(e)}`);
        continue;
      }

      // JSON, 2xx, and an `inbox` in it. All three, because this host family
      // answers a wrong path with a 200-shaped HTML page often enough that any
      // one of them alone has been wrong before.
      if (answer.status >= 200 && answer.status < 300 && answer.payload !== null) {
        return { host, payload: answer.payload };
      }
      failures.push(
        `${hostLabel(host)}${url.pathname.includes('pending_inbox') ? '' : '?folder=1'}` +
          `=${answer.status}${answer.payload === null ? ' non-json' : ''}`,
      );
    }

    throw new PendingInboxUnreachableError(failures.join(' '));
  }

  /**
   * Accept one message request, so its reels can be ingested.
   *
   * THE ONLY WRITE THIS FILE MAKES. It is called for a thread that has already
   * been read and found to contain a reel, never speculatively and never in a
   * loop past `MAX_APPROVALS_PER_PASS`.
   *
   * Returns false rather than throwing on an ordinary refusal: one thread that
   * will not accept must not cost the others, and its clips are simply not
   * returned — they stay behind the request wall and will be offered again next
   * pass. A challenge or a 429 still goes through `call` and still trips the
   * breaker, because that is Instagram talking about the account and not about
   * this thread.
   */
  private async approveThread(
    creds: Credentials,
    host: string,
    threadId: string,
  ): Promise<boolean> {
    const url = new URL(`${host}/api/v1/direct_v2/threads/${encodeURIComponent(threadId)}/approve/`);
    try {
      const answer = await this.call(creds, { url, host, method: 'POST', body: '' });
      if (answer.status >= 200 && answer.status < 300) return true;
      // The id is Instagram's, not a person's writing, and the status is ours.
      // Neither is a caption and neither is a cookie.
      console.error(`[ingest] approving a message request returned ${answer.status}`);
      return false;
    } catch (e) {
      if (e instanceof InboxBreakerTrippedError) throw e;
      console.error(`[ingest] approving a message request failed: ${describe(e)}`);
      return false;
    }
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
   * expiry (see lib/ingest/state.ts).
   *
   * SHARED BY ALL THREE CALLS — the inbox, the message-request folder and the
   * approve — so that the breaker cannot be reached around. A second fetch
   * written next to this one would be a second request that does not trip it,
   * which is the only way this safety net gets a hole in it.
   */
  private async call(
    creds: Credentials,
    opts: { url: URL; host: string; method: 'GET' | 'POST'; body?: string },
  ): Promise<Answer> {
    const mobile = opts.host === MOBILE_HOST;
    const headers: Record<string, string> = {
      // The credential. Three cookies, exactly as a browser would send them.
      Cookie: `sessionid=${creds.sessionId}; csrftoken=${creds.csrfToken}; ds_user_id=${creds.dsUserId}`,
      // Without this the endpoint answers as if signed out. It is the header
      // that makes the request a web-client request rather than an anonymous one.
      'X-IG-App-ID': IG_WEB_APP_ID,
      'X-CSRFToken': creds.csrfToken,
      'User-Agent': mobile ? MOBILE_USER_AGENT : USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (!mobile) {
      headers['X-Requested-With'] = 'XMLHttpRequest';
      // The page a browser would be on when it makes this call. A missing or
      // wrong Referer on an endpoint that is only ever called from
      // /direct/inbox/ is a mismatch worth not creating.
      headers.Referer = `${WEB_HOST}/direct/inbox/`;
    }
    if (opts.method === 'POST') {
      // A browser sends both on a same-origin form post, and the CSRF token is
      // checked against the Origin on write endpoints.
      headers.Origin = opts.host;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let res: Response;
    try {
      res = await fetch(opts.url, {
        method: opts.method,
        headers,
        body: opts.method === 'POST' ? (opts.body ?? '') : undefined,
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
      // the next pass is the retry.
      throw new Error(`instagram request failed: ${describe(e)}`);
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

    return { status: res.status, payload };
  }

  /**
   * The inbox read, on the terms it has always had: a non-2xx or a non-JSON body
   * is an error and never an empty inbox.
   *
   * Kept separate from `call` because the two disagree about what a bad status
   * means. On the inbox, a 404 or an HTML body is a broken pipeline and must
   * throw; on the message-request probe it is the expected answer from a host
   * that does not route the path, and throwing there would take the working half
   * of the pass down with the half that has never worked.
   */
  private async request(creds: Credentials): Promise<unknown> {
    const url = new URL(INBOX_URL);
    // The parameters the web client sends. `thread_message_limit` is what makes
    // the captions arrive in this one response instead of needing a fetch per
    // thread — which matters doubly because `/threads/{id}/` 500s and there is
    // no per-thread fallback to fall back to.
    url.searchParams.set('visual_message_return_type', 'unseen');
    url.searchParams.set('persistentBadging', 'true');
    url.searchParams.set('limit', '20');
    url.searchParams.set('thread_message_limit', '20');

    const answer = await this.call(creds, { url, host: WEB_HOST, method: 'GET' });

    if (answer.status < 200 || answer.status >= 300) {
      // Everything that is not 2xx and was not a block: recorded and thrown,
      // breaker untouched. A 500 from Instagram is Instagram's problem and says
      // nothing about us.
      throw new Error(`instagram inbox returned ${answer.status}`);
    }

    if (answer.payload === null) {
      // 200 with a body that is not JSON is almost always the login page or an
      // interstitial served as HTML. Nothing is parsed out of it and, critically,
      // it is not reported as an empty inbox.
      throw new Error('instagram inbox returned a non-JSON body');
    }

    return answer.payload;
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

/** Which host, for a log line. Never a URL with a thread id in it. */
function hostLabel(host: string): string {
  return host === MOBILE_HOST ? 'i.instagram.com' : 'www.instagram.com';
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
