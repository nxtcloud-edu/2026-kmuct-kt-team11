import { queryOne } from './db';
import type { Place, PlaceCategory } from './api/types';

/**
 * Find-or-create against `places`, and the ONE implementation of place identity.
 *
 * Lifted out of `POST /api/places` when the reel resolver needed the same thing
 * (lib/research/resolve-place.ts). Two copies of this would be two answers to
 * "is this the same café?", and design §5.1 calls place identity the
 * highest-bug-density area of the model — a second implementation drifting from
 * the first is how the user ends up with 어니언 성수 twice, one saved by hand and
 * one extracted from a reel, and the planner double-books the afternoon.
 */

/** ~50 m. Two doors of the same building, not two cafés on the same street. */
const DEDUPE_RADIUS_M = 50;

/**
 * trigram similarity, not equality. `어니언 성수` and `어니언성수점` are the same
 * venue written by two people; 0.45 is loose enough to catch that and tight
 * enough that two unrelated cafés 30 m apart do not collapse into one.
 */
const NAME_SIMILARITY = 0.45;

export type PlaceInput = {
  name: string;
  name_alt?: string[];
  category: PlaceCategory;
  lat: number;
  lng: number;
  address?: string | null;
  area: string;
};

export type FoundOrCreatedPlace = {
  place: Place;
  /** True when an existing row was returned rather than a new one written. */
  matched: boolean;
};

/**
 * Dedupe at the write boundary (spec §5.1): geocode-plus-fuzzy-name inside ~50 m.
 * Catching duplicates as they are created is far cheaper than merging them later.
 *
 * Not idempotent by itself under concurrency — two callers geocoding the same
 * address at the same moment both miss the select and both insert. That is the
 * pre-existing behaviour of `POST /api/places` and is left alone here: the route
 * is protected by `Idempotency-Key`, and the reel path writes places one at a
 * time (lib/research/resolve-place.ts), so neither caller races itself.
 */
export async function findOrCreatePlace(input: PlaceInput): Promise<FoundOrCreatedPlace> {
  const match = await queryOne<Place>(
    `select id, name, name_alt, category, lat, lng, address, area
       from places
      where earth_box_contains($1, $2, $3, lat, lng)
        and similarity(name, $4) > $5
   order by similarity(name, $4) desc
      limit 1`,
    [input.lat, input.lng, DEDUPE_RADIUS_M, input.name, NAME_SIMILARITY],
  );
  if (match) return { place: match, matched: true };

  const created = await queryOne<Place>(
    `insert into places (name, name_alt, category, lat, lng, address, area)
     values ($1, $2, $3, $4, $5, $6, $7)
 returning id, name, name_alt, category, lat, lng, address, area`,
    [
      input.name,
      input.name_alt ?? [],
      input.category,
      input.lat,
      input.lng,
      input.address ?? null,
      input.area,
    ],
  );
  // `insert ... returning` over a table with no partial-index conflict returns a
  // row or throws; the non-null assertion is the shape of queryOne, not a guess.
  return { place: created!, matched: false };
}
