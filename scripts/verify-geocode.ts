/**
 * The assertions for scripts/verify-geocode.sh. Run that, not this — the shell
 * script is what loads the NCP credentials and refuses to run without them.
 *
 * MAKES REAL REQUESTS to the Naver Geocoding API, against the four addresses
 * lib/extract/__fixtures__ and docs/gaja/reel-extraction-findings.md take from a
 * real reel caption. A fixture would prove the parser and nothing else; the thing
 * that was broken was the credential and the product enablement behind it, and
 * only a live call can tell you it is fixed.
 *
 * NOTHING HERE TOUCHES THE DATABASE. Geocoding is a pure read of an external API;
 * the write path it feeds is already covered by scripts/verify-reel-ingest.sh.
 */
import { geocodeAddress, GeocoderNotConfiguredError } from '../lib/research/geocode';

/**
 * Seoul's bounding box, generously drawn: the city spans roughly 37.43–37.70 N
 * and 126.76–127.18 E.
 *
 * THE POINT OF THIS ASSERTION IS THE SWAP. Naver returns x=longitude, y=latitude,
 * which is the reverse of every `lat,lng` in this codebase. Read them the wrong
 * way round and a 망원동 café lands at 126.90 N 37.56 E — in the Yellow Sea, off
 * Shandong — which passes every CHECK constraint on `places` and renders as a
 * perfectly ordinary dot on a map. These four numbers are the only thing standing
 * between that bug and production.
 */
const SEOUL = { latMin: 37.4, latMax: 37.7, lngMin: 126.8, lngMax: 127.2 };

/**
 * Real addresses from one real reel caption. Deliberately BOTH forms: the first
 * four are 도로명, the last is the 지번 the findings doc records for the same venue
 * as `서울 용산구 후암로40길 3`. Both must geocode, and the pair must land on the
 * same point — that is the whole "address formats differ" finding, tested.
 */
const ADDRESSES = [
  '서울 광진구 아차산로78길 110',
  '서울 마포구 망원로3길 7',
  '서울 중구 명동4길 16',
  '서울 용산구 후암로40길 3',
];
const JIBUN_OF_LAST = '서울 용산구 후암동 2-1';

/** Not a real address, and not a typo of one. Must come back null, not throw. */
const NONSENSE = '서울 없는구 존재하지않는로999길 9999';

let failures = 0;

function ok(what: string, pass: boolean, detail = '') {
  if (pass) {
    console.log(`  ok   ${what}`);
  } else {
    failures += 1;
    console.log(`  ✗    ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

function plausiblySeoul(lat: number, lng: number): boolean {
  return lat >= SEOUL.latMin && lat <= SEOUL.latMax && lng >= SEOUL.lngMin && lng <= SEOUL.lngMax;
}

async function main() {
  console.log('\n1 — the caption addresses geocode to plausible Seoul coordinates');

  const points: Record<string, { lat: number; lng: number }> = {};

  for (const address of ADDRESSES) {
    const point = await geocodeAddress(address);
    if (!point) {
      failures += 1;
      console.log(`  ✗    ${address} — returned null; the address did not resolve`);
      continue;
    }
    points[address] = { lat: point.lat, lng: point.lng };
    console.log(
      `       ${address}\n` +
        `         -> lat ${point.lat}  lng ${point.lng}  area ${point.area ?? '(none)'}\n` +
        `            ${point.roadAddress}`,
    );
    ok(
      `${address} is inside Seoul`,
      plausiblySeoul(point.lat, point.lng),
      `lat ${point.lat} lng ${point.lng} — if lat looks like 126.x the x/y read is swapped`,
    );
    ok(`${address} yielded an area for places.area`, Boolean(point.area));
  }

  console.log('\n2 — 지번 and 도로명 are the same venue');
  const jibun = await geocodeAddress(JIBUN_OF_LAST);
  ok('the jibun form resolves at all', jibun !== null);
  if (jibun) {
    console.log(`       ${JIBUN_OF_LAST}\n         -> lat ${jibun.lat}  lng ${jibun.lng}`);
    const road = points['서울 용산구 후암로40길 3'];
    // Metres, not degrees: ~30 m is generous for "the geocoder put the road-name
    // form and the lot-number form of one address on the same building".
    const apart = road ? haversineM(road.lat, road.lng, jibun.lat, jibun.lng) : Infinity;
    ok(
      'jibun and 도로명 land within 30 m of each other',
      apart <= 30,
      `${Math.round(apart)} m apart`,
    );
  }

  console.log('\n3 — an address that does not exist');
  // The outcome the adapter must NOT treat as an error: some caption addresses
  // are simply wrong, and the candidate has to save unresolved rather than take
  // the reel down with it.
  let threw = false;
  let nonsense: Awaited<ReturnType<typeof geocodeAddress>> = null;
  try {
    nonsense = await geocodeAddress(NONSENSE);
  } catch {
    threw = true;
  }
  ok('does not throw', !threw);
  ok('returns null rather than a wrong point', nonsense === null);

  console.log(failures === 0 ? '\nall assertions passed\n' : `\n${failures} assertion(s) failed\n`);
}

/** Same formula as `earth_distance_m` in 20260918000001, so the two agree. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  return (
    6371000 *
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin(rad(lat2 - lat1) / 2) ** 2 +
          Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2,
      ),
    )
  );
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((e) => {
    if (e instanceof GeocoderNotConfiguredError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  });
