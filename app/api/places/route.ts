import { z } from 'zod';
import { withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { withIdempotency } from '@/lib/idempotency';
import { findOrCreatePlace } from '@/lib/places';

const Body = z.object({
  name: z.string().min(1).max(200),
  name_alt: z.array(z.string()).optional(),
  category: z.enum(['cafe', 'restaurant', 'exhibition', 'shop', 'activity']),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(300).nullish(),
  // Client-supplied and required on this route. Slice 2's server-side resolution
  // (lib/research/resolve-place.ts) derives it from the geocoder instead, but
  // this route's callers hand-enter a place and have no address to derive from —
  // making it optional here would be a contract change, not a cleanup.
  area: z.string().min(1).max(80),
});

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const raw = await req.json();
  const body = Body.parse(raw);

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, raw, async () => {
    // The ~50 m + fuzzy-name dedupe lives in lib/places.ts, because the reel
    // resolver needs the same one. Two implementations of place identity is two
    // answers to "is this the same café?" — see the note there.
    const { place, matched } = await findOrCreatePlace({
      name: body.name,
      name_alt: body.name_alt,
      category: body.category,
      lat: body.lat,
      lng: body.lng,
      address: body.address,
      area: body.area,
    });

    return matched
      ? { status: 200, body: { ...place, matched: true } }
      : { status: 201, body: place };
  });
});
