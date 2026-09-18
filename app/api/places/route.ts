import { z } from 'zod';
import { queryOne } from '@/lib/db';
import { withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { withIdempotency } from '@/lib/idempotency';

const Body = z.object({
  name: z.string().min(1).max(200),
  name_alt: z.array(z.string()).optional(),
  category: z.enum(['cafe', 'restaurant', 'exhibition', 'shop', 'activity']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(300).nullish(),
  // Client-supplied and required in slice 1 — there is no geocoder until slice 2's
  // Kakao adapter. Slice 2 makes this optional and server-resolves it, which is a
  // loosening and therefore non-breaking.
  area: z.string().min(1).max(80),
});

type Place = {
  id: string; name: string; name_alt: string[]; category: string;
  lat: number; lng: number; address: string | null; area: string;
};

const DEDUPE_RADIUS_M = 50;
const NAME_SIMILARITY = 0.45;

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const raw = await req.json();
  const body = Body.parse(raw);

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, raw, async () => {
    // Dedupe at the write boundary (spec §5.1). Geocode-plus-fuzzy-name inside ~50 m.
    // Catching duplicates as they are created is far cheaper than merging them later,
    // and §5.1 calls place identity the highest-bug-density area of the model.
    const match = await queryOne<Place>(
      `select id, name, name_alt, category, lat, lng, address, area
         from places
        where earth_box_contains($1, $2, $3, lat, lng)
          and similarity(name, $4) > $5
     order by similarity(name, $4) desc
        limit 1`,
      [body.lat, body.lng, DEDUPE_RADIUS_M, body.name, NAME_SIMILARITY],
    );
    if (match) return { status: 200, body: { ...match, matched: true } };

    const created = await queryOne<Place>(
      `insert into places (name, name_alt, category, lat, lng, address, area)
       values ($1, $2, $3, $4, $5, $6, $7)
   returning id, name, name_alt, category, lat, lng, address, area`,
      [body.name, body.name_alt ?? [], body.category, body.lat, body.lng,
       body.address ?? null, body.area],
    );
    return { status: 201, body: created };
  });
});
