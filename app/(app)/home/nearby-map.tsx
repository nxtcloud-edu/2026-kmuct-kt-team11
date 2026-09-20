'use client';

import { useMemo, useState } from 'react';
import { APIProvider, AdvancedMarker, InfoWindow, Map } from '@vis.gl/react-google-maps';
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

/**
 * A key-less clone must still get a working screen. The precedent is
 * `socialSignInConfigured()` in lib/supabase.ts: a deployment that cannot do the
 * thing hides the control rather than shipping one that dead-ends. Here that
 * means the list this map replaced, not a grey rectangle where a map should be —
 * the place names are the data, and they are readable without Google.
 */
export function NearbyMap({ places }: { places: NearbyPlace[] }) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  // The section is already hidden when there is nothing nearby (see the
  // `Section` guard in page.tsx); the check repeats here only so the bounds
  // maths below never has to reason about an empty set.
  if (!apiKey || places.length === 0) return <NearbyList places={places} />;

  return (
    <APIProvider apiKey={apiKey}>
      <MapView places={places} />
    </APIProvider>
  );
}

function MapView({ places }: { places: NearbyPlace[] }) {
  const [selected, setSelected] = useState<NearbyPlace | null>(null);

  // Fit the camera to the pins rather than to a hardcoded centre: the section is
  // whatever area the user lives in, and a fixed centre would be right for
  // exactly one of them.
  const bounds = useMemo(() => {
    const lats = places.map((p) => p.lat);
    const lngs = places.map((p) => p.lng);
    const [south, north] = [Math.min(...lats), Math.max(...lats)];
    const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
    // One place has a span of zero, and fitting a zero-span box is what pins the
    // camera at maximum zoom — a rooftop, with no street around it to recognise.
    // Widening a too-small span around its own centre is what keeps that from
    // being a special case anywhere else.
    const latPad = Math.max(0, MIN_SPAN_DEG - (north - south)) / 2;
    const lngPad = Math.max(0, MIN_SPAN_DEG - (east - west)) / 2;
    return {
      south: south - latPad,
      north: north + latPad,
      west: west - lngPad,
      east: east + lngPad,
      padding: 24,
    };
  }, [places]);

  return (
    <div className="h-[240px] w-full overflow-hidden rounded-[var(--radius-lg)]">
      <Map
        defaultBounds={bounds}
        // AdvancedMarker refuses to render without a map id. `DEMO_MAP_ID` is
        // Google's own unstyled default; a cloud-styled id belongs in env once
        // there is a styled map to point at.
        mapId="DEMO_MAP_ID"
        // The map is a picture of where these places are, not a map app: pan and
        // zoom stay, the furniture goes.
        disableDefaultUI
        gestureHandling="cooperative"
        className="h-full w-full"
      >
        {places.map((p) => (
          <AdvancedMarker
            key={p.id}
            position={{ lat: p.lat, lng: p.lng }}
            title={p.name}
            onClick={() => setSelected(p)}
          />
        ))}

        {selected ? (
          <InfoWindow
            position={{ lat: selected.lat, lng: selected.lng }}
            onCloseClick={() => setSelected(null)}
          >
            <p style={{ font: 'var(--type-card-title)' }}>{selected.name}</p>
            <p className="mt-0.5 text-secondary" style={{ font: 'var(--type-caption)' }}>
              {CATEGORY_KO[selected.category] ?? selected.category}
            </p>
          </InfoWindow>
        ) : null}
      </Map>
    </div>
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
