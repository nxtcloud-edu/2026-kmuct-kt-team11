import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { getSavedPlaceDetailForUser } from '@/lib/saved-places';
import { findNearbyPlaces, NearbyNotConfiguredError } from '@/lib/research/nearby';

/**
 * Venues written about near a saved place.
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
 * ── PARTIAL FAILURE IS A 200 ───────────────────────────────────────────────
 * One source dying while the other returns eight venues is not an error — it is
 * eight venues and a note. The result's `sources[]` carries a per-source status
 * and the screen renders it. The ONLY problem response is the one where nothing
 * was attempted at all, because that is the only case with nothing to show.
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

  try {
    return json(
      await findNearbyPlaces({
        name: place.name,
        area: place.area,
        category: place.category,
      }),
    );
  } catch (e) {
    if (e instanceof NearbyNotConfiguredError) {
      // `e.variable` is the NAME of a billed credential and is not put in the
      // response; it goes to the server log, where the person who can fix it is.
      console.error(`[nearby] not configured: ${e.variable} is unset.`);
      throw new ProblemError('nearby-not-configured');
    }
    throw e;
  }
});
