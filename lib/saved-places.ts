import { query, queryOne } from './db';
import { ProblemError } from './problem';
import type { PlaceCategory, SavedPlace, SavedPlaceStatus } from './api/types';

export type SavedPlaceRow = {
  id: string;
  user_id: string;
  group_id: string | null;
  status: string;
  confirmed: boolean;
  hook: string | null;
  source_url: string | null;
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

export const SAVED_PLACE_SELECT = `
  select sp.id, sp.user_id, sp.group_id, sp.status, sp.confirmed, sp.hook, sp.source_url, sp.saved_at,
         p.id as place_id, p.name as place_name, p.name_alt as place_name_alt,
         p.category as place_category, p.lat as place_lat, p.lng as place_lng,
         p.address as place_address, p.area as place_area
    from saved_places sp
    left join places p on p.id = sp.place_id`;

/**
 * `place` is null while status is 'pending' — the row exists before resolution by design
 * (spec §5.2). Slice 1 never produces a pending row, but the client handles null from the
 * start so slice 3 does not require a client rewrite.
 *
 * `extracted` and `raw_caption` are deliberately never returned: extractor internals with
 * no client use.
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
  return query<{ id: string; name: string; category: string; area: string }>(
    `select p.id, p.name, p.category, p.area
       from places p
      where p.area = $1
        and not exists (select 1 from saved_places sp
                         where sp.place_id = p.id and sp.user_id = $2)
      order by p.created_at desc
      limit $3`,
    [area, userId, limit],
  );
}
