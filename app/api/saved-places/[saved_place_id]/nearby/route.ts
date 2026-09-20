import { withRoute } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { getSavedPlaceDetailForUser } from '@/lib/saved-places';
import { streamNearbyPlaces, NearbyNotConfiguredError, type NearbyEvent } from '@/lib/research/nearby';

/**
 * Venues written about near a saved place, streamed as NDJSON.
 *
 * ── POST, NOT GET, AND THAT IS THE COST CONTROL ────────────────────────────
 * This runs two Apify actors and up to fourteen Gemini calls. A GET is a thing
 * browsers prefetch on hover, service workers replay, and Next caches; every one
 * of those is a bill nobody asked for. POST is not prefetched, is never cached,
 * and — the part that matters on this surface — means a request can only exist
 * because someone pressed something. The button IS the intent, so the method has
 * to be one that only a button can send.
 *
 * There is no request body and no parameters. The anchor's 동 and category come
 * off the saved place itself, so there is nothing a caller can widen: no
 * `limit`, no `radius`, no `sources`. The caps live in `lib/research/nearby.ts`.
 *
 * ── WHY IT STREAMS ─────────────────────────────────────────────────────────
 * The work takes about thirty seconds and used to arrive as one object at the
 * end, which left the screen with exactly one true sentence to say for the whole
 * wait. The search itself knows more than that while it runs — which source
 * landed, with how many posts, how many of those have been read — and those
 * facts are worth more to a user deciding whether to trust the result than any
 * spinner. `lib/research/nearby.ts` yields them; this hands them straight on,
 * one JSON object per line, exactly as `app/api/agent/route.ts` does for the
 * assistant. Same transport, because this is the same problem.
 *
 * ── THE ERROR CONTRACT CHANGES AT THE FIRST BYTE ───────────────────────────
 * `withRoute` still wraps this, and everything that can fail BEFORE the stream
 * opens — no session, no such saved place, no credential — leaves as an ordinary
 * RFC 9457 problem document, which is what the screen's failure path reads. That
 * is why the first event is pulled here rather than inside the stream: the
 * credential check in `streamNearbyPlaces` throws out of that first `next()`,
 * while a status line can still be sent. After it, the status is spent and a
 * failure arrives in-band as `{ type: 'error' }`.
 *
 * ── PARTIAL FAILURE IS A 200 ───────────────────────────────────────────────
 * One source dying while the other returns eight venues is not an error — it is
 * eight venues and a note. The result's `sources[]` carries a per-source status
 * and the screen renders it, now twice: once as the step's own outcome while the
 * search is running, and once in the summary afterwards. The ONLY problem
 * response is the one where nothing was attempted at all, because that is the
 * only case with nothing to show.
 *
 * ── NOT IN openapi.yaml ────────────────────────────────────────────────────
 * Deliberately, and the same call `lib/saved-places.ts` documents for
 * `SavedPlaceDetail`: this is the nearby screen talking to its own backend, not
 * a published contract. `lib/api/types.ts` mirrors openapi.yaml by hand, and
 * adding a shape there is a promise to keep it. When a second consumer appears,
 * it gets mirrored in that commit.
 */

export const runtime = 'nodejs';

/**
 * Two 90s actor runs run concurrently, plus geocode-free extraction. 120s leaves
 * headroom over the sources' own timeouts without approaching the 300s platform
 * ceiling, where the failure is a killed function with no response at all.
 */
export const maxDuration = 120;

type Ctx = { params: Promise<{ saved_place_id: string }> };

export const POST = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { saved_place_id } = await ctx.params;

  // Visibility is in `getSavedPlaceDetailForUser`'s WHERE clause and a row this
  // user may not see comes back null. 404 for both "no such row" and "not
  // yours", which is the posture the sibling route's `authorise` takes and for
  // the same reason: a 403 confirms the id is real to whoever guessed it.
  const detail = await getSavedPlaceDetailForUser(saved_place_id, user.id);
  if (!detail) throw new ProblemError('not-found');

  const place = detail.saved.place;
  // A pending row has no place and therefore no 동 to search around. This is not
  // a failure to report to the user in Korean prose — the screen never renders
  // the button in that state, so reaching here means something bypassed it.
  if (!place?.area) throw new ProblemError('not-found');

  const events = streamNearbyPlaces({
    name: place.name,
    area: place.area,
    category: place.category,
  });

  // The first event, pulled while a status line is still available. Nothing has
  // been billed at this point — the generator's credential check runs before its
  // first yield, so an unconfigured environment costs one rejected promise and
  // no actor run.
  let first;
  try {
    first = await events.next();
  } catch (e) {
    if (e instanceof NearbyNotConfiguredError) {
      // `e.variable` is the NAME of a billed credential and is not put in the
      // response; it goes to the server log, where the person who can fix it is.
      console.error(`[nearby] not configured: ${e.variable} is unset.`);
      throw new ProblemError('nearby-not-configured');
    }
    throw e;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) controller.enqueue(encoder.encode(line(first.value)));
        for await (const event of events) controller.enqueue(encoder.encode(line(event)));
      } catch (e) {
        // `streamNearbyPlaces` turns every source failure into a status and does
        // not throw past its first yield; if one ever escapes, the connection
        // still has to close with something the screen can render rather than
        // hanging until the client gives up.
        console.error('[nearby] stream failed', e);
        controller.enqueue(
          encoder.encode(
            line({
              type: 'error',
              detail: '주변 장소를 찾는 중에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },

    // The reader went away — the tab was closed, or the user navigated off the
    // screen mid-search. Returning the generator runs its `finally` blocks and
    // stops it at its next suspension point instead of leaving it yielding into
    // a controller nobody is draining.
    cancel() {
      void events.return(undefined);
    },
  });

  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
});

const STREAM_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  // Proxies that buffer a response defeat the entire point of streaming it; the
  // header is nginx's and is ignored elsewhere, which costs nothing.
  'x-accel-buffering': 'no',
};

/** One event, one line. The newline is the framing — never emit an event without it. */
function line(event: NearbyEvent): string {
  return JSON.stringify(event) + '\n';
}
