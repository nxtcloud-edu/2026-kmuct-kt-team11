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
