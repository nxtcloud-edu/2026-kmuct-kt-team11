'use client';

import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/surface';

/**
 * The "near you" map.
 *
 * A list of place names cannot answer the only question this section is asked —
 * is it on my way? — because the answer is a distance, and a distance is a
 * picture. The map is the section's imagery, and under the visual record it is
 * the only thing here allowed to carry colour: the chrome around it stays white,
 * flat and unshadowed.
 *
 * Naver, not Google: every place in this product is in Seoul, addressed by a
 * Korean road address, and named in Korean. Google's Korean basemap has no
 * driving directions, thin POI coverage and frequently no Korean venue label at
 * all — so the map would be showing a Seoul the user does not recognise. Naver
 * is what Korean readers actually read.
 *
 * `places` arrives from a Server Component, so every field here is a plain
 * serialisable value — `listPlacesNearby` is what fills it.
 */

export type NearbyPlace = {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
};

/**
 * `places.category` is an English enum in the database (the CHECK constraint is
 * the authority) and every word a user reads is Korean, so the labels are
 * translated at the point of display. This lives here because the map and its
 * no-key fallback are the two places on home that render a bare category; the
 * deck keeps its own copy for now.
 */
export const CATEGORY_KO: Record<string, string> = {
  cafe: '카페',
  restaurant: '음식점',
  exhibition: '전시',
  shop: '가게',
  activity: '체험',
};

/**
 * Below this the map is zoomed so far in that a single pin fills the frame and
 * tells you nothing about where it is. ~0.012° of latitude is about 1.3km, which
 * is a walkable neighbourhood — the scale at which "near you" means something.
 */
const MIN_SPAN_DEG = 0.012;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Naver ships no type definitions and there is no community @types package, so
 * this is a hand-written declaration of the surface this file actually touches —
 * nothing wider. `any` would type-check the same call sites while silently
 * accepting a misspelled method, which is the failure this exists to catch.
 * Every member below was verified against the served v3.10.2 bundle.
 */
interface NaverLatLng {
  lat(): number;
  lng(): number;
}

interface NaverLatLngBounds {
  getCenter(): NaverLatLng;
}

/** Margins are in pixels and inset the pins from the viewport edge. */
type NaverFitBoundsOptions = { top: number; right: number; bottom: number; left: number };

interface NaverMap {
  fitBounds(bounds: NaverLatLngBounds, options?: NaverFitBoundsOptions): void;
  /** Releases the tile layer, the DOM it built and its own listeners. */
  destroy(): void;
}

interface NaverMarker {
  setMap(map: NaverMap | null): void;
}

interface NaverInfoWindow {
  /** Takes an HTML string, not a node — see `setInfoWindowContent`. */
  setContent(content: string): void;
  open(map: NaverMap, anchor: NaverMarker): void;
  close(): void;
}

/**
 * The handle `Event.addListener` hands back; the bundle returns
 * `{ target, eventName, listenerId, listener }`. Only ever passed straight back
 * to `removeListener`, so one field is enough to keep it from being `object`.
 */
interface NaverEventListener {
  readonly eventName: string;
}

type NaverMapOptions = {
  center: NaverLatLng;
  zoom: number;
  zoomControl: boolean;
  scaleControl: boolean;
  scrollWheel: boolean;
};

type NaverMarkerOptions = {
  position: NaverLatLng;
  map: NaverMap;
  title: string;
};

type NaverInfoWindowOptions = {
  content: string;
  borderWidth: number;
  backgroundColor: string;
  disableAnchor: boolean;
};

interface NaverMapsNamespace {
  Map: new (element: HTMLElement, options: NaverMapOptions) => NaverMap;
  LatLng: new (lat: number, lng: number) => NaverLatLng;
  LatLngBounds: new (sw: NaverLatLng, ne: NaverLatLng) => NaverLatLngBounds;
  Marker: new (options: NaverMarkerOptions) => NaverMarker;
  InfoWindow: new (options: NaverInfoWindowOptions) => NaverInfoWindow;
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
 * Module-level, so the tag is appended once no matter how many times the effect
 * runs. React strict mode double-invokes effects in development and a second
 * `<script>` for the same bundle would re-enter Naver's initialiser; every caller
 * awaits this one promise instead.
 */
let scriptPromise: Promise<NaverMapsNamespace> | null = null;

function loadNaverMaps(clientId: string): Promise<NaverMapsNamespace> {
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
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A key-less clone must still get a working screen. The precedent is
 * `socialSignInConfigured()` in lib/supabase.ts: a deployment that cannot do the
 * thing hides the control rather than shipping one that dead-ends. Here that
 * means the list this map replaced, not a grey rectangle where a map should be —
 * the place names are the data, and they are readable without Naver.
 */
export function NearbyMap({ places }: { places: NearbyPlace[] }) {
  const clientId = process.env.NEXT_PUBLIC_NAVER_MAP_CLIENT_ID;

  // The section is already hidden when there is nothing nearby (see the
  // `Section` guard in page.tsx); the check repeats here only so the bounds
  // maths below never has to reason about an empty set.
  if (!clientId || places.length === 0) return <NearbyList places={places} />;

  return <MapView places={places} clientId={clientId} />;
}

function MapView({ places, clientId }: { places: NearbyPlace[]; clientId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // A rejected key produces a map that renders nothing, which is the one outcome
  // worse than no map — so the same list the no-key path shows is what a failed
  // script or a failed auth check falls back to.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (failed) return;

    // The race: the script resolves on the network's schedule and the container
    // is attached on React's. Reading `containerRef.current` inside the promise
    // callback — not at effect entry — is what makes the map wait for BOTH, and
    // `cancelled` is what stops a resolution that lands after unmount from
    // building a map into a detached node. A `.then` is always a microtask, so
    // on a strict-mode double-invoke the first pass's cleanup has already run
    // and set `cancelled` before its callback can fire.
    let cancelled = false;
    let maps: NaverMapsNamespace | null = null;
    let map: NaverMap | null = null;
    let infoWindow: NaverInfoWindow | null = null;
    const markers: NaverMarker[] = [];
    const listeners: NaverEventListener[] = [];

    window.navermap_authFailure = () => {
      console.error(
        'Naver Maps rejected NEXT_PUBLIC_NAVER_MAP_CLIENT_ID. Add this origin to the ' +
          'domain whitelist for the key in the NCP console.',
      );
      setFailed(true);
    };

    loadNaverMaps(clientId)
      .then((ns) => {
        const element = containerRef.current;
        if (cancelled || !element) return;
        maps = ns;

        // Fit the camera to the pins rather than to a hardcoded centre: the
        // section is whatever area the user lives in, and a fixed centre would
        // be right for exactly one of them.
        const lats = places.map((p) => p.lat);
        const lngs = places.map((p) => p.lng);
        const [south, north] = [Math.min(...lats), Math.max(...lats)];
        const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
        // One place has a span of zero, and fitting a zero-span box is what pins
        // the camera at maximum zoom — a rooftop, with no street around it to
        // recognise. Widening a too-small span around its own centre is what
        // keeps that from being a special case anywhere else.
        const latPad = Math.max(0, MIN_SPAN_DEG - (north - south)) / 2;
        const lngPad = Math.max(0, MIN_SPAN_DEG - (east - west)) / 2;
        const bounds = new ns.LatLngBounds(
          new ns.LatLng(south - latPad, west - lngPad),
          new ns.LatLng(north + latPad, east + lngPad),
        );

        map = new ns.Map(element, {
          center: bounds.getCenter(),
          // Replaced immediately by `fitBounds`; the constructor requires one.
          zoom: 14,
          // The map is a picture of where these places are, not a map app: pan
          // and pinch stay, the furniture goes. The logo and the data-copyright
          // box are Naver's attribution and stay at their defaults — they are a
          // condition of using the tiles, not decoration.
          zoomControl: false,
          scaleControl: false,
          // Naver has no equivalent of Google's "cooperative" gesture handling,
          // and a map that swallows the wheel inside a 430px column traps the
          // page scroll. Dragging and pinching still work.
          scrollWheel: false,
        });
        map.fitBounds(bounds, { top: 24, right: 24, bottom: 24, left: 24 });

        infoWindow = new ns.InfoWindow({
          content: '',
          // Flat by the visual record: no border, no shadow, white on white.
          borderWidth: 0,
          backgroundColor: '#FFFFFF',
          disableAnchor: false,
        });

        for (const place of places) {
          const marker = new ns.Marker({
            position: new ns.LatLng(place.lat, place.lng),
            map,
            title: place.name,
          });
          markers.push(marker);
          listeners.push(
            ns.Event.addListener(marker, 'click', () => {
              if (!map || !infoWindow) return;
              infoWindow.close();
              // Naver's InfoWindow takes an HTML string, which means the only
              // thing standing between a place name and the DOM is this escape.
              // Names come from the database, so they are not ours to trust.
              setInfoWindowContent(infoWindow, place);
              infoWindow.open(map, marker);
            }),
          );
        }

        // Naver's InfoWindow has no close button of its own — tapping the map
        // is the dismissal, so it has to be wired up or the panel is sticky.
        listeners.push(ns.Event.addListener(map, 'click', () => infoWindow?.close()));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      delete window.navermap_authFailure;
      // Naver holds its listeners in a registry keyed by target, so dropping the
      // JS references is not enough — each one has to be handed back. Skipping
      // this shows up in development as two maps stacked in one container.
      if (maps) for (const listener of listeners) maps.Event.removeListener(listener);
      infoWindow?.close();
      for (const marker of markers) marker.setMap(null);
      map?.destroy();
    };
  }, [places, clientId, failed]);

  if (failed) return <NearbyList places={places} />;

  // Rendered unconditionally while the map is live: the ref has to be attached
  // before the effect's promise resolves, and a container that only appears once
  // loading finishes is exactly the race this component has to avoid.
  return (
    <div
      ref={containerRef}
      className="h-[240px] w-full overflow-hidden rounded-[var(--radius-lg)] bg-surface-1"
    />
  );
}

/** Escapes the five characters that can break out of an HTML text node. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * The panel a tapped pin opens: the name, and the category in the Korean the
 * user reads. Written as inline `style` against the design tokens rather than
 * utility classes, because this markup is handed to Naver as a string and never
 * passes through the component tree Tailwind is generated from.
 */
function setInfoWindowContent(infoWindow: NaverInfoWindow, place: NearbyPlace) {
  infoWindow.setContent(
    `<div style="padding:8px 10px;max-width:200px">` +
      `<p style="font:var(--type-card-title);margin:0">${escapeHtml(place.name)}</p>` +
      `<p style="font:var(--type-caption);color:var(--text-secondary);margin:2px 0 0">` +
      `${escapeHtml(CATEGORY_KO[place.category] ?? place.category)}</p>` +
      `</div>`,
  );
}

/** The pre-map section body, kept as the no-key fallback. */
function NearbyList({ places }: { places: NearbyPlace[] }) {
  return (
    <ul className="flex list-none flex-col gap-[var(--space-7)] p-0">
      {places.map((p) => (
        <Card as="li" key={p.id} className="p-4">
          <p style={{ font: 'var(--type-card-title)' }}>{p.name}</p>
          <p className="mt-0.5 text-secondary" style={{ font: 'var(--type-caption)' }}>
            {CATEGORY_KO[p.category] ?? p.category}
          </p>
        </Card>
      ))}
    </ul>
  );
}
