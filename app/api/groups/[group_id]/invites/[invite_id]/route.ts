import { queryOne } from '@/lib/db';
import { withRoute } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { assertGroupMember } from '@/lib/saved-places';

type Ctx = { params: Promise<{ group_id: string; invite_id: string }> };

/**
 * Turn a link off.
 *
 * This is the control that makes a reusable link defensible. Before
 * 20260920000010 an invite closed itself after one use, so the blast radius of a
 * link pasted into the wrong 단톡방 was one stranger; now it is everyone in that
 * room for up to seven days. Expiry is not an answer to that — it is a window
 * you cannot close early — so revocation is not a nicety here, it is the other
 * half of the feature.
 *
 * WHO. The owner, or whoever minted this particular link. Any member may invite,
 * so restricting revocation to the owner would leave a member able to open a
 * door they cannot close; and letting any member revoke any other member's link
 * hands a stranger-who-joined the ability to cut off the invitation that is
 * still bringing the rest of the group's friends in.
 *
 * Deliberately a soft delete. The row stays so that `group_invite_uses` keeps
 * its foreign key and the group can still answer "who came in through what",
 * which is the fact a hard delete would destroy at exactly the moment — someone
 * is revoking because something went wrong — that it is most worth having.
 */
export const DELETE = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id, invite_id } = await ctx.params;
  const role = await assertGroupMember(group_id, user.id);

  // Scoped by `group_id` as well as `id`: the membership check above is about
  // this group, so a lookup by id alone would let a member of group A revoke an
  // invite belonging to group B (OWASP API1 — see docs/gaja/api-contract.md §2).
  const invite = await queryOne<{ created_by: string; revoked_at: Date | null }>(
    `select created_by, revoked_at from group_invites where id = $1 and group_id = $2`,
    [invite_id, group_id],
  );
  if (!invite) throw new ProblemError('not-found');
  if (role !== 'owner' && invite.created_by !== user.id) throw new ProblemError('forbidden');

  // `revoked_at is null` in the predicate, so revoking twice keeps the first
  // timestamp and the first revoker rather than rewriting history on a double
  // tap. Both calls still answer 204: the caller asked for the link to be off,
  // and it is off.
  await queryOne(
    `update group_invites set revoked_at = now(), revoked_by = $3
      where id = $1 and group_id = $2 and revoked_at is null
  returning id`,
    [invite_id, group_id, user.id],
  );

  return new Response(null, { status: 204 }) as never;
});
