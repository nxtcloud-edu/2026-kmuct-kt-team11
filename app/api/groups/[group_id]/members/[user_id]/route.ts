import { queryOne } from '@/lib/db';
import { withRoute } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { assertGroupMember } from '@/lib/saved-places';

type Ctx = { params: Promise<{ group_id: string; user_id: string }> };

export const DELETE = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id, user_id } = await ctx.params;
  const callerRole = await assertGroupMember(group_id, user.id);

  // Self = leave. Someone else = remove, owner only.
  if (user_id !== user.id && callerRole !== 'owner') throw new ProblemError('forbidden');

  const target = await queryOne<{ role: string }>(
    `select role from group_members where group_id = $1 and user_id = $2`,
    [group_id, user_id],
  );
  if (!target) throw new ProblemError('not-found');

  // A group must always have an owner. The partial unique index guarantees at most one;
  // this guarantees at least one.
  if (target.role === 'owner') {
    const others = await queryOne<{ count: string }>(
      `select count(*)::text as count from group_members where group_id = $1 and user_id <> $2`,
      [group_id, user_id],
    );
    if (Number(others!.count) > 0) throw new ProblemError('last-owner');
  }

  await queryOne(
    `delete from group_members where group_id = $1 and user_id = $2 returning user_id`,
    [group_id, user_id],
  );
  return new Response(null, { status: 204 }) as never;
});
