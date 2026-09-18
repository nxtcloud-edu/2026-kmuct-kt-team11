import { queryOne, tx } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { currentUser } from '@/lib/session';
import { hashToken } from '@/lib/tokens';

type Ctx = { params: Promise<{ token: string }> };

/**
 * Where D3 actually bites. An invite joiner has no igsid, so an email is the only thing
 * that can satisfy CHECK (igsid is not null or email is not null). Asking for it here —
 * the one moment the user has a reason to care — is what keeps "no signup form" true for
 * everyone who arrives from Instagram.
 */
export const POST = withRoute(async (_req: Request, ctx: Ctx) => {
  const { token } = await ctx.params;
  const user = await currentUser();

  const invite = await queryOne<{ group_id: string; name: string; member_count: number }>(
    `select gi.group_id, g.name,
            (select count(*)::int from group_members m where m.group_id = gi.group_id) as member_count
       from group_invites gi join groups g on g.id = gi.group_id
      where gi.token_hash = $1 and gi.used_at is null and gi.expires_at > now()`,
    [hashToken(token)],
  );
  if (!invite) throw new ProblemError('invite-invalid');

  if (!user) {
    // The group's name only. Enough to decide whether to hand over an email address,
    // and nothing more — the invite is not yet consumed.
    return json({
      requires: 'recovery_channel',
      group: { id: invite.group_id, name: invite.name, member_count: invite.member_count },
    });
  }

  const already = await queryOne(
    `select user_id from group_members where group_id = $1 and user_id = $2`,
    [invite.group_id, user.id],
  );
  if (already) throw new ProblemError('invite-already-member');

  await tx(async (c) => {
    // Consuming the invite and joining must be atomic: a crash between them would
    // burn a single-use token without granting membership.
    const used = await c.query(
      `update group_invites set used_by = $2, used_at = now()
        where token_hash = $1 and used_at is null returning group_id`,
      [hashToken(token), user.id],
    );
    if (!used.rows.length) throw new ProblemError('invite-invalid');
    await c.query(
      `insert into group_members (group_id, user_id, role) values ($1, $2, 'member')`,
      [invite.group_id, user.id],
    );
  });

  return json({
    group: { id: invite.group_id, name: invite.name, member_count: invite.member_count + 1 },
    role: 'member',
  });
});
