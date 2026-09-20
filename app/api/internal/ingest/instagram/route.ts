import { timingSafeEqual } from 'node:crypto';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import {
  InboxBreakerTrippedError,
  InboxNotConfiguredError,
} from '@/lib/ingest/inbox/instagram-poll';
import { runIngestPass } from '@/lib/ingest/run-pass';

/**
 * The HTTP door onto one pass of the reel ingest pipeline.
 *
 * THE PASS ITSELF IS NOT HERE. It is `runIngestPass` in lib/ingest/run-pass.ts,
 * which this route shares verbatim with scripts/watch-inbox.ts. That split is
 * the whole point: the watcher and the cron must run the same five stages in the
 * same order, and the only way to guarantee that is for neither of them to own
 * the code. What is left in this file is authentication and the mapping from the
 * pass's named errors onto RFC 9457 problem documents — two jobs that are
 * genuinely about HTTP and about nothing else.
 *
 * GET, not POST, because Vercel Cron invokes the path with GET and a
 * `Authorization: Bearer $CRON_SECRET` header. A GET that mutates is not
 * something to be pleased about; it is the platform's contract and the secret is
 * what keeps it from being a drive-by. POST is exported alongside it so the
 * route can be driven by hand with the same header, which matters here because
 * this project has no Vercel deployment yet (see vercel.ts) and manual
 * invocation is one of only two ways it runs today — the other being the
 * watcher, which does not go through HTTP at all.
 */

// The whole pass — one HTTP request to Instagram, then per clip a video download,
// a model call and ~10 geocodes — happens inside one invocation. 60s is the Hobby
// ceiling; a pass that needs longer than this is a pass that should be fetching
// fewer threads.
export const maxDuration = 60;

// Reads a header and writes to Postgres on every call. Marked explicitly so the
// route can never be mistaken for a prerenderable GET and served from a cache —
// a cached ingest pass would report a stale summary and quietly stop running.
export const dynamic = 'force-dynamic';

export const GET = withRoute(async (req: Request) => run(req));
export const POST = withRoute(async (req: Request) => run(req));

async function run(req: Request) {
  requireCronSecret(req);

  try {
    // Counts only. No cookie value, no caption text, no sender handle — this
    // response goes to whoever holds CRON_SECRET, and a summary that quoted a
    // caption would put a third party's writing behind a shared secret.
    return json(await runIngestPass());
  } catch (e) {
    // A tripped breaker is a documented 503 rather than an opaque 500, so the
    // cron's own logs say plainly why nothing is being ingested. The reason is a
    // short tag written by `detectBlock` — never a response body and never a
    // cookie. Nothing retries out of this state; see lib/problem.ts.
    if (e instanceof InboxBreakerTrippedError) {
      throw new ProblemError('ingest-breaker-tripped', {
        detail: `인스타그램이 이 계정의 요청을 막아서 릴스 수집이 멈췄어요 (${e.reason}). 인스타그램 앱에서 확인 절차를 끝낸 뒤 손으로 다시 켜야 해요.`,
      });
    }
    // A missing environment variable is a deployment fact, not a runtime
    // failure, and a 500 would send whoever is on call looking for a bug. The
    // problem names the variable; nothing anywhere reads its value.
    if (e instanceof InboxNotConfiguredError) {
      throw new ProblemError('ingest-not-configured', {
        detail: `릴스 수집에 필요한 환경 변수 ${e.variable}가 설정되지 않았어요.`,
      });
    }
    throw e;
  }
}

/**
 * The only thing standing between this endpoint and the open internet.
 *
 * Compared in constant time. A plain `===` on a secret short-circuits at the
 * first differing byte, and the difference between "wrong at byte 0" and "wrong
 * at byte 20" is measurable across enough requests — that is a byte-at-a-time
 * recovery of the secret, from outside, with no rate limit involved.
 *
 * The length guard is not paranoia about `timingSafeEqual`: it THROWS on unequal
 * lengths rather than returning false, so without it a caller could turn a probe
 * into a 500 and read the length off the status code. Length is still leaked by
 * the early return, and that is accepted — knowing a 64-character secret is 64
 * characters long buys an attacker nothing.
 */
function requireCronSecret(req: Request): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Unset means the door has no lock. Refusing is the only safe reading: the
    // alternative — treating "no secret configured" as "no secret required" —
    // publishes the ingest trigger the moment someone forgets an env var.
    console.error('[ingest] CRON_SECRET is not set; refusing to run.');
    throw new ProblemError('internal-error');
  }

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ProblemError('unauthenticated');
  }
}
