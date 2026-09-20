import { query } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { parseLimit } from '@/lib/pagination';
import { ProblemError } from '@/lib/problem';

/**
 * Search before create. Slice 1 has no extractor, so duplicates are created by hand —
 * which makes the search box the first line of defence, not the merge tool.
 */
export const GET = withRoute(async (req: Request) => {
  await requireUser();
  const url = new URL(req.url);
  const q = url.searchParams.get('q');
  if (!q) {
    throw new ProblemError('validation-error', {
      errors: [{ field: 'q', message: 'Required.' }],
    });
  }
  const limit = parseLimit(url.searchParams.get('limit'));
  const lat = url.searchParams.get('near_lat');
  const lng = url.searchParams.get('near_lng');
  const near = lat !== null && lng !== null;

  const rows = await query(
    `select id, name, name_alt, category, lat, lng, address, area,
            case when $4::boolean
                 then round(earth_distance_m($2::float8, $3::float8, lat, lng))
                 else null end as distance_m
       from places
      where name % $1 or $1 = any(name_alt)
   order by case when $4::boolean then earth_distance_m($2::float8, $3::float8, lat, lng)
                 else 0 end asc,
            similarity(name, $1) desc
      limit $5`,
    [q, lat ?? 0, lng ?? 0, near, limit],
  );

  return json({ data: rows, next_cursor: null, has_more: false });
});
