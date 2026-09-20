import { query, queryOne } from './db';
import { ProblemError } from './problem';
import { reelThumbPublicUrl } from './storage';
import type { PlaceCategory, SavedPlace, SavedPlaceStatus } from './api/types';

export type SavedPlaceRow = {
  id: string;
  user_id: string;
  group_id: string | null;
  status: string;
  confirmed: boolean;
  hook: string | null;
  // Joined from `reels`, not a column on `saved_places` — the reel moved to its own
  // table in 20260920000005 so one reel can produce many saved places. Null for
  // hand-entered rows (no reel) and for reels shared without a URL.
  source_url: string | null;
  // Also joined from `reels`. The cover frame belongs to the reel, not to the
  // venue — one reel is ten saved places, and hanging the image off the child
  // would store the same picture ten times (20260920000009).
  thumb_path: string | null;
  saved_at: Date;
  place_id: string | null;
  place_name: string | null;
  place_name_alt: string[] | null;
  place_category: string | null;
  place_lat: number | null;
  place_lng: number | null;
  place_address: string | null;
  place_area: string | null;
};

/**
 * The join list is load-bearing beyond the columns it names: two call sites
 * re-point this select at a CTE with `.replace('from saved_places sp', 'from ins sp')`,
 * so the `from` clause must stay on its own line and every join must follow it.
 * Put nothing between `select` and `from` that names `saved_places` by table name.
 */
export const SAVED_PLACE_SELECT = `
  select sp.id, sp.user_id, sp.group_id, sp.status, sp.confirmed, sp.hook, sp.saved_at,
         r.source_url as source_url, r.thumb_path as thumb_path,
         p.id as place_id, p.name as place_name, p.name_alt as place_name_alt,
         p.category as place_category, p.lat as place_lat, p.lng as place_lng,
         p.address as place_address, p.area as place_area
    from saved_places sp
    left join places p on p.id = sp.place_id
    left join reels r on r.id = sp.reel_id`;

/**
 * `place` is null while status is 'pending' — the row exists before resolution by design
 * (spec §5.2). Slice 1 never produces a pending row, but the client handles null from the
 * start so slice 3 does not require a client rewrite.
 *
 * `extracted` and `raw_caption` live on `reels` now and are still deliberately never
 * returned: extractor internals with no client use. `reel_id` and `ordinal` are not
 * returned either — they are database-only until something consumes them.
 *
 * The `SavedPlace` return annotation is load-bearing: `lib/api/types.ts` mirrors
 * openapi.yaml by hand, so this is what makes tsc catch the two drifting apart.
 */
export function serialiseSavedPlace(r: SavedPlaceRow): SavedPlace {
  return {
    id: r.id,
    // Every place column is nullable on the row type only because of the LEFT
    // JOIN. In `places` they are NOT NULL (see the migration), so a non-null
    // place_id guarantees the rest — a correlation tsc cannot see. `address` is
    // the one genuinely nullable column and keeps its null.
    place: r.place_id
      ? {
          id: r.place_id,
          name: r.place_name!,
          name_alt: r.place_name_alt ?? [],
          category: r.place_category as PlaceCategory,
          lat: r.place_lat!,
          lng: r.place_lng!,
          address: r.place_address,
          area: r.place_area!,
        }
      : null,
    group_id: r.group_id,
    status: r.status as SavedPlaceStatus,
    confirmed: r.confirmed,
    hook: r.hook,
    source_url: r.source_url,
    // A URL, not the stored path: the client has no business knowing the bucket
    // name or Storage's route shape, and building it here means a move to a
    // different object store is one function (lib/storage.ts), not a client
    // release. Null when the reel has no cover yet, when the row is
    // hand-entered, or when Supabase is not configured at all — the deck falls
    // back to lib/reel-thumb.ts in every one of those cases.
    //
    // `thumb_width`/`thumb_height` stay DATABASE-ONLY, on the same rule as
    // `reel_id` and `ordinal` (20260920000005): the deck renders into a fixed
    // aspect box and needs neither, and a field in a published contract is a
    // promise to keep it.
    thumb_url: reelThumbPublicUrl(r.thumb_path),
    saved_at: r.saved_at.toISOString(),
  };
}

/** Object-level authorization. Throws 403 rather than returning a boolean, so it cannot be ignored. */
export async function assertGroupMember(groupId: string, userId: string): Promise<'owner' | 'member'> {
  const row = await queryOne<{ role: 'owner' | 'member' }>(
    `select role from group_members where group_id = $1 and user_id = $2`,
    [groupId, userId],
  );
  if (!row) throw new ProblemError('not-group-member');
  return row.role;
}

export async function assertGroupOwner(groupId: string, userId: string): Promise<void> {
  if ((await assertGroupMember(groupId, userId)) !== 'owner') throw new ProblemError('forbidden');
}

/**
 * Read path for Server Components. Server rendering talks to Postgres directly
 * rather than fetching our own `/api/saved-places` — that would be an extra HTTP
 * hop and a second copy of the auth check for no benefit.
 *
 * The route handler stays the contract for browsers; this is the same data for
 * the server. Both go through `serialiseSavedPlace`, so the shape cannot fork.
 */
export async function listSavedPlacesForUser(userId: string, limit = 30) {
  const rows = await query<SavedPlaceRow>(
    `${SAVED_PLACE_SELECT}
      where (sp.user_id = $1
             or sp.group_id in (select group_id from group_members where user_id = $1))
        and sp.status <> 'rejected'
   order by sp.saved_at desc, sp.id desc
      limit $2`,
    [userId, limit],
  );
  return rows.map(serialiseSavedPlace);
}

/**
 * Places in an area, excluding ones this user already saved — a "near you"
 * section that shows what you have already got is not a recommendation.
 */
export async function listPlacesNearby(area: string, userId: string, limit = 10) {
  // `lat`/`lng` are NOT NULL in `places` (the migration's CHECK constraints bound
  // them to real coordinates), so the map can plot every row it gets back — there
  // is no "place without a position" case for the caller to handle.
  return query<{
    id: string;
    name: string;
    category: string;
    area: string;
    lat: number;
    lng: number;
  }>(
    `select p.id, p.name, p.category, p.area, p.lat, p.lng
       from places p
      where p.area = $1
        and not exists (select 1 from saved_places sp
                         where sp.place_id = p.id and sp.user_id = $2)
      order by p.created_at desc
      limit $3`,
    [area, userId, limit],
  );
}

/* ── Place detail ─────────────────────────────────────────────────────────── */

/**
 * ONE ENTRY OF `reels.extracted.places`, for the ordinal a saved place holds.
 *
 * This is `PlaceCandidate` (lib/extract/types.ts) reaching a client for the first
 * time. Until now `extracted` was extractor-internal and deliberately never
 * serialised — the comment above `serialiseSavedPlace` says so. That still holds
 * for the LIST: nothing on a list of thirty rows needs a menu. A detail view is
 * the reason the rule had ("they go on the wire when the extractor gives a client
 * a reason to read them"), and this is that reason.
 *
 * It is a SEPARATE type from `SavedPlace` rather than four more fields on it,
 * because the provenance is different in kind. Everything on `SavedPlace` is
 * Gaja's own record of a venue; everything here is A CREATOR'S CLAIM, parsed out
 * of an Instagram caption. Keeping them in one object would put
 * `saved.hours_raw` a field access away from `saved.place.address` and invite a
 * screen to render them as the same sort of fact. They are not, and
 * `docs/gaja/reel-extraction-findings.md` is explicit: caption hours are "a claim
 * by a creator, not ground truth". The nesting is the warning.
 *
 * NOT added to `lib/api/types.ts` or `docs/gaja/openapi.yaml`: this is a
 * Server-Component read, not an HTTP response. When a route handler needs it, it
 * gets mirrored there in the same commit — see that file's header.
 */
export type CaptionEntry = {
  /** 1-based position in the caption, read off the `N.` marker, not the array index. */
  ordinal: number;
  /** The romanised alias — `우이그 (UIG)` yields `UIG`. Null when the creator wrote none. */
  name_alt: string | null;
  /** The VENUE's own account, without the `@`. Never the creator's — see caption-grammar.ts. */
  handle: string | null;
  /** Raw and unparsed, on purpose: `매일 11:00-22:30 금,토 11:00-23:00`. */
  hours_raw: string | null;
  /** Raw and unparsed: `티그레 (4,200) 아메리카노 (4,800)`. */
  menu_raw: string | null;
};

/** One of the OTHER venues the same reel named, reduced to what a row shows. */
export type SiblingPlace = {
  id: string;
  ordinal: number;
  /** Null while that sibling is still 'pending' — same reason `SavedPlace.place` is nullable. */
  name: string | null;
  area: string | null;
  category: PlaceCategory | null;
};

export type SavedPlaceDetail = {
  saved: SavedPlace;
  /**
   * Null for a hand-entered place, for a row whose reel predates extraction, and
   * for an ordinal the extractor did not name. All three are ordinary.
   */
  caption: CaptionEntry | null;
  /** The reel this came from, or null when the row was not born of one. */
  reel: {
    /**
     * The caption's own lead-in. A LABEL FOR THE SET, never a description of this
     * venue — `여름 날 카페 고민하지 말고 다녀오세요` tells you nothing about which
     * ten. Rendered verbatim, emoji included: it is quoted source text, not Gaja's
     * copy, and the record's no-emoji rule governs the latter.
     */
    title: string | null;
    /** How many venues the caption named. `ordinal` of N — the N. */
    place_count: number;
  } | null;
  /** Ordered by ordinal. Empty for a single-venue reel and for hand-entered rows. */
  siblings: SiblingPlace[];
};

/**
 * `sp.id = $1` is a uuid comparison, and Postgres answers a malformed literal with
 * 22P02 rather than zero rows. A URL segment is user input, so an unparseable id
 * has to become "no such place" here instead of a 500 three frames away.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The row shape of the second query. `extracted` arrives from pg already parsed. */
type ReelExtras = {
  ordinal: number | null;
  title: unknown;
  places: unknown;
};

/**
 * Everything the place-detail view renders, for one saved place.
 *
 * VISIBILITY IS IN THE WHERE CLAUSE, not in a check after the fact, and it is the
 * same predicate `listSavedPlacesForUser` uses: your own rows plus the rows of
 * groups you are in. A row you may not see returns null and the caller renders
 * not-found — never a 403, which would confirm the id exists to someone who
 * guessed it. That is the same posture as the route handler's `authorise`.
 *
 * THREE QUERIES, DELIBERATELY. `SAVED_PLACE_SELECT` may not be widened — two call
 * sites re-point it at a CTE by string replacement and its column list is
 * load-bearing — so the reel's extras and the sibling list are their own reads.
 * A detail page is one row and one render; three round trips is the honest cost
 * of not making that select do a fourth job.
 */
export async function getSavedPlaceDetailForUser(
  savedPlaceId: string,
  userId: string,
): Promise<SavedPlaceDetail | null> {
  if (!UUID.test(savedPlaceId)) return null;

  const row = await queryOne<SavedPlaceRow>(
    `${SAVED_PLACE_SELECT}
      where sp.id = $1
        and (sp.user_id = $2
             or sp.group_id in (select group_id from group_members where user_id = $2))
        and sp.status <> 'rejected'`,
    [savedPlaceId, userId],
  );
  if (!row) return null;

  const saved = serialiseSavedPlace(row);

  const extras = await queryOne<ReelExtras>(
    `select sp.ordinal,
            r.extracted -> 'title'  as title,
            r.extracted -> 'places' as places
       from saved_places sp
       join reels r on r.id = sp.reel_id
      where sp.id = $1`,
    [savedPlaceId],
  );

  // The siblings of a GROUP-SHARED row belong to whoever shared the reel, so the
  // viewer's own visibility predicate is applied again here rather than assumed
  // from the parent. Without it a sibling could render as a link that 404s on tap.
  const siblings = extras
    ? await query<{
        id: string;
        ordinal: number;
        name: string | null;
        area: string | null;
        category: string | null;
      }>(
        `select s.id, s.ordinal, p.name, p.area, p.category
           from saved_places me
           join saved_places s on s.reel_id = me.reel_id and s.id <> me.id
           left join places p on p.id = s.place_id
          where me.id = $1
            and me.reel_id is not null
            and s.ordinal is not null
            and s.status <> 'rejected'
            and (s.user_id = $2
                 or s.group_id in (select group_id from group_members where user_id = $2))
          order by s.ordinal`,
        [savedPlaceId, userId],
      )
    : [];

  return {
    saved,
    caption: captionEntry(extras),
    reel: extras
      ? {
          title: typeof extras.title === 'string' ? extras.title : null,
          place_count: Array.isArray(extras.places) ? extras.places.length : 0,
        }
      : null,
    siblings: siblings.map((s) => ({
      id: s.id,
      ordinal: s.ordinal,
      name: s.name,
      area: s.area,
      category: s.category as PlaceCategory | null,
    })),
  };
}

/**
 * Pick this row's entry out of the caption's list.
 *
 * MATCHED ON `ordinal`, NEVER ON ARRAY POSITION. The two differ the moment one
 * entry fails to parse, and `saved_places.ordinal` is the creator's number — the
 * same number `saved_places_reel_ordinal_idx` makes unique. Indexing by position
 * would silently attach venue 4's opening hours to venue 3's card, which is
 * exactly the class of error the honesty framing around these fields exists to
 * prevent.
 *
 * `extracted` is jsonb, so it is `unknown` at the type level however carefully our
 * own extractor writes it — a column written by one version of the code is read
 * by every later one. Narrowed field by field rather than cast.
 */
function captionEntry(extras: ReelExtras | null): CaptionEntry | null {
  if (!extras) return null;
  return pickCaptionEntry(extras.ordinal, extras.places);
}

/**
 * THE ONE ordinal-match rule, shared by the detail read above and the bulk reads
 * below.
 *
 * It was inlined in `captionEntry` until the assistant needed the same fields for
 * thirty rows at once. A second copy of "find the entry whose ordinal equals this
 * row's" is precisely the drift this file's own comment warns about — one copy
 * matching on ordinal and the other, written in a hurry, on array position, with
 * venue 4's opening hours showing up on venue 3's card in exactly one of the two
 * surfaces.
 */
function pickCaptionEntry(ordinal: number | null, places: unknown): CaptionEntry | null {
  if (ordinal === null || !Array.isArray(places)) return null;

  const hit = (places as unknown[]).find(
    (p): p is Record<string, unknown> =>
      typeof p === 'object' && p !== null && (p as { ordinal?: unknown }).ordinal === ordinal,
  );
  if (!hit) return null;

  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return {
    ordinal,
    name_alt: str(hit.name_alt),
    handle: str(hit.handle),
    hours_raw: str(hit.hours_raw),
    menu_raw: str(hit.menu_raw),
  };
}

/* ── Caption claims, in bulk ──────────────────────────────────────────────── */

/**
 * `saved_place_id -> CaptionEntry`, for many rows in one round trip.
 *
 * WHY THIS EXISTS. `hours_raw` has been stored on every reel-sourced venue since
 * 20260920000005 and, until now, exactly one surface could read it: the place
 * detail screen, one row at a time. So the assistant — the surface people
 * actually ask "저녁 9시 반에 열려 있는 데 있어?" — could not answer, because
 * `listSavedPlacesForUser` returns `SavedPlace`, and `SavedPlace` has no hours.
 * It is not that the data was missing; it is that nothing exposed it.
 *
 * SEPARATE FROM `serialiseSavedPlace`, ON PURPOSE, and for the reason
 * `CaptionEntry`'s own comment gives at length: a `SavedPlace` is Gaja's record
 * of a venue and a `CaptionEntry` is a creator's claim about it. Merging them
 * would put `hours_raw` one field access from `place.address` and invite a caller
 * to render them as the same kind of fact. They are not, and the caller here is a
 * language model, which is the single worst reader to hand an ambiguous
 * provenance to.
 *
 * VISIBILITY IS RE-CHECKED rather than inherited from whoever produced the ids.
 * The caller today passes ids straight out of `listSavedPlacesForUser`, which
 * already filtered them — but this function takes a bare array of uuids, and a
 * later caller that builds that array some other way must not be able to read a
 * stranger's caption by guessing.
 */
export async function captionEntriesForSavedPlaces(
  savedPlaceIds: readonly string[],
  userId: string,
): Promise<Map<string, CaptionEntry>> {
  const ids = savedPlaceIds.filter((id) => UUID.test(id));
  const out = new Map<string, CaptionEntry>();
  if (ids.length === 0) return out;

  const rows = await query<{ id: string; ordinal: number | null; places: unknown }>(
    `select sp.id, sp.ordinal, r.extracted -> 'places' as places
       from saved_places sp
       join reels r on r.id = sp.reel_id
      where sp.id = any($1::uuid[])
        and sp.ordinal is not null
        and sp.status <> 'rejected'
        and (sp.user_id = $2
             or sp.group_id in (select group_id from group_members where user_id = $2))`,
    [ids, userId],
  );

  for (const row of rows) {
    const entry = pickCaptionEntry(row.ordinal, row.places);
    if (entry) out.set(row.id, entry);
  }
  return out;
}

/** The hours a caption claimed for a place, and the post that claimed them. */
export type HoursClaim = {
  /** Raw and unparsed — `매일 11:00-22:30 금,토 11:00-23:00`. Never a schedule. */
  hours_raw: string;
  /** The reel the claim was read out of. Null when that reel was shared without a URL. */
  source_url: string | null;
};

/**
 * `place_id -> HoursClaim`, for places the CALLER'S USER HAS NOT SAVED.
 *
 * This is the awkward one, so the reasoning is written down rather than left to
 * be rediscovered. `listPlacesNearby` returns rows from `places` that the user
 * has explicitly NOT saved — that is its whole definition — so there is no reel
 * of theirs to read hours from. The only caption that ever described these venues
 * belongs to somebody else's reel.
 *
 * WHAT CROSSES THE USER BOUNDARY, AND WHY IT IS ALLOWED TO. Two strings: the raw
 * hours text, and the Instagram URL it was read from. Both are public content —
 * a caption on a public reel, and the link to that reel. No user id, no handle,
 * no saved-place id, and nothing about WHO saved it. `places` is already a shared
 * table and `listPlacesNearby` already tells you a venue exists because somebody
 * else saved it; this adds a public sentence about that venue and its receipt.
 *
 * `distinct on` takes the most recently shared reel per place. Two creators
 * disagreeing about a café's closing time is ordinary, and the newer claim is the
 * better prior — which is all either of them is.
 */
export async function hoursClaimsForPlaces(
  placeIds: readonly string[],
): Promise<Map<string, HoursClaim>> {
  const ids = placeIds.filter((id) => UUID.test(id));
  const out = new Map<string, HoursClaim>();
  if (ids.length === 0) return out;

  const rows = await query<{
    place_id: string;
    ordinal: number | null;
    places: unknown;
    source_url: string | null;
  }>(
    `select distinct on (sp.place_id)
            sp.place_id, sp.ordinal, r.extracted -> 'places' as places, r.source_url
       from saved_places sp
       join reels r on r.id = sp.reel_id
      where sp.place_id = any($1::uuid[])
        and sp.ordinal is not null
        and sp.status <> 'rejected'
      order by sp.place_id, r.shared_at desc, r.id desc`,
    [ids],
  );

  for (const row of rows) {
    const entry = pickCaptionEntry(row.ordinal, row.places);
    if (entry?.hours_raw) out.set(row.place_id, { hours_raw: entry.hours_raw, source_url: row.source_url });
  }
  return out;
}
