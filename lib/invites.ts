import { query } from './db';
import type { GroupInvite } from './api/types';

/**
 * Invite reads, shared by the route handler and the Server Component that
 * renders the group screen.
 *
 * Both go through `serialiseInvite`, so the shape cannot fork — the same reason
 * `lib/saved-places.ts` keeps `serialiseSavedPlace` in one place. A screen that
 * built its own row would be a second definition of "is this link still open",
 * and that predicate has three inputs.
 */

export type InviteRow = {
  id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  created_by: string;
  created_by_name: string;
  use_count: number;
  last_used_at: Date | null;
};

const INVITE_SELECT = `
  select gi.id, gi.created_at, gi.expires_at, gi.revoked_at,
         gi.created_by, u.display_name as created_by_name,
         (select count(*)::int from group_invite_uses gu where gu.token_hash = gi.token_hash) as use_count,
         (select max(gu.used_at) from group_invite_uses gu where gu.token_hash = gi.token_hash) as last_used_at
    from group_invites gi
    join users u on u.id = gi.created_by`;

/**
 * `status` is computed here rather than left to each caller. Revocation beats
 * expiry in the ordering because it is the deliberate act: a link somebody
 * turned off two days before it would have lapsed should read "turned off", not
 * "expired", or the person who turned it off cannot tell that it worked.
 *
 * No field here is derived from `token_hash`, and none of them can be used to
 * reconstruct a token. That is the whole contract of this serialiser.
 */
export function serialiseInvite(r: InviteRow): GroupInvite {
  const status: GroupInvite['status'] = r.revoked_at
    ? 'revoked'
    : r.expires_at.getTime() <= Date.now()
      ? 'expired'
      : 'live';

  return {
    id: r.id,
    status,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    revoked_at: r.revoked_at?.toISOString() ?? null,
    created_by: { user_id: r.created_by, display_name: r.created_by_name },
    use_count: r.use_count,
    last_used_at: r.last_used_at?.toISOString() ?? null,
  };
}

/**
 * The group's invites for server rendering. Callers must already have asserted
 * membership — this function takes a group id, not a caller, and so cannot do it
 * for them.
 */
export async function listGroupInvites(groupId: string, limit = 50): Promise<GroupInvite[]> {
  const rows = await query<InviteRow>(
    `${INVITE_SELECT} where gi.group_id = $1 order by gi.created_at desc limit $2`,
    [groupId, limit],
  );
  return rows.map(serialiseInvite);
}
