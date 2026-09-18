import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { assertGroupMember, assertGroupOwner } from '@/lib/saved-places';

type Ctx = { params: Promise<{ group_id: string }> };

async function serialise(groupId: string, role: string) {
  const g = await queryOne<{ id: string; name: string; created_at: Date }>(
    `select id, name, created_at from groups where id = $1`, [groupId],
  );
  if (!g) throw new ProblemError('not-found');
  const members = await query(
    `select gm.user_id, u.display_name, u.avatar_url, gm.role, gm.joined_at
       from group_members gm join users u on u.id = gm.user_id
      where gm.group_id = $1 order by gm.joined_at`,
    [groupId],
  );
  return { id: g.id, name: g.name, role, members, created_at: g.created_at.toISOString() };
}

export const GET = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  const role = await assertGroupMember(group_id, user.id);
  return json(await serialise(group_id, role));
});

export const PATCH = withRoute(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  await assertGroupOwner(group_id, user.id);
  const { name } = z.object({ name: z.string().min(1).max(120) }).parse(await req.json());
  await queryOne(`update groups set name = $2 where id = $1 returning id`, [group_id, name]);
  return json(await serialise(group_id, 'owner'));
});

export const DELETE = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  await assertGroupOwner(group_id, user.id);
  // Saved places are NOT deleted — the FK is `on delete set null`, so they revert to
  // personal. Deleting a group must never destroy what people saved into it.
  await queryOne(`delete from groups where id = $1 returning id`, [group_id]);
  return new Response(null, { status: 204 }) as never;
});
