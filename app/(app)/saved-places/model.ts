import type { Place, PlaceCategory, SavedPlace } from '@/lib/api/types';
import { CATEGORY_ORDER, categoryLabel } from '@/lib/categories';

/**
 * The saved-places screen's pure layer: everything that decides what goes where,
 * with no React and no Naver in it.
 *
 * It is separate because all three consumers need the same answers — the map
 * plots them, the list groups them, and the no-key fallback renders the list
 * without a map at all. A grouping computed twice is a grouping that disagrees
 * with itself the first time either copy is edited.
 */

/** A saved row the map can plot. `place` is null while status is 'pending'. */
export type LocatedPlace = SavedPlace & { place: Place };

export function isLocated(saved: SavedPlace): saved is LocatedPlace {
  return saved.place !== null;
}

/* ── Chunking: which 구 is this in? ───────────────────────────────────────── */

const CITY_OR_DISTRICT = /(시|군|구)$/;
const PROVINCE_SUFFIX = /(특별자치시|특별자치도|광역시|특별시|도)$/;

/**
 * The group a saved place belongs to.
 *
 * `place.area` is the 동, and 동 is the wrong axis to chunk on: across eleven
 * real saved places there are eleven distinct 동, so grouping by it produces
 * eleven groups of one, which is not a grouping. The 구 is where the clustering
 * actually is — three of those eleven are 마포구, two are 종로구 — and it is the
 * unit a person plans a day around.
 *
 * It is parsed out of the road address rather than stored, because `places` has
 * no 구 column and inventing one is a migration this screen does not need.
 * The scan starts at index 1: index 0 is the 시/도 and ends in 시 or 도 itself,
 * so including it would file every Seoul address under 서울특별시.
 */
export function districtOf(place: Place): string {
  const parts = place.address?.trim().split(/\s+/) ?? [];
  const district = parts.slice(1).find((part) => CITY_OR_DISTRICT.test(part));
  // Hand-entered rows may carry no address at all. The 동 is a worse group but a
  // true one, and it is the only other thing the row knows about where it is.
  if (!district) return place.area;
  if (parts[0] === '서울특별시') return district;
  // Outside Seoul the 구 alone is a lie by omission: 처인구 means nothing next to
  // 마포구 unless the province is on it. Shortened, because "경기도 용인시" in a
  // 13px group header wraps and "경기 용인시" does not.
  const province = parts[0].replace(PROVINCE_SUFFIX, '');
  return province ? `${province} ${district}` : district;
}

/* ── Distance, and the one place that is 60km away ────────────────────────── */

const KM_PER_DEG_LAT = 111.32;

/** Equirectangular, which is exact enough at city scale and has no branches. */
function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * KM_PER_DEG_LAT;
  const dLng = (a.lng - b.lng) * KM_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Far enough from everything else that including it in the opening camera would
 * zoom the map out until the rest of the pins are one dot. 20km is wider than
 * Seoul is across, so nothing inside the city can trip it.
 */
const FAR_KM = 20;

/**
 * Splits the pins into the cluster the camera should open on and the ones too
 * far away to frame with it.
 *
 * This is the whole answer to the outlier, and it is deliberately not marker
 * clustering: with eleven pins there is no pin-on-pin collision to solve, and
 * Naver's `MarkerClustering` is a separate script from the examples repository —
 * a new dependency for a problem this data does not have. What the data DOES
 * have is one café in 용인, 60km south-east of the other ten, and a naive
 * `fitBounds` over all eleven produces a map of Gyeonggi-do with Seoul as a
 * smudge. So the camera frames the median cluster; the far pin is still plotted,
 * still listed, and still reachable — selecting its row flies the map to it.
 *
 * The median, not the mean: a mean centre is dragged by the very outlier this is
 * trying to exclude.
 */
export function splitByDistance(located: LocatedPlace[]): {
  near: LocatedPlace[];
  far: LocatedPlace[];
} {
  if (located.length < 3) return { near: located, far: [] };

  const centre = {
    lat: median(located.map((s) => s.place.lat)),
    lng: median(located.map((s) => s.place.lng)),
  };

  const near: LocatedPlace[] = [];
  const far: LocatedPlace[] = [];
  for (const saved of located) {
    (kmBetween(saved.place, centre) > FAR_KM ? far : near).push(saved);
  }
  // Every pin being "far" means the set has no cluster to open on — frame them
  // all rather than framing nothing.
  return near.length === 0 ? { near: located, far: [] } : { near, far };
}

/**
 * Below this a single pin fills the frame and tells you nothing about where it
 * is. ~0.012° of latitude is about 1.3km — a walkable neighbourhood, which is
 * the scale at which a saved place has a context. Same constant, same reason, as
 * the home map.
 */
const MIN_SPAN_DEG = 0.012;

export type Box = { south: number; west: number; north: number; east: number };

/** A box around these pins, widened so a one-pin box is not maximum zoom. */
export function boxAround(located: LocatedPlace[]): Box {
  const lats = located.map((s) => s.place.lat);
  const lngs = located.map((s) => s.place.lng);
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const latPad = Math.max(0, MIN_SPAN_DEG - (north - south)) / 2;
  const lngPad = Math.max(0, MIN_SPAN_DEG - (east - west)) / 2;
  return {
    south: south - latPad,
    west: west - lngPad,
    north: north + latPad,
    east: east + lngPad,
  };
}

/* ── Grouping ─────────────────────────────────────────────────────────────── */

export type PlaceGroup = {
  key: string;
  label: string;
  rows: SavedPlace[];
  /** Every row in this group sits outside the opening camera. */
  far: boolean;
};

/**
 * Rows whose place has not resolved yet have no 구 and no pin. The key is not a
 * possible district name, so it cannot collide with a real bucket.
 */
const UNLOCATED_KEY = '__unlocated';

/**
 * Groups by 구, ordered so that both ends of the list are worth reading.
 *
 * Serial position: the first group is the densest one — the 구 where a day out
 * is actually plannable — and the last is whatever is furthest away, which here
 * is the café 60km outside Seoul. The old screen spent the first position on a
 * save date, which is the one thing on the row nobody is looking for.
 */
export function groupPlaces(rows: SavedPlace[], farIds: ReadonlySet<string>): PlaceGroup[] {
  const buckets = new Map<string, PlaceGroup>();

  for (const row of rows) {
    const key = row.place ? districtOf(row.place) : UNLOCATED_KEY;
    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else {
      buckets.set(key, {
        key,
        label: key === UNLOCATED_KEY ? '위치를 확인하는 중' : key,
        rows: [row],
        far: false,
      });
    }
  }

  const groups = [...buckets.values()];
  for (const group of groups) {
    // 가나다 within a group: a group is scanned for a name, and the save order it
    // arrived in carries no information once the rows are already chunked.
    group.rows.sort((a, b) => (a.place?.name ?? '').localeCompare(b.place?.name ?? '', 'ko'));
    group.far = group.key !== UNLOCATED_KEY && group.rows.every((r) => farIds.has(r.id));
  }

  return groups.sort((a, b) => {
    const rank = (g: PlaceGroup) => (g.key === UNLOCATED_KEY ? 2 : g.far ? 1 : 0);
    return (
      rank(a) - rank(b) || b.rows.length - a.rows.length || a.label.localeCompare(b.label, 'ko')
    );
  });
}

/* ── Facets ───────────────────────────────────────────────────────────────── */

export type Facet = { key: PlaceCategory; label: string; count: number };

/**
 * EVERY category the database can hold, in the enum's own order, each with the
 * number of saved rows behind it — zero included.
 *
 * This used to return only the categories present, and the caller dropped the
 * whole row below two. That was the wrong read of "if there is no data behind a
 * line, delete the line". The data behind a chip is not the places; it is the
 * count, and `0` is a count. A row derived from the rows is a row whose
 * membership changes as you save — the chip that was third yesterday is fourth
 * today, and 저장한 곳 stops being a stable place with five kinds of thing in it
 * and becomes a summary of what you happened to keep. Five is what the CHECK
 * constraint allows, five is what the row shows, and the counts say which of
 * them you have actually used.
 *
 * The Hick's Law cost of the four extra chips is real and is paid once: they are
 * in a fixed order, and the ones with nothing behind them are not pressable (see
 * `FacetChips` in `screen.tsx`), so they are read, not weighed.
 */
export function categoryFacets(rows: SavedPlace[]): Facet[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.place) continue;
    counts.set(row.place.category, (counts.get(row.place.category) ?? 0) + 1);
  }
  return CATEGORY_ORDER.map((key) => ({
    key,
    label: categoryLabel(key),
    count: counts.get(key) ?? 0,
  }));
}
