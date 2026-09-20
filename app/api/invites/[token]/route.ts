import { queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { currentUser } from '@/lib/session';
import { hashToken } from '@/lib/tokens';

type Ctx = { params: Promise<{ token: string }> };

/**
 * Look before you join.
 *
 * `/invite/{token}` needs to render a decision — this group, these many people,
 * this is what you will be able to see — and the accept endpoint cannot serve
 * that, because for a signed-in caller accepting IS joining. A preview with no
 * side effect is the only way the landing page can show an access-scope summary
 * *before* the confirm rather than after it.
 *
 * Unauthenticated on purpose: the whole point of the flow is that a friend opens
 * this link before they have an account. The token is the credential.
 *
 * WHAT IS AND IS NOT DISCLOSED. A live invite yields the group's name and member
 * count, which is precisely what the sharer meant to disclose by sending the
 * link. An expired or revoked one yields neither. That asymmetry is deliberate:
 * revocation exists because a link reached someone it should not have, and
 * answering that person with the group's name would hand them the thing the
 * revocation was meant to take back. They get the state and nothing else.
 */
export const GET = withRoute(async (_req: Request, ctx: Ctx) => {
  const { token } = await ctx.params;
  const user = await currentUser();

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
  if (!invite) throw new ProblemError('invite-invalid');
  if (invite.revoked_at) throw new ProblemError('invite-revoked');
  if (invite.expires_at.getTime() <= Date.now()) throw new ProblemError('invite-expired');

  const already = user
    ? await queryOne(`select user_id from group_members where group_id = $1 and user_id = $2`, [
        invite.group_id,
        user.id,
      ])
    : null;

  return json({
    group: {
      id: invite.group_id,
      name: invite.name,
      member_count: invite.member_count,
      place_count: invite.place_count,
    },
    expires_at: invite.expires_at.toISOString(),
    // Drives the "you are already in here" branch on the landing page, which is
    // a different screen from an error: the remedy is a link into the group, not
    // a request for a new invite.
    already_member: already !== null,
    // Every invite grants the same thing. The schema's `owner` role is held by
    // exactly one person per group and is enforced by a partial unique index
    // (`group_members_one_owner_idx`), so there is no role for an invite to
    // choose between — see the note in the accept route.
    grants: 'member' as const,
  });
});
