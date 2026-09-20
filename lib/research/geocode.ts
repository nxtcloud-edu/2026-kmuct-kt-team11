/**
 * Naver (NCP) Geocoding: a Korean street address in, coordinates out.
 *
 * SERVER ONLY. `NAVER_MAP_CLIENT_SECRET` is a real secret and must never be
 * prefixed `NEXT_PUBLIC_`, never be imported from a client component, never be
 * logged and never appear in a problem response — the same rule `.env.example`
 * and lib/extract/caption.ts already state for their own keys. Next only inlines
 * `NEXT_PUBLIC_*` into the browser bundle (see
 * next/dist/docs/01-app/02-guides/environment-variables.md), so an accidental
 * import into client code yields `undefined` rather than a leak — but it yields a
 * geocoder that silently cannot authenticate, which is its own bug. Keep this
 * module behind lib/, where nothing under app/ imports it directly.
 *
 * WHY this exists now: `place.address` was the one field the caption reliably
 * carried (docs/gaja/reel-extraction-findings.md — "Address beats name
 * matching"), and nothing could turn it into a `places` row, so every reel
 * ingested with `place_id = null`. This is the missing step.
 *
 * WHY Naver rather than Kakao, which the slice-2 notes name: the addresses come
 * out of Korean captions in both 도로명 and 지번 form, the project already holds
 * NCP credentials for the map, and this endpoint accepts both forms — verified
 * live against 서울 용산구 후암동 2-1, which returns the same venue the findings doc
 * records as 서울 용산구 후암로40길 3.
 */

const ENDPOINT = 'https://maps.apigw.ntruss.com/map-geocode/v2/geocode';

/** Nothing hangs forever. An unbounded fetch holds a function until the platform kills it. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Neither credential is set, so no request was attempted. A deployment mistake, not a data one. */
export class GeocoderNotConfiguredError extends Error {
  constructor(variable: string) {
    // Names the variable, never the value — an error message is the most likely
    // place a secret escapes, because it is the one string that gets logged.
    super(`${variable} is not set; lib/research/geocode.ts cannot call the Naver Geocoding API.`);
    this.name = 'GeocoderNotConfiguredError';
  }
}

/**
 * The request did not produce an answer: transport failure, timeout, 401 from a
 * key that is not enabled for Geocoding, 429, a 5xx.
 *
 * Deliberately a different outcome from `null`. "This address does not exist"
 * and "we could not ask" look identical to a caller that collapses them, and the
 * first is a fact about the caption while the second is a fact about us.
 */
export class GeocodeRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GeocodeRequestError';
  }
}

export type GeocodedAddress = {
  lat: number;
  lng: number;
  /** The canonical 도로명 address Naver echoes back, not the string that was asked about. */
  roadAddress: string;
  /** The 지번 form of the same point, when Naver has one. */
  jibunAddress: string | null;
  /**
   * `places.area`, derived — the 동 (`망원동`), falling back to the 구 (`마포구`).
   *
   * Read off `addressElements` rather than sliced out of the address string:
   * the element carries its own type, while a regex over `서울특별시 마포구 망원로3길 7`
   * has to guess which token is which and gets 세종특별자치시, which has no 구, wrong.
   */
  area: string | null;
};

type NaverAddress = {
  roadAddress?: string;
  jibunAddress?: string;
  addressElements?: { types?: string[]; longName?: string }[];
  x?: string;
  y?: string;
};

/**
 * Geocode one address.
 *
 * Returns `null` when the API answers `status: "OK"` with zero addresses. That is
 * a real and expected outcome, not an error: caption addresses are typed by a
 * creator and some of them are wrong, abbreviated or a neighbourhood rather than
 * a street. The caller saves the candidate unresolved and moves on.
 *
 * Throws `GeocodeRequestError` when the answer could not be obtained at all, and
 * `GeocoderNotConfiguredError` when either credential is missing. Credentials are
 * read per call rather than at module scope so that `next build`, which imports
 * any module a route references, does not require them to be present at build time.
 */
export async function geocodeAddress(address: string): Promise<GeocodedAddress | null> {
  const query = address.trim();
  if (!query) return null;

  // The map's public client ID doubles as the API gateway key id — one NCP
  // application, two products. This is the only place the public ID is used
  // server-side; it is still not a secret, and the secret below still is.
  const keyId = process.env.NEXT_PUBLIC_NAVER_MAP_CLIENT_ID;
  if (!keyId) throw new GeocoderNotConfiguredError('NEXT_PUBLIC_NAVER_MAP_CLIENT_ID');
  const key = process.env.NAVER_MAP_CLIENT_SECRET;
  if (!key) throw new GeocoderNotConfiguredError('NAVER_MAP_CLIENT_SECRET');

  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-ncp-apigw-api-key-id': keyId,
        'x-ncp-apigw-api-key': key,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GeocodeRequestError(
      `naver geocode request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!res.ok) {
    // 401 here is the specific failure this adapter was blocked on for weeks: a
    // valid map key whose NCP application has no Geocoding product enabled
    // authenticates the map fine and rejects this call. Saying the status out
    // loud is what makes that diagnosable; the body may repeat the key id, so it
    // is not included.
    throw new GeocodeRequestError(`naver geocode returned ${res.status}`, res.status);
  }

  let payload: { status?: string; addresses?: NaverAddress[]; errorMessage?: string };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new GeocodeRequestError('naver geocode returned a body that was not JSON');
  }

  if (payload.status !== 'OK') {
    // `status` is the API's own verdict and is not always mirrored in the HTTP
    // code — a 200 can carry INVALID_REQUEST or SYSTEM_ERROR.
    throw new GeocodeRequestError(`naver geocode status ${payload.status ?? 'missing'}`);
  }

  const first = payload.addresses?.[0];
  // `status: "OK"` with an empty array. The address is simply not findable.
  if (!first) return null;

  // ──────────────────────────────────────────────────────────────────────────
  // x IS LONGITUDE AND y IS LATITUDE, IN THAT ORDER, AND BOTH ARE STRINGS.
  //
  // That is the reverse of the `lat,lng` convention every other coordinate in
  // this codebase uses — `places.lat`/`places.lng`, `earth_box_contains`,
  // POST /api/places. Naver follows the x=east, y=north convention of a plane.
  // Read them the obvious way round and every Seoul venue lands near 126.9°N
  // 37.5°E, which is in the Yellow Sea off the coast of Shandong: still valid
  // coordinates, still inside the CHECK constraints on `places`, still plotting
  // as points on a map. Nothing catches it but a human looking at the map.
  //
  // Verified live: 서울 마포구 망원로3길 7 → x 126.9014508, y 37.5570789.
  // ──────────────────────────────────────────────────────────────────────────
  const lng = Number(first.x);
  const lat = Number(first.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new GeocodeRequestError('naver geocode returned coordinates that are not numbers');
  }

  return {
    lat,
    lng,
    roadAddress: first.roadAddress || first.jibunAddress || query,
    jibunAddress: first.jibunAddress || null,
    area: areaFrom(first.addressElements),
  };
}

/** `DONGMYUN` (망원동) if present, else `SIGUGUN` (마포구). Empty strings count as absent. */
function areaFrom(elements: NaverAddress['addressElements']): string | null {
  const pick = (type: string) =>
    elements?.find((e) => e.types?.includes(type))?.longName?.trim() || null;
  return pick('DONGMYUN') ?? pick('SIGUGUN');
}
