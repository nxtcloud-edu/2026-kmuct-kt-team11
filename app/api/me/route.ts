import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { requireUser, toMe, type SessionUser } from '@/lib/session';

export const GET = withRoute(async () => json(toMe(await requireUser())));

// Unknown fields are ignored rather than rejected, so the client may send its whole model.
const Body = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    locale: z.enum(['ko', 'en']).optional(),
    home_area: z.string().max(80).nullable().optional(),
    profile_visible_in_groups: z.boolean().optional(),
  })
  .passthrough();

export const PATCH = withRoute(async (req: Request) => {
  const user = await requireUser();
  const body = Body.parse(await req.json());

  const updated = await queryOne<SessionUser>(
    `update users set
        display_name = coalesce($2, display_name),
        locale       = coalesce($3, locale),
        home_area    = case when $4::boolean then $5 else home_area end,
        profile_visible_in_groups = coalesce($6, profile_visible_in_groups),
        last_active_at = now()
      where id = $1
  returning id, display_name, avatar_url, email, email_verified_at, igsid, locale,
            home_area, profile_visible_in_groups, plan`,
    [
      user.id,
      body.display_name ?? null,
      body.locale ?? null,
      'home_area' in body,
      body.home_area ?? null,
      body.profile_visible_in_groups ?? null,
    ],
  );
  return json(toMe(updated!));
});
