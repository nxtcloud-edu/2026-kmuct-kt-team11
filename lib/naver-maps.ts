/**
 * Naver Maps v3 — the loader, and the hand-written slice of its API this app uses.
 *
 * Extracted from `app/(app)/home/nearby-map.tsx` when a second screen needed a
 * map. It has to be ONE module rather than a copy per screen: `scriptPromise`
 * below is the whole reason the `<script>` tag is appended exactly once, and a
 * second copy of this file would be a second promise, a second tag, and a second
 * run of Naver's initialiser.
 *
 * Naver ships no type definitions and there is no community `@types` package, so
 * everything below is hand-declared and was verified against the served
 * v3.10.2 bundle (`curl 'https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=…'`).
 * `any` would type-check the same call sites while silently accepting a
 * misspelled method, which is the failure this exists to catch. Declare only
 * what is actually called — a wider surface is a wider lie.
 */

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export interface NaverLatLng {
  lat(): number;
  lng(): number;
}

export interface NaverPoint {
  x: number;
  y: number;
}

export interface NaverSize {
  width: number;
  height: number;
}

export interface NaverLatLngBounds {
  getCenter(): NaverLatLng;
}

/**
 * `x.trbl()` in the bundle: a plain `{top,right,bottom,left}` of numbers. Used
 * for two different things — `fitBounds`'s margin argument, and the Map's own
 * `padding` option, which shifts the map's optical centre by
 * `((right-left)/2, (bottom-top)/2)`. The second is what lets a bottom sheet
 * overlay the map without `panTo` parking every pin underneath it.
 */
export type NaverPadding = { top: number; right: number; bottom: number; left: number };

/* -------------------------------------------------------------------------- */
/* Map types                                                                   */
/* -------------------------------------------------------------------------- */

// Branded rather than structural. Both are opaque handles: they are constructed
// by the factories below and only ever handed straight back to the Map, so
// claiming any runtime shape for them would be claiming something unverified.
declare const mapTypeBrand: unique symbol;
declare const registryBrand: unique symbol;

export interface NaverMapType {
  readonly [mapTypeBrand]?: never;
}

export interface NaverMapTypeRegistry {
  readonly [registryBrand]?: never;
}

/* -------------------------------------------------------------------------- */
/* Overlays                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Naver's `HtmlIcon`. The bundle branches on `isString(content)` and, when it is
 * not a string, keeps the node as-is:
 *
 *   x.isString(t.content) ? this._element = this._makeElement(t.content)
 *                         : this._element = t.content
 *
 * Passing a live element rather than an HTML string is what lets React own what
 * is inside a marker — which in turn means no place name is ever concatenated
 * into markup, so there is no escaping to get wrong.
 *
 * `size` and `anchor` are read once, at construction. Keep the element's box a
 * fixed size and let its contents grow inside it, or a selected marker will walk
 * away from its own coordinate.
 */
export type NaverHtmlIcon = {
  content: string | HTMLElement;
  size: NaverSize;
  anchor: NaverPoint;
};

export interface NaverMarker {
  setMap(map: NaverMap | null): void;
  /**
   * The string form of `setOptions`, which the bundle forwards to `set(key, …)`
   * when no `setXxx` accessor exists. Narrowed to the one key this app changes
   * after construction: a selected marker has to come out from behind whichever
   * neighbour is sitting on top of it.
   */
  setOptions(key: 'zIndex', value: number): void;
}

export interface NaverInfoWindow {
  /** Takes an HTML string, not a node — anything interpolated must be escaped. */
  setContent(content: string): void;
  open(map: NaverMap, anchor: NaverMarker): void;
  close(): void;
}

/**
 * The handle `Event.addListener` hands back; the bundle returns
 * `{ target, eventName, listenerId, listener }`. Only ever passed straight back
 * to `removeListener`, so one field is enough to keep it from being `object`.
 */
export interface NaverEventListener {
  readonly eventName: string;
}

/* -------------------------------------------------------------------------- */
/* Map                                                                         */
/* -------------------------------------------------------------------------- */

export interface NaverMap {
  fitBounds(bounds: NaverLatLngBounds, margin?: NaverPadding): void;
  /** Animated recentre that leaves the zoom level alone. */
  panTo(coord: NaverLatLng): void;
  setCenter(coord: NaverLatLng): void;
  setOptions(key: 'padding', value: NaverPadding): void;
  /** Releases the tile layer, the DOM it built and its own listeners. */
  destroy(): void;
}

/**
 * Only the options actually passed. `center` and `zoom` are required because the
 * constructor is: it builds a map model before anything can call `fitBounds`.
 */
export type NaverMapOptions = {
  center: NaverLatLng;
  zoom: number;
  mapTypes?: NaverMapTypeRegistry;
  mapTypeId?: string;
  padding?: NaverPadding;
  background?: string;
  zoomControl?: boolean;
  scaleControl?: boolean;
  mapTypeControl?: boolean;
  scrollWheel?: boolean;
  keyboardShortcuts?: boolean;
  // logoControl and mapDataControl are deliberately absent. They are Naver's
  // tile attribution — a condition of using the tiles, not map furniture — and
  // both default to true. Do not add them here in order to turn them off.
};

export type NaverMarkerOptions = {
  position: NaverLatLng;
  map: NaverMap;
  title?: string;
  icon?: NaverHtmlIcon;
  zIndex?: number;
};

export type NaverInfoWindowOptions = {
  content: string;
  borderWidth: number;
  backgroundColor: string;
  disableAnchor: boolean;
};

export interface NaverMapsNamespace {
  Map: new (element: HTMLElement, options: NaverMapOptions) => NaverMap;
  LatLng: new (lat: number, lng: number) => NaverLatLng;
  LatLngBounds: new (sw: NaverLatLng, ne: NaverLatLng) => NaverLatLngBounds;
  Point: new (x: number, y: number) => NaverPoint;
  Size: new (width: number, height: number) => NaverSize;
  Marker: new (options: NaverMarkerOptions) => NaverMarker;
  InfoWindow: new (options: NaverInfoWindowOptions) => NaverInfoWindow;
  MapTypeRegistry: new (types: Record<string, NaverMapType>) => NaverMapTypeRegistry;
  /**
   * The built-in tile styles. Each is an `overlayType` string naming the tile
   * layers Naver composites, and the difference that matters here is one layer:
   *
   *   getNormalMap() → "bl_vc_bg/ol_vc_an"   base + annotations
   *   getVectorMap() → "bl_vc_bg"            base only
   *
   * `ol_vc_an` is every label Naver draws — POI pins, subway and bus marks,
   * IC/JC highway badges, district and street names. See `QUIET_BASEMAP`.
   */
  NaverStyleMapTypeOption: {
    getVectorMap(): NaverMapType;
    getNormalMap(): NaverMapType;
  };
  Event: {
    addListener(target: object, type: string, handler: () => void): NaverEventListener;
    removeListener(listener: NaverEventListener): void;
  };
}

declare global {
  interface Window {
    naver?: { maps: NaverMapsNamespace };
    /**
     * Naver's own hook. The script is served to anyone — the 200 only means the
     * file exists — and the key is checked at runtime against the domain
     * whitelist in the NCP console. When that check fails this is called and the
     * tiles never arrive, so it is the only signal that separates "wrong domain"
     * from "still loading".
     */
    navermap_authFailure?: () => void;
  }
}

/* -------------------------------------------------------------------------- */
/* Script loading                                                              */
/* -------------------------------------------------------------------------- */

const SCRIPT_ID = 'naver-maps-v3';

/**
 * Module-level, so the tag is appended once no matter how many times an effect
 * runs. React strict mode double-invokes effects in development and a second
 * `<script>` for the same bundle would re-enter Naver's initialiser; every
 * caller awaits this one promise instead.
 */
let scriptPromise: Promise<NaverMapsNamespace> | null = null;

export function loadNaverMaps(clientId: string): Promise<NaverMapsNamespace> {
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const ready = window.naver?.maps;
    if (ready) {
      resolve(ready);
      return;
    }

    const el = document.createElement('script');
    // The current NCP form. The older `openapi.map.naver.com` + `ncpClientId`
    // host still answers, but new keys are issued against this one.
    el.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}`;
    el.id = SCRIPT_ID;
    el.async = true;
    el.onload = () => {
      const maps = window.naver?.maps;
      if (maps) resolve(maps);
      else reject(new Error('naver maps script loaded without a maps namespace'));
    };
    el.onerror = () => reject(new Error('naver maps script failed to load'));
    document.head.appendChild(el);
  });

  return scriptPromise;
}

/* -------------------------------------------------------------------------- */
/* Shared map configuration                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The base map, with Naver's annotation layer off.
 *
 * Measured, not guessed: the default `normal` type composites
 * `bl_vc_bg/ol_vc_an`, and `ol_vc_an` is where Naver's own POI markers, transit
 * glyphs, IC/JC badges and place names live. At the zoom a multi-district
 * `fitBounds` produces they out-number and out-colour our markers, which is the
 * "not distinguishable from the base map" failure the Map View checklist names.
 * `getVectorMap()` is the same base tiles with that one layer left off.
 *
 * What is NOT turned off: `logoControl` and `mapDataControl`. Those are the tile
 * attribution and are a condition of using the tiles.
 *
 * The cost is stated so nobody has to rediscover it: with `ol_vc_an` gone the
 * map has no text at all. Roads, the river, parks and building footprints still
 * draw, so Seoul stays recognisable by shape, and every name a reader needs is
 * in our own UI — the list beside the map is grouped by 구 and each row names
 * its 동. On a screen where the map is a picture of places we already named,
 * that trade is worth it; on a wayfinding screen it would not be.
 */
export function quietBasemap(maps: NaverMapsNamespace): {
  mapTypes: NaverMapTypeRegistry;
  mapTypeId: string;
} {
  return {
    mapTypes: new maps.MapTypeRegistry({ normal: maps.NaverStyleMapTypeOption.getVectorMap() }),
    // `_initMapTypes` looks the id up in the registry above and waits on a
    // `<id>_changed` event if it misses, so the two must agree. 'normal' is also
    // the Map's own default, which keeps this from depending on option order.
    mapTypeId: 'normal',
  };
}
