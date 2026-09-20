import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { assertGroupMember, serialiseSavedPlace, SAVED_PLACE_SELECT, type SavedPlaceRow } from '@/lib/saved-places';
import { getEventForSave } from '@/lib/events/store';

type Ctx = { params: Promise<{ event_id: string }> };

/**
 * 저장 — the one place where a global listing becomes somebody's own.
 *
 * BROWSING IS GLOBAL, SAVING IS PERSONAL. The events feed has no `user_id`
 * anywhere in it: the same five popups are shown to every account. This route is
 * the seam where that stops being true, and what it writes is an ordinary
 * `saved_places` row — the same table a reel-extracted place lands in, so the
 * event joins the user's map and their list beside everything else rather than
 * living in a parallel world with its own screen.
 *
 * NOTHING ABOUT `events` IS COPIED INTO THE SAVED ROW. The join is
 * `saved_places.place_id -> places.id`, and `events.place_id` already points at
 * the `places` row the scrape resolved (lib/events/resolve.ts). Denormalising the
 * title or the poster onto the saved row would mean a popup that changes its
 * dates changes them in the feed and not in anybody's saved list.
 *
 * WHY THERE IS NO DELETE HERE. Un-saving is `DELETE /api/saved-places/{id}`,
 * which already exists and already carries the object-level authorization rules
 * for group rows. A second un-save addressed by event id would be a second
 * answer to "may this person remove this row", and the existing one is the one
 * the saved-places screen uses.
 */

// Only `group_id`, and it is optional. There is nothing else a caller gets to
// choose: the place is whatever the scrape resolved, the status is `resolved`
// because there is nothing pending about it, and `hook` is deliberately not
// exposed — see below.
const Body = z
  .object({
    /** Save into a group instead of privately. Membership is checked. */
    group_id: z.string().uuid().nullish(),
  })
  // The request has no required fields, so an empty body is legal and common.
  .default({});

export const POST = withRoute(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { event_id } = await ctx.params;

  // Parsed rather than trusted, and tolerant of no body at all: the save button
  // sends `{}` and a bare `fetch(url, { method: 'POST' })` sends nothing.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // No body. `Body` has a default for exactly this.
  }
  const body = Body.parse(raw ?? {});

  if (body.group_id) await assertGroupMember(body.group_id, user.id);

  const event = await getEventForSave(event_id);
  if (!event) throw new ProblemError('not-found');

  // ──────────────────────────────────────────────────────────────────────────
  // THE ONE CASE THIS ROUTE EXISTS TO NAME PROPERLY.
  //
  // The event is real and the user is looking at its card. What is missing is a
  // LOCATION: most yanolja listings publish a hall name (`NOL 유니플렉스 1관`) and
  // no street address, so the scrape had nothing to geocode. A 404 here would be
  // a lie about a card that is on screen, and a 500 would be a bug report about
  // a state we designed for.
  //
  // The screen disables the control and says why, so this should be unreachable
  // through the UI. It is the backstop for a stale page and for anything driving
  // the API directly.
  // ──────────────────────────────────────────────────────────────────────────
  if (!event.place_id) throw new ProblemError('event-not-located');

  // No `Idempotency-Key` handling, unlike POST /api/saved-places. It would be
  // ceremony here: `saved_places_no_duplicate_idx` already makes a second save
  // of the same place into the same scope impossible, and lib/route.ts maps that
  // constraint to `duplicate-saved-place` — so a double-tap gets a documented 409
  // rather than a second row, which is the property the key would have bought.
  const created = await queryOne<SavedPlaceRow>(
    `with ins as (
       insert into saved_places (user_id, group_id, place_id, hook, status, confirmed)
       -- confirmed = true and status = 'resolved', because nothing about this is
       -- a guess: the user tapped a specific listing whose place was resolved
       -- from a published street address, not extracted from a caption. hook is
       -- null — the place is already named after the event (see
       -- lib/events/resolve.ts), so a hook repeating the title would be noise in
       -- the one field meant for the user's own note.
       values ($1, $2, $3, null, 'resolved', true)
       returning *
     )
     ${SAVED_PLACE_SELECT.replace('from saved_places sp', 'from ins sp')}`,
    [user.id, body.group_id ?? null, event.place_id],
  );

  // The saved row, in the same shape every other saved-place endpoint returns —
  // so the client that just saved can render it without a second fetch and
  // without a second serialiser.
  return json(serialiseSavedPlace(created!), { status: 201 });
});
