import { z } from 'zod';
import { createHash } from 'node:crypto';

import { queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { serialiseSavedPlace, SAVED_PLACE_SELECT, type SavedPlaceRow } from '@/lib/saved-places';
import { saveReel } from '@/lib/ingest/save-reel';
import {
  placeIdsByOrdinal,
  resolvePlaceCandidate,
  type ResolvedCandidate,
} from '@/lib/research/resolve-place';
import { GeocoderNotConfiguredError } from '@/lib/research/geocode';
import type { PlaceCandidate } from '@/lib/extract/types';

/**
 * POST /api/agent/suggestions — save a place the assistant found.
 *
 * ── WHAT IS BEING SAVED, AND WHY IT IS NOT A `places` ROW ──────────────────
 * `discover_places` reads Naver blogs and Instagram and returns venue NAMES
 * lifted out of other people's prose. A name is not a place. `places` is the
 * table the planner reads, its `lat`/`lng` are NOT NULL with CHECK constraints
 * bounding them to real coordinates, and writing a stranger's sentence into it
 * would launder a claim into a Gaja fact — the thing `lib/research/nearby.ts`
 * says in its header it deliberately does not do.
 *
 * So this route does not promote a suggestion. It does exactly two things: it
 * tries to resolve the suggestion the ONE way this codebase resolves anything
 * (geocode the written address, then `findOrCreatePlace`), and it writes a
 * `saved_places` row either way.
 *
 * ── THE NAME-ONLY CASE IS THE DESIGNED ONE, NOT THE FALLBACK ───────────────
 * Measured, not assumed: a suggestion carrying a street address geocodes and
 * gets a real `place_id` and a map pin. A suggestion carrying only a NAME cannot
 * be resolved at all — the geocoder answers `status: OK, results: 0` for
 * `황학동 마일더스`, and Naver's Local Search API (which does take names) returns
 * 401 for our credential, because it needs a developers.naver.com application
 * rather than the NCP Maps key this project holds. There is no third option and
 * no amount of retrying changes it. Most suggestions will be name-only, because
 * most blog roundups print a name and a photo and no address.
 *
 * THE SCHEMA ALREADY HAS A STATE FOR THIS. `saved_places.place_id` is nullable
 * and `status = 'pending'` is what 20260918000001 defined it for — the row
 * exists before resolution. `lib/ingest/save-reel.ts` writes exactly this today
 * for every reel venue whose address did not geocode. A name-only suggestion is
 * the same thing arriving through a different door, so it takes the same door
 * handle: the row is in the user's list, it has no pin yet, and nothing was
 * invented to give it one. Blocking the save would be the worse answer — the
 * user asked for this place, and "we could not find coordinates" is our problem,
 * not a reason to refuse them their own list.
 *
 * ── NO SECOND WRITE PATH, NO SECOND GEOCODER, NO SECOND DEDUPE ─────────────
 * `resolvePlaceCandidate` is the geocode-plus-`findOrCreatePlace` step the reel
 * ingest uses, called unchanged. `saveReel` is the write, called unchanged —
 * which is also where the 50m-plus-fuzzy-name dedupe and the "you already hold
 * this place" guard come from. A route that inlined either would eventually
 * disagree with the reel path about whether two cafés are the same café, and
 * that disagreement is how a user ends up with 어니언 성수 twice.
 *
 * ── WHERE THE NAME LIVES ───────────────────────────────────────────────────
 * `saved_places` has no name column: a resolved row is named by its `places`
 * row, and a pending one is named by `reels.extracted` at `(reel_id, ordinal)`.
 * So a suggestion is recorded as a one-venue `reels` row whose `source_url` is
 * the blog post or reel it came from — which is not a stretch of that table but
 * the shape it already has. `reels` holds a source post, its text, and the
 * venues read out of it; that is precisely what a saved suggestion is. The
 * place-detail screen renders it with no changes, the saved-places list joins
 * `r.source_url` for the receipt, and the provenance survives into the database
 * instead of stopping at the chat bubble.
 *
 * ── IDEMPOTENT WITHOUT AN IDEMPOTENCY KEY ──────────────────────────────────
 * `reel_video_id` is derived from `(source_url, name)`, so saving the same
 * suggestion twice takes the `on conflict do nothing` branch in `claimReel` and
 * returns the first row with a 200. No `Idempotency-Key` handling, for the
 * reason `app/api/events/[event_id]/save/route.ts` gives about its own: the
 * property the key would buy is already bought by a unique index.
 */

export const runtime = 'nodejs';

/**
 * One geocode round trip plus a couple of statements. Far below the platform
 * default, but stated rather than inherited — `lib/research/geocode.ts` gives
 * the request itself 10s and a timeout that outlives the function is a timeout
 * that never fires.
 */
export const maxDuration = 30;

const Body = z.object({
  /** The venue name as the writer wrote it. Never romanised on the way in. */
  name: z.string().trim().min(1).max(120),
  name_alt: z.string().trim().max(120).nullish(),
  /**
   * The address AS WRITTEN IN THE POST. When present this is what geocodes;
   * when absent the row is saved pending, which is the ordinary case.
   */
  address: z.string().trim().max(200).nullish(),
  category: z.enum(['cafe', 'restaurant', 'exhibition', 'shop', 'activity']).nullish(),
  /**
   * REQUIRED, AND THE ONLY REQUIRED FIELD BESIDES THE NAME.
   *
   * The receipt is the entire justification for a scraped venue name existing on
   * screen at all, and a save is the moment that name stops being a chat message
   * and becomes a row someone will look at next month. A suggestion that arrives
   * without its source is indistinguishable from one a client made up, so it is
   * rejected rather than saved unattributed.
   */
  source_url: z.string().trim().url().max(2000).refine(
    (u) => u.startsWith('https://') || u.startsWith('http://'),
    { message: 'source_url must be an http(s) URL.' },
  ),
  source_title: z.string().trim().max(300).nullish(),
});

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ProblemError('validation-error', { detail: '요청 본문을 읽지 못했어요.' });
  }
  const body = Body.parse(raw);

  // ORDINAL 1 OF 1. A suggestion is one venue chosen out of a post that may have
  // named twenty; the other nineteen are not being saved and must not be
  // invented into `extracted` to make the numbering look natural.
  const candidate: PlaceCandidate = {
    ordinal: 1,
    name: body.name,
    name_alt: body.name_alt ?? null,
    // The venue's own Instagram handle. `discover_places` does not send it — the
    // card attributes by link, not by handle — and guessing one from the source
    // post would attribute the venue to whoever wrote about it.
    handle: null,
    address: body.address ?? null,
    // NOT FILLED IN. `NearbyCandidate` carries no hours, so a saved suggestion
    // genuinely has none, and an empty string here would read downstream as a
    // creator who wrote "" rather than as a creator who wrote nothing.
    hours_raw: null,
    menu_raw: null,
    category: body.category ?? null,
    // The suggestion's category came from `extractPlacesFromCaption` reading
    // somebody's prose, and it is being restated by a client we do not control.
    // `'medium'` is what that is worth: good enough for `resolvePlaceCandidate`
    // to write a row with (it rejects only `'low'`), and never claimed as
    // certain. Absent a category entirely, the row stays pending — which is
    // correct, because `places.category` is NOT NULL and a guess there reads as
    // a fact forever.
    category_confidence: body.category ? 'medium' : null,
  };

  // ── Resolution, outside any transaction ───────────────────────────────────
  // `resolvePlaceCandidate` does one HTTPS round trip and `tx()` holds one
  // pooled client for its whole duration (a pool of ONE per instance on Vercel),
  // so this must not move inside `saveReel`.
  let resolved: ResolvedCandidate;
  try {
    resolved = await resolvePlaceCandidate(candidate, { category: null });
  } catch (e) {
    // THE ONE ERROR `resolvePlaceCandidate` RE-THROWS, AND IT DOES NOT GET TO
    // FAIL THIS REQUEST. A missing NCP credential is a deployment mistake that
    // applies to every save in every session; the reel ingest lets it propagate
    // because a background pass writing a whole inbox of unresolved rows would
    // hide a broken deploy. Here there is a person waiting, and the row they
    // asked for is perfectly valid without coordinates — the pending state is
    // designed, not degraded. So: shout in the log, save the place.
    if (e instanceof GeocoderNotConfiguredError) {
      console.error(`[agent/suggestions] ${e.message} Saving unresolved.`);
      resolved = { ordinal: 1, placeId: null, failure: 'geocode-failed', matched: false };
    } else {
      throw e;
    }
  }

  // Pre-checked rather than left to the write. `finishIn`'s CTE handles this
  // case by silently writing the row UNRESOLVED — correct for a ten-venue reel,
  // where losing nine venues to one duplicate would be the worse bug, but wrong
  // for a single deliberate tap: the user would get a second, pin-less copy of a
  // place they already have and no explanation. `duplicate-saved-place` is the
  // documented 409 for exactly this, and the same index backs it up if two taps
  // race past this check.
  if (resolved.placeId) {
    const held = await queryOne<{ id: string }>(
      `select id from saved_places
        where user_id = $1 and place_id = $2 and group_id is null and status <> 'rejected'
        limit 1`,
      [user.id, resolved.placeId],
    );
    if (held) throw new ProblemError('duplicate-saved-place');
  }

  const saved = await saveReel({
    userId: user.id,
    reelVideoId: suggestionId(body.source_url, body.name),
    sourceUrl: body.source_url,
    // The post's BODY, which we do not have — `discover_places` sends the model
    // venue names and a link, not the four kilobytes it read them out of. Null
    // is the honest value; storing the title here would put a headline in the
    // column that means "the full text we parsed".
    rawCaption: null,
    extraction: {
      places: [candidate],
      /** The post's own headline. A label for the source, never for the venue. */
      title: body.source_title?.trim() || null,
      // NOT a hedge about this venue, and not the model's self-assessment: this
      // field answers "did we find the right NUMBER of venues", derived by
      // counting numbered blocks in the source text. There is no count to check
      // — one venue was chosen by a person, not parsed out of a list — so the
      // question does not apply. `'low'` would answer a different question
      // wrongly and force the whole row to `needs_review` on false grounds.
      confidence: 'medium',
      // Not a pinned model id, because no model ran here. The name says where
      // this record came from, which is what the field is for.
      model: 'agent-suggestion',
      // No extraction happened, so no extraction took any time.
      ms: 0,
    },
    placeIds: placeIdsByOrdinal([resolved]),
  });

  const savedPlaceId = saved.savedPlaceIds[0];
  if (!savedPlaceId) {
    // `finishIn` writes one row per candidate and there is exactly one
    // candidate, so this is unreachable — unless the reel already existed with
    // no venues, which is a state only a crashed earlier write could leave.
    console.error(`[agent/suggestions] reel ${saved.reelId} produced no saved place.`);
    throw new ProblemError('internal-error');
  }

  const row = await queryOne<SavedPlaceRow>(
    `${SAVED_PLACE_SELECT}
      where sp.id = $1 and sp.user_id = $2`,
    [savedPlaceId, user.id],
  );
  if (!row) throw new ProblemError('internal-error');

  return json(
    {
      // The same shape every other saved-place endpoint returns, so the client
      // that just saved can render it without a second fetch or a second
      // serialiser. `place` is null on a name-only save; the client already
      // handles that — it has since slice 1, deliberately.
      saved_place: serialiseSavedPlace(row),
      // The one thing the caller cannot read off the row without knowing this
      // route's rules: whether the save produced a pin. The sheet uses it to say
      // 지도에 표시할 위치는 아직 없어요 rather than leaving a user to discover it
      // on the map screen.
      located: row.place_id !== null,
    },
    // 201 for a save that happened, 200 for one that had already happened. A
    // double tap is not an error and is not a second row.
    { status: saved.alreadyExisted ? 200 : 201 },
  );
});

/**
 * A stable `reels.reel_video_id` for something that is not a reel.
 *
 * The column is `text not null` and `unique (user_id, reel_video_id)` is what
 * makes a redelivered DM cheap; here it is what makes a double-tapped save
 * cheap. Derived from the source URL and the venue name together, because ONE
 * POST YIELDS MANY VENUES — keying on the URL alone would mean saving the second
 * café from a ten-café roundup silently returned the first one.
 *
 * Namespaced `sug:` so a synthetic id can never collide with an Instagram
 * shortcode, and hashed rather than concatenated so the value stays inside
 * anything that assumes an id is short. Truncated to 128 bits, which is far more
 * than collision resistance needs for rows scoped to a single user.
 */
function suggestionId(sourceUrl: string, name: string): string {
  const digest = createHash('sha256')
    // NFC and case-folded on the name only, so `카페 그린` and `카페그린` from the
    // same post do not become two rows. The URL is left byte-exact — two URLs
    // differing by a query string are two posts as far as anyone can tell.
    .update(`${sourceUrl}\n${name.normalize('NFC').replace(/\s+/g, '').toLowerCase()}`)
    .digest('hex');
  return `sug:${digest.slice(0, 32)}`;
}
