import { queryOne } from './db';
import { ProblemError } from './problem';

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
 */
export function serialiseSavedPlace(r: SavedPlaceRow) {
  return {
    id: r.id,
    place: r.place_id
      ? {
          id: r.place_id,
          name: r.place_name,
          name_alt: r.place_name_alt ?? [],
          category: r.place_category,
          lat: r.place_lat,
          lng: r.place_lng,
          address: r.place_address,
          area: r.place_area,
        }
      : null,
    group_id: r.group_id,
    status: r.status,
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
