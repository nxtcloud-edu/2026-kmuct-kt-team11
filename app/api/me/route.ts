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
    gender: z.enum(['female', 'male', 'undisclosed']).nullable().optional(),
    age_band: z.enum(['10s', '20s', '30s', '40s', '50plus']).nullable().optional(),
    // Validated here as well as by the CHECK so a typo is a 422 with a field
    // name, not a 500 from a constraint violation.
    mbti: z
      .string()
      .regex(/^[EI][SN][TF][JP]$/, 'Not a valid MBTI type.')
      .nullable()
      .optional(),
    // `true` is the only accepted value. Finishing onboarding is not a thing
    // that un-happens, so there is no `false` for the client to send.
    onboarded: z.literal(true).optional(),
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
        -- Presence boolean plus value, as home_area above: coalesce cannot tell
        -- "clear this field" from "leave it alone", and onboarding needs both —
        -- answering 밝히지 않음 is different from skipping the question.
        gender       = case when $7::boolean  then $8  else gender end,
        age_band     = case when $9::boolean  then $10 else age_band end,
        mbti         = case when $11::boolean then $12 else mbti end,
        -- Only ever set, never cleared: 'onboarded' is a z.literal(true), so
        -- there is no request shape that puts this column back to null. "I
        -- finished onboarding" is not a thing that becomes false.
        -- (No backticks in here: this comment lives inside a JS template literal.)
        onboarded_at = case when $13::boolean then now() else onboarded_at end,
        last_active_at = now()
      where id = $1
  returning id, display_name, avatar_url, email, email_verified_at, igsid, locale,
            home_area, profile_visible_in_groups, plan, gender, age_band, mbti,
            onboarded_at`,
    [
      user.id,
      body.display_name ?? null,
      body.locale ?? null,
      'home_area' in body,
      body.home_area ?? null,
      body.profile_visible_in_groups ?? null,
      'gender' in body,
      body.gender ?? null,
      'age_band' in body,
      body.age_band ?? null,
      'mbti' in body,
      body.mbti ?? null,
      body.onboarded === true,
    ],
  );
  return json(toMe(updated!));
});
