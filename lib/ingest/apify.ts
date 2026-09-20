/**
 * The Apify transport. SERVER ONLY.
 *
 * This is the bottom of the dependency chain the wait-digest spec §2 draws:
 * `app/api` → `lib/research` → `lib/ingest` → Apify. Everything here knows about
 * actors, runs and datasets, and has never heard of a place — the domain rules
 * live one layer up, in `lib/research`, which is what keeps them testable
 * against fixtures with no network.
 *
 * `APIFY_TOKEN` is a real, billed secret. Never prefix it `NEXT_PUBLIC_` (that
 * inlines it into the browser bundle at build time), never log it, never echo it
 * into an error message or a problem response — the same rule `.env.example`
 * already states for `NAVER_MAP_CLIENT_SECRET` and `GEMINI_API_KEY`.
 *
 * WHY `run-sync-get-dataset-items` rather than start-run-then-poll: a keyword
 * scrape of ten blog posts finishes inside a request, and the polling version
 * needs somewhere to keep a run id between calls. Apify holds the connection for
 * up to five minutes, which is inside the 300s Vercel Function ceiling — but
 * only just, so `timeoutSecs` below is set well under both.
 *
 * Server-ness is enforced by convention here, not by the `server-only` package:
 * nothing in this repo imports it, and `lib/extract/caption.ts` guards the same
 * class of secret with the same doc comment. If `server-only` is ever added, it
 * belongs at the top of both files in the same commit.
 */

const BASE = 'https://api.apify.com/v2';

/**
 * Every failure out of here is this one type, so callers branch on a class
 * rather than on a status code they would have to re-derive. The wait-digest
 * spec §6 treats `ApifyError` as the entire failure surface of this source: the
 * digest is left stale rather than being overwritten with nothing.
 */
export class ApifyError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ApifyError';
  }
}

/** Thrown separately from `ApifyError` so "not configured" never reads as "Apify is down". */
export class ApifyNotConfiguredError extends Error {
  constructor() {
    super(
      'APIFY_TOKEN is not set. lib/ingest/apify.ts needs it to run an actor; set it in .env.local (server-side only, never NEXT_PUBLIC_).',
    );
    this.name = 'ApifyNotConfiguredError';
  }
}

/** Whether a call would get past the token check. Lets a caller degrade before paying for a round trip. */
export function apifyConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN);
}

/**
 * Retried on 429 and 5xx only.
 *
 * A 400 means the actor input is wrong and a retry sends the identical wrong
 * body; a 401 means the token is wrong and a retry cannot fix that either. Both
 * are deployment mistakes that should surface immediately rather than three
 * times slower. Backoff is 1s then 3s with full jitter — Apify's own rate limit
 * is per-token and short-lived.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [1000, 3000];

/**
 * Run an actor and return its dataset items.
 *
 * `actorId` uses Apify's URL form with `~` where the store shows `/` —
 * `maximedupre/naver-blog-review-scraper` is `maximedupre~naver-blog-review-scraper`.
 * Callers pass the slash form and this normalises it, because the slash form is
 * what is written in the docs and in `.env.example`.
 *
 * The return type is `unknown[]` on purpose. An actor's output shape belongs to
 * whoever maintains the actor and can change without a version bump, so the
 * mapping — and the decision about what a shape change means — is the caller's,
 * next to the domain type it is mapping into.
 */
export async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  opts: { timeoutSecs?: number; memoryMbytes?: number } = {},
): Promise<unknown[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new ApifyNotConfiguredError();

  const path = actorId.replace('/', '~');
  const params = new URLSearchParams({ timeout: String(opts.timeoutSecs ?? 120) });
  if (opts.memoryMbytes) params.set('memory', String(opts.memoryMbytes));

  // The token travels as a header, not as the `?token=` query parameter Apify's
  // docs still show first: a query string is the part of a URL that ends up in
  // proxy logs and error messages.
  const url = `${BASE}/acts/${path}/run-sync-get-dataset-items?${params}`;

  let last: ApifyError | null = null;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      const base = BACKOFF_MS[attempt - 1];
      await new Promise((r) => setTimeout(r, Math.random() * base));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
        // An actor run is never a cacheable GET, but Next will still try to
        // participate in its own fetch cache unless told otherwise.
        cache: 'no-store',
        signal: AbortSignal.timeout((opts.timeoutSecs ?? 120) * 1000 + 10_000),
      });
    } catch (e) {
      // DNS, TLS, socket, or our own AbortSignal firing. All retryable.
      last = new ApifyError(`Apify request failed: ${(e as Error).message}`);
      continue;
    }

    if (!res.ok) {
      // Apify's error body is JSON with an `error.message`, but a gateway in
      // front of it answers with HTML. Read it as text and cap it — never let an
      // upstream page become the message on a thrown error.
      const body = (await res.text().catch(() => '')).slice(0, 300);
      last = new ApifyError(`Apify actor ${actorId} returned ${res.status}: ${body}`, res.status);
      if (RETRY_STATUS.has(res.status)) continue;
      throw last;
    }

    let items: unknown;
    try {
      items = await res.json();
    } catch {
      throw new ApifyError(`Apify actor ${actorId} returned a body that was not JSON.`);
    }

    if (!Array.isArray(items)) {
      throw new ApifyError(
        `Apify actor ${actorId} returned ${typeof items} where the dataset should be an array.`,
      );
    }
    return items;
  }

  throw last ?? new ApifyError(`Apify actor ${actorId} failed with no response.`);
}
