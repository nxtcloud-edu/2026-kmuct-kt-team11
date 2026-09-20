import { z } from 'zod';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { ingestClip } from '@/lib/ingest/ingest-clip';
import {
  InboxBreakerTrippedError,
  InboxNotConfiguredError,
} from '@/lib/ingest/inbox/instagram-poll';
import {
  InstagramMediaSource,
  NotAReelError,
  ReelPayloadError,
  ReelUnavailableError,
} from '@/lib/ingest/paste/instagram-media';
import { parseReelUrl } from '@/lib/ingest/paste/url';

/**
 * `POST /api/reels` — save a reel the user pasted the link of.
 *
 * THE SECOND WAY IN, not a second pipeline. A reel DM'd to @dategaja.official
 * and a reel pasted here take the same five stages in the same order; stages 3
 * to 5 are `ingestClip` (lib/ingest/ingest-clip.ts), shared verbatim with the
 * poller. What is different is only stage 2 — whose reel is this — and the
 * difference is that on this path the question is already answered.
 *
 * `requireUser()` IS THE ROUTING. The poller has to turn an `igsid` on a DM into
 * an account, which is proof Meta signed and which almost no account has (see
 * docs/gaja/instagram-binding.md). Here the person is holding a `__Host-` session
 * cookie, which is stronger proof than the DM path will ever have, and no igsid
 * is read, written or invented. That is the whole reason this route exists: the
 * DM path cannot route to most users today, and this one always can.
 *
 * THE CREDENTIALS DO NOT MOVE. The url comes from the client. The fetch does
 * not: `InstagramMediaSource` reads `IG_SESSION_ID` server-side and nothing it
 * returns — not a payload, not an error, not a log line — carries a cookie
 * outward. The response below is counts and one uuid.
 *
 * IDEMPOTENT BY CONSTRUCTION, with no `Idempotency-Key`. `saveReel` is unique on
 * `(user_id, reel_video_id)`, so pasting the same link twice reports
 * `already_saved: true` and writes nothing — the second paste is an ack, not an
 * error and not a duplicate. That is a stronger guarantee than a key, because it
 * also covers the same reel pasted a week later from a different device, and it
 * is why this route does not take one.
 *
 * WHAT IT DOES NOT DO: rate-limit per user. The circuit breaker protects the
 * Instagram ACCOUNT — a challenge stops every Instagram request in the app until
 * a human clears it — but nothing here stops one signed-in user from spending
 * the account's request budget up to that point. That is a real gap and a
 * deliberate one to leave visible rather than to half-solve with a number nobody
 * chose.
 */

// One Instagram request, then a video download, a model call and ~10 sequential
// geocodes — the same work one clip costs the poller, which sets 60 for a whole
// pass of up to twenty. A paste that needs longer than this is a reel with more
// venues than a person pasted on purpose.
export const maxDuration = 60;

// Writes to Postgres on every call.
export const dynamic = 'force-dynamic';

/**
 * 2,048 characters is far more than any Instagram permalink and is the point at
 * which a "url" stops being one. `parseReelUrl` refuses anything unparseable
 * anyway; this bound is so an unbounded string never reaches a `new URL` or a
 * BigInt loop.
 */
const Body = z.object({
  url: z.string().min(1, '링크를 입력해 주세요.').max(2048),
});

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());

  // Parsed BEFORE anything is fetched, and a refusal costs Instagram nothing.
  // The browser runs the same parser on the same string as it is typed, so by
  // the time a request is made this has almost always already passed — this is
  // the backstop for a client that did not, not the first line of defence.
  const parsed = parseReelUrl(body.url);
  if (!parsed.ok) {
    throw new ProblemError('reel-url-invalid', {
      detail:
        parsed.reason === 'not-instagram'
          ? '인스타그램 주소가 아니에요. 릴스에서 공유 › 링크 복사를 눌러 나온 주소를 붙여넣어 주세요.'
          : '게시물 주소가 아니에요. 프로필이나 스토리 말고, 릴스를 열어서 링크 복사를 눌러 주세요.',
    });
  }

  let outcome;
  try {
    const clip = await new InstagramMediaSource().fetchByShortcode(parsed.shortcode);
    // The same claim, ladder, geocode, transaction and cover frame the poller
    // runs. `user.id` is the session's, so there is nothing here that could file
    // one person's reel under another's.
    outcome = await ingestClip(user.id, clip);
  } catch (e) {
    throw asProblem(e);
  }

  return json({
    reel_id: outcome.reelId,
    // A second paste of the same link. Not an error: the reel is saved, and the
    // client's job is to say so and point at it rather than to show a failure.
    already_saved: outcome.alreadySaved,
    // Venues the extractor NAMED, and of those the ones that became a place the
    // user can open. Both, because they are different facts and the gap between
    // them is the honest answer when a caption names ten cafés and only seven
    // have an address that geocodes. A single number would have to pick one and
    // would be wrong about the other.
    places_found: outcome.extracted,
    places_saved: outcome.resolved,
  });
});

/**
 * The named failures of the source, onto the documented problem catalogue.
 *
 * Every branch here is a case the user is told something specific about, which
 * is the whole reason the source throws classes instead of strings. Anything not
 * listed falls through to `withRoute`'s 500 — correctly, because an unrecognised
 * failure is one nobody has written copy for yet, and inventing a reassuring
 * message for it is how a broken pipeline looks healthy.
 */
function asProblem(e: unknown): unknown {
  // A dead or challenged session. THE OPERATOR'S PROBLEM, and the copy in
  // lib/problem.ts is written so the reader does not go looking for a fault in
  // their own account. The reason tag is NOT put in the detail: `detectBlock`
  // writes short tags like `http-429-rate-limited`, and a user cannot act on one
  // — it belongs in the function logs, where `stop()` already wrote it.
  if (e instanceof InboxBreakerTrippedError) return new ProblemError('ingest-session-expired');

  // A missing environment variable is a deployment fact, not a runtime failure.
  // The detail names the VARIABLE and never its value; `IG_SESSION_ID` is a
  // bearer credential for an entire Instagram account.
  if (e instanceof InboxNotConfiguredError) {
    return new ProblemError('ingest-not-configured', {
      detail: `릴스 수집에 필요한 환경 변수 ${e.variable}가 설정되지 않았어요.`,
    });
  }

  if (e instanceof NotAReelError) return new ProblemError('reel-not-a-reel');
  if (e instanceof ReelUnavailableError) return new ProblemError('reel-unavailable');

  // Instagram said 200 and handed us a shape we could not read. Shown to the
  // user as "not available" because that is what it means to them, and logged
  // loudly because it means something entirely different to us: the payload has
  // drifted and lib/ingest/inbox/parse.ts needs looking at. Conflating the two
  // in the LOG as well as in the copy is how a schema change stays invisible.
  if (e instanceof ReelPayloadError) {
    console.error(`[ingest] media ${e.shortcode} returned a payload readMedia could not parse`);
    return new ProblemError('reel-unavailable');
  }

  return e;
}
