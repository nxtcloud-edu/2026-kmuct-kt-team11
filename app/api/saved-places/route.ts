import { z } from 'zod';
import { query } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';
import { parseLimit, decodeCursor, page } from '@/lib/pagination';
import { withIdempotency } from '@/lib/idempotency';
import { assertGroupMember, serialiseSavedPlace, SAVED_PLACE_SELECT, type SavedPlaceRow } from '@/lib/saved-places';

export const GET = withRoute(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = decodeCursor(url.searchParams.get('cursor'));
  const groupParam = url.searchParams.get('group_id');
  const statuses = url.searchParams.getAll('status');
  const confirmed = url.searchParams.get('confirmed');

  // Object-level authorization: asking for a group's saved places requires membership.
  // Route-level auth would let any signed-in user read any group.
  if (groupParam && groupParam !== 'all') await assertGroupMember(groupParam, user.id);

  const rows = await query<SavedPlaceRow>(
    `${SAVED_PLACE_SELECT}
      where (
              -- personal rows, always the caller's own
              ($2::text is null and sp.group_id is null and sp.user_id = $1)
              -- one group the caller belongs to
           or ($2::text is not null and $2 <> 'all' and sp.group_id = $2::uuid)
              -- everything the caller can see: their own, plus their groups'
           or ($2 = 'all' and (sp.user_id = $1 or sp.group_id in
                 (select group_id from group_members where user_id = $1)))
            )
        and ( cardinality($3::text[]) = 0 and sp.status <> 'rejected'
              or sp.status = any($3::text[]) )
        and ($4::boolean is null or sp.confirmed = $4::boolean)
        and ($5::timestamptz is null
             or (sp.saved_at, sp.id) < ($5::timestamptz, $6::uuid))
   order by sp.saved_at desc, sp.id desc
      limit $7`,
    [user.id, groupParam, statuses, confirmed === null ? null : confirmed === 'true',
     cursor?.saved_at ?? null, cursor?.id ?? null, limit + 1],
  );

  const p = page(rows, limit);
  return json({ data: p.data.map(serialiseSavedPlace), next_cursor: p.next_cursor, has_more: p.has_more });
});

const Body = z.object({
  place_id: z.string().uuid(),
  group_id: z.string().uuid().nullish(),
  hook: z.string().max(200).nullish(),
});

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const raw = await req.json();
  const body = Body.parse(raw);

  if (body.group_id) await assertGroupMember(body.group_id, user.id);

  const place = await queryOne<{ id: string }>(`select id from places where id = $1`, [body.place_id]);
  if (!place) throw new ProblemError('not-found', { detail: 'No such place.' });

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, raw, async () => {
    // Slice 1 has no extractor, so a hand-entered row is born resolved rather than
    // pending. reel_video_id stays null — see the partial unique index in the migration
    // for why that does not make duplicates possible.
    const created = await queryOne<SavedPlaceRow>(
      `with ins as (
         insert into saved_places (user_id, group_id, place_id, hook, status, confirmed)
         values ($1, $2, $3, $4, 'resolved', true)
         returning *
       )
       ${SAVED_PLACE_SELECT.replace('from saved_places sp', 'from ins sp')}`,
      [user.id, body.group_id ?? null, body.place_id, body.hook ?? null],
    );
    return { status: 201, body: serialiseSavedPlace(created!) };
  });
});
