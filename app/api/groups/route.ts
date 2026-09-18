import { z } from 'zod';
import { query, tx } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { parseLimit } from '@/lib/pagination';
import { withIdempotency } from '@/lib/idempotency';

export const GET = withRoute(async (req: Request) => {
  const user = await requireUser();
  const limit = parseLimit(new URL(req.url).searchParams.get('limit'));
  const rows = await query(
    `select g.id, g.name, gm.role,
            (select count(*)::int from group_members m where m.group_id = g.id) as member_count
       from groups g
       join group_members gm on gm.group_id = g.id and gm.user_id = $1
   order by g.created_at desc
      limit $2`,
    [user.id, limit + 1],
  );
  const has_more = rows.length > limit;
  return json({ data: has_more ? rows.slice(0, limit) : rows, next_cursor: null, has_more });
});

const Body = z.object({ name: z.string().min(1).max(120) });

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const raw = await req.json();
  const body = Body.parse(raw);

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, raw, async () => {
    const group = await tx(async (c) => {
      const g = await c.query<{ id: string; name: string; created_at: Date }>(
        `insert into groups (name, created_by) values ($1, $2) returning id, name, created_at`,
        [body.name, user.id],
      );
      await c.query(
        `insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
        [g.rows[0].id, user.id],
      );
      return g.rows[0];
    });

    return {
      status: 201,
      body: {
        id: group.id,
        name: group.name,
        role: 'owner',
        members: [{
          user_id: user.id, display_name: user.display_name, avatar_url: user.avatar_url,
          role: 'owner', joined_at: group.created_at.toISOString(),
        }],
        created_at: group.created_at.toISOString(),
      },
    };
  });
});
