import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { assertGroupMember, serialiseSavedPlace, SAVED_PLACE_SELECT, type SavedPlaceRow } from '@/lib/saved-places';

type Ctx = { params: Promise<{ saved_place_id: string }> };

/**
 * Object-level authorization, api-contract.md §2:
 *   group_id null  → only the owning user may read or write
 *   group_id set   → any member may read; only the row's user or the group owner may write
 */
async function authorise(id: string, userId: string, forWrite: boolean) {
  const row = await queryOne<SavedPlaceRow>(
    `${SAVED_PLACE_SELECT} where sp.id = $1`,
    [id],
  );
  if (!row) throw new ProblemError('not-found');

  if (row.group_id === null) {
    if (row.user_id !== userId) throw new ProblemError('not-found'); // do not confirm existence
    return row;
  }
  const role = await assertGroupMember(row.group_id, userId);
  if (forWrite && row.user_id !== userId && role !== 'owner') throw new ProblemError('forbidden');
  return row;
}

export const GET = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { saved_place_id } = await ctx.params;
  return json(serialiseSavedPlace(await authorise(saved_place_id, user.id, false)));
});

const Body = z.object({
  confirmed: z.boolean().optional(),
  group_id: z.string().uuid().nullish(),
  hook: z.string().max(200).nullish(),
});

export const PATCH = withRoute(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { saved_place_id } = await ctx.params;
  await authorise(saved_place_id, user.id, true);
  const body = Body.parse(await req.json());

  // Moving a row into a group requires membership of the destination, not just the source.
  if (body.group_id) await assertGroupMember(body.group_id, user.id);

  const updated = await queryOne<SavedPlaceRow>(
    `with upd as (
       update saved_places set
         confirmed = coalesce($2, confirmed),
         group_id  = case when $3::boolean then $4::uuid else group_id end,
         hook      = case when $5::boolean then $6 else hook end
        where id = $1 returning *
     )
     ${SAVED_PLACE_SELECT.replace('from saved_places sp', 'from upd sp')}`,
    [saved_place_id, body.confirmed ?? null, 'group_id' in body, body.group_id ?? null,
     'hook' in body, body.hook ?? null],
  );
  return json(serialiseSavedPlace(updated!));
});

export const DELETE = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { saved_place_id } = await ctx.params;
  await authorise(saved_place_id, user.id, true);
  // Hard delete in slice 1. Becomes a 'rejected' transition in slice 4, because a
  // deletion is itself a preference signal.
  await queryOne(`delete from saved_places where id = $1 returning id`, [saved_place_id]);
  return new Response(null, { status: 204 }) as never;
});
