import { query, queryOne } from './db';
import { hashToken } from './tokens';
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

/* ── Preview ──────────────────────────────────────────────────────────────── */

/**
 * What `/invite/{token}` shows before anyone joins.
 *
 * Shared by the landing page and `app/api/invites/[token]/route.ts` for the same
 * reason `serialiseInvite` is shared: "is this link still open" has three inputs
 * and two callers deriving it independently is how they come to disagree. The
 * page is a Server Component and reads Postgres directly — it does not fetch our
 * own route handler — so without this the predicate would exist twice.
 *
 * Returns a state rather than throwing. The route turns a failed state into its
 * problem document; the page turns the same state into a screen. Those are
 * different jobs and only one of them is an error.
 *
 * WHAT IS AND IS NOT DISCLOSED. A live invite yields the group's name and its
 * counts, which is precisely what the sharer meant to disclose by sending the
 * link. An expired or revoked one yields neither — revocation exists because a
 * link reached someone it should not have, and naming the group would hand that
 * person the thing the revocation was meant to take back.
 */
export type InvitePreview =
  | {
      state: 'live';
      group: { id: string; name: string; member_count: number; place_count: number };
      expires_at: string;
      already_member: boolean;
    }
  | { state: 'invalid' | 'expired' | 'revoked' };

export async function previewInvite(
  token: string,
  userId: string | null,
): Promise<InvitePreview> {
  const invite = await queryOne<{
    group_id: string;
    name: string;
    member_count: number;
    place_count: number;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `select gi.group_id, g.name, gi.expires_at, gi.revoked_at,
            (select count(*)::int from group_members m where m.group_id = gi.group_id) as member_count,
            (select count(*)::int from saved_places sp
              where sp.group_id = gi.group_id and sp.status <> 'rejected') as place_count
       from group_invites gi join groups g on g.id = gi.group_id
      where gi.token_hash = $1`,
    [hashToken(token)],
  );

  // No row at all. Not "expired" — saying "expired" about a string nobody ever
  // issued would tell a guesser that the shape of their guess was right.
  if (!invite) return { state: 'invalid' };
  // Revoked beats expired, the same ordering `serialiseInvite` uses: a link
  // somebody turned off should say so rather than blaming the calendar.
  if (invite.revoked_at) return { state: 'revoked' };
  if (invite.expires_at.getTime() <= Date.now()) return { state: 'expired' };

  const already = userId
    ? await queryOne(`select user_id from group_members where group_id = $1 and user_id = $2`, [
        invite.group_id,
        userId,
      ])
    : null;

  return {
    state: 'live',
    group: {
      id: invite.group_id,
      name: invite.name,
      member_count: invite.member_count,
      place_count: invite.place_count,
    },
    expires_at: invite.expires_at.toISOString(),
    already_member: already !== null,
  };
}
