'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@/components/icons';
import {
  loadNaverMaps,
  quietBasemap,
  type NaverMap,
  type NaverMapsNamespace,
  type NaverMarker,
  type NaverEventListener,
  type NaverPadding,
} from '@/lib/naver-maps';
import { boxAround, type Box, type LocatedPlace } from './model';

/**
 * The map under the saved-places screen.
 *
 * Everything imperative lives here and nothing else does: the parent owns
 * `selectedId`, the sheet's height and the filter, and this component turns
 * those into camera moves and marker state. Naver's objects are not React's, so
 * they stay behind refs and are reconciled by effects rather than re-created on
 * every render.
 *
 * The one unobvious trick is that a marker's contents are a React subtree.
 * Naver's `HtmlIcon` accepts a live element as well as an HTML string, so each
 * marker is handed an empty `<div>` and React portals a `<Pin>` into it. Three
 * things fall out of that: the pin reuses `components/icons.tsx` instead of a
 * second hand-copied SVG, selection is a prop rather than a DOM rewrite, and no
 * place name is ever concatenated into markup — which is the only reason this
 * file has no `escapeHtml` in it, unlike the home map's InfoWindow.
 */

export type MapPadding = NaverPadding;

export function PlacesMap({
  clientId,
  places,
  frame,
  selectedId,
  onSelect,
  padding,
  myPosition,
  fitToken,
  onUnavailable,
}: {
  clientId: string;
  /** Memoised by the caller: a fresh array identity rebuilds every marker. */
  places: LocatedPlace[];
  /**
   * The pins the camera frames — the near cluster, not every pin. Separate from
   * `places` because the 용인 outlier must be plotted without being framed; see
   * `splitByDistance`.
   */
  frame: LocatedPlace[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Keeps the optical centre above the bottom sheet. */
  padding: MapPadding;
  myPosition: { lat: number; lng: number } | null;
  /** Bumped by the caller to re-frame the pins. */
  fitToken: number;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapsRef = useRef<NaverMapsNamespace | null>(null);
  const mapRef = useRef<NaverMap | null>(null);
  const markersRef = useRef<Map<string, NaverMarker>>(new Map());
  const myMarkerRef = useRef<NaverMarker | null>(null);
  // The portal targets. State, not a ref, because React has to re-render to put
  // anything inside them.
  const [pinNodes, setPinNodes] = useState<{ id: string; category: string; node: HTMLElement }[]>(
    [],
  );
  const [myNode, setMyNode] = useState<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);

  // The marker click handler is registered once and must still call the newest
  // `onSelect`. Assigned in an effect rather than during render: a click cannot
  // happen before paint, so the ref is always current by the time it is read.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  /* ── The map ────────────────────────────────────────────────────────────── */

  useEffect(() => {
    // The race: the script resolves on the network's schedule and the container
    // is attached on React's. Reading `containerRef.current` inside the promise
    // callback — not at effect entry — is what makes the map wait for BOTH, and
    // `cancelled` is what stops a resolution that lands after unmount from
    // building a map into a detached node. A `.then` is always a microtask, so
    // on a strict-mode double-invoke the first pass's cleanup has already run
    // and set `cancelled` before its callback can fire.
    let cancelled = false;

    window.navermap_authFailure = () => {
      console.error(
        'Naver Maps rejected NEXT_PUBLIC_NAVER_MAP_CLIENT_ID. Add this origin to the ' +
          'domain whitelist for the key in the NCP console.',
      );
      onUnavailable();
    };

    loadNaverMaps(clientId)
      .then((maps) => {
        const element = containerRef.current;
        if (cancelled || !element) return;
        mapsRef.current = maps;
        mapRef.current = new maps.Map(element, {
          // Both are replaced by the first `fitBounds`; the constructor requires
          // them, and Seoul City Hall is a less surprising single frame than
          // whatever the first row happens to be if that fit never runs.
          center: new maps.LatLng(37.5666103, 126.9783882),
          zoom: 12,
          ...quietBasemap(maps),
          // The map is a picture of where these places are, not a map app: pan
          // and pinch stay, the furniture goes. `logoControl` and
          // `mapDataControl` are Naver's attribution and stay at their defaults.
          zoomControl: false,
          scaleControl: false,
          mapTypeControl: false,
          // Naver has no equivalent of Google's "cooperative" gesture handling,
          // and a map that swallows the wheel inside a 430px column traps the
          // page scroll. Dragging and pinching still work.
          scrollWheel: false,
        });
        setReady(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error(error);
        onUnavailable();
      });

    return () => {
      cancelled = true;
      delete window.navermap_authFailure;
      setReady(false);
      mapRef.current?.destroy();
      mapRef.current = null;
      mapsRef.current = null;
    };
    // `onUnavailable` is a stable `useCallback` in the parent. Rebuilding the
    // map because a callback identity changed would drop the user's camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  /* ── Markers ────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map) return;

    // Captured here rather than read through the ref in cleanup. The Map
    // instance is created once and never reassigned, so the two are the same
    // object today — but a cleanup that reaches through `.current` is one
    // reassignment away from tearing down a different set of markers than it
    // built, and that failure is silent.
    const markers = markersRef.current;

    const listeners: NaverEventListener[] = [];
    const nodes: { id: string; category: string; node: HTMLElement }[] = [];

    for (const saved of places) {
      // A fixed 44px box — the record's `--tap-min` — with the visible puck
      // centred inside it. The icon's anchor is read once at construction, so
      // the box must not change size when the pin inside it grows on selection,
      // or a selected marker walks away from its own coordinate.
      const node = document.createElement('div');
      const marker = new maps.Marker({
        position: new maps.LatLng(saved.place.lat, saved.place.lng),
        map,
        title: saved.place.name,
        icon: { content: node, size: new maps.Size(44, 44), anchor: new maps.Point(22, 22) },
        zIndex: 1,
      });
      markers.set(saved.id, marker);
      nodes.push({ id: saved.id, category: saved.place.category, node });
      listeners.push(
        maps.Event.addListener(marker, 'click', () => onSelectRef.current(saved.id)),
      );
    }

    // Tapping the map is the dismissal. Without it a selection is sticky and the
    // sheet can only be collapsed by dragging it.
    listeners.push(maps.Event.addListener(map, 'click', () => onSelectRef.current(null)));

    setPinNodes(nodes);

    return () => {
      // Naver holds its listeners in a registry keyed by target, so dropping the
      // JS references is not enough — each one has to be handed back. Skipping
      // this shows up in development as two sets of markers in one container.
      for (const listener of listeners) maps.Event.removeListener(listener);
      for (const marker of markers.values()) marker.setMap(null);
      markers.clear();
      setPinNodes([]);
    };
  }, [ready, places]);

  /* ── Camera ─────────────────────────────────────────────────────────────── */

  // The sheet covers the bottom of the map, so the map's own `padding` option
  // moves its optical centre up by half the sheet. Without it every `panTo`
  // parks the pin it just selected underneath the sheet that is describing it.
  useEffect(() => {
    if (!ready) return;
    mapRef.current?.setOptions('padding', padding);
  }, [ready, padding]);

  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map || frame.length === 0) return;
    fitTo(maps, map, boxAround(frame));
    // `fitToken` is the trigger; `frame` changing (a filter) re-frames too,
    // which is what makes filtering to one category zoom to where it is.
  }, [ready, frame, fitToken]);

  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map || !selectedId) return;
    const saved = places.find((p) => p.id === selectedId);
    if (!saved) return;
    // `panTo`, not `fitBounds`: selecting a place answers "where is this one",
    // and changing the zoom under the user throws away the frame they built.
    map.panTo(new maps.LatLng(saved.place.lat, saved.place.lng));
  }, [ready, selectedId, places]);

  // "You are here" is a real marker, not an overlay pinned to the middle of the
  // viewport. The viewport version is right for exactly one frame — the moment
  // after the pan — and lies as soon as the user drags the map.
  useEffect(() => {
    const maps = mapsRef.current;
    const map = mapRef.current;
    if (!ready || !maps || !map || !myPosition) return;

    const node = document.createElement('div');
    const at = new maps.LatLng(myPosition.lat, myPosition.lng);
    myMarkerRef.current = new maps.Marker({
      position: at,
      map,
      icon: { content: node, size: new maps.Size(44, 44), anchor: new maps.Point(22, 22) },
      // Above every place pin including a selected one: the checklist asks for
      // the current-location mark to be the most prominent thing on the map.
      zIndex: 200,
    });
    setMyNode(node);
    // The checklist is explicit that re-centring must not zoom. `panTo` does not.
    map.panTo(at);

    return () => {
      myMarkerRef.current?.setMap(null);
      myMarkerRef.current = null;
      setMyNode(null);
    };
  }, [ready, myPosition]);

  // Selection has to survive a neighbour being drawn on top of it. Naver stacks
  // markers in creation order, so a raised zIndex is the only way the selected
  // pin comes forward.
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      marker.setOptions('zIndex', id === selectedId ? 100 : 1);
    }
  }, [selectedId, pinNodes]);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <>
      {/* Rendered unconditionally: the ref has to be attached before the
          script's promise resolves, and a container that only appears once
          loading finishes is exactly the race this component has to avoid.
          `--surface-2` underneath so a slow tile load is a grey field rather
          than a white hole that looks like a broken map.

          SIZED WITH h-full, NOT `absolute inset-0`. Naver's Map constructor
          writes `position: relative` onto its container as an inline style, and
          an inline style beats a utility class — so `absolute` silently became
          `relative`, `inset-0` stopped applying, and the div collapsed to zero
          height. The map mounted, drew its copyright control, and rendered no
          tiles into a 399x0 box, which looks exactly like a broken API key.
          The parent is `relative h-dvh`, so `h-full` is the same rectangle by a
          route Naver cannot overwrite. */}
      <div ref={containerRef} className="h-full w-full bg-surface-2" />

      {pinNodes.map(({ id, category, node }) =>
        createPortal(<Pin category={category} selected={id === selectedId} />, node, id),
      )}

      {myNode ? createPortal(<MyLocationDot />, myNode, 'me') : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The pin.
 *
 * The default Naver marker is a blue teardrop, which is the same shape and very
 * nearly the same colour as the POI marks on Naver's own annotation layer — so
 * "this is a place you saved" and "this is a restaurant Naver knows about" read
 * as one class of thing. That is the Map View checklist's first item failing.
 * This mark answers it on three axes at once: `--ink` rather than blue, a puck
 * rather than a teardrop, and the category glyph rather than a dot.
 *
 * `--ink` on white tiles measures 17.40:1 in the record's table, which is the
 * highest-contrast mark the system can draw, and it spends no colour — the
 * record allows saturation only where it means something, and "saved" is not a
 * meaning the palette has a colour for. A heart was considered and is the wrong
 * mark twice over: drawn in ink it reads as a like, and the only heart colour
 * the system owns is `--like-red`, which is reserved for an actual like. The
 * category glyph earns its eleven repetitions by saying something the pin's
 * position does not.
 *
 * SELECTED is a size step plus a white ring. The size is the state; the ring is
 * what separates the selected puck from whatever pin it is overlapping, which is
 * the same job a clusterer would have done and is why there is no clusterer.
 * Both are drawn with a border rather than a shadow — the depth budget is three
 * and this screen has already spent the third on the sheet.
 */
function Pin({ category, selected }: { category: string; selected: boolean }) {
  const size = selected ? 40 : 30;
  return (
    // The 44px box (`--tap-min`) is the hit area; only the puck inside it is painted.
    <span className="flex h-[var(--tap-min)] w-[var(--tap-min)] cursor-pointer items-center justify-center">
      <span
        className="flex items-center justify-center rounded-[var(--radius-pill)] bg-ink text-on-ink"
        style={{
          width: size,
          height: size,
          border: selected ? '3px solid var(--canvas)' : undefined,
          boxSizing: 'border-box',
        }}
      >
        <Icon name={category as IconName} size={selected ? 20 : 16} />
      </span>
    </span>
  );
}

/**
 * "You are here", and the checklist asks for it to be the most prominent mark on
 * the map. It gets there by being the only ringed target rather than by being
 * bigger or louder than the pins: a filled ink disc inside a thick white collar
 * inside a thin ink rim. Nothing else on the screen is drawn as concentric
 * circles, so it is unmistakable at a glance without another colour.
 *
 * It carries no label and no tap target: it answers a question the user asked by
 * pressing a button that is still on screen, so there is nothing to tap it for.
 */
function MyLocationDot() {
  return (
    <span
      aria-hidden
      className="pointer-events-none flex h-[var(--tap-min)] w-[var(--tap-min)] items-center justify-center"
    >
      <span
        className="flex h-[22px] w-[22px] items-center justify-center rounded-[var(--radius-pill)] bg-canvas"
        style={{ border: '1px solid var(--ink)', boxSizing: 'border-box' }}
      >
        <span className="h-[12px] w-[12px] rounded-[var(--radius-pill)] bg-ink" />
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `fitBounds`'s second argument is a pixel margin that insets the pins from the
 * viewport edge. 24px all round keeps a pin's 44px box off the frame; the sheet
 * is handled by the map's `padding` option instead, because a margin here would
 * only affect this one call while `padding` also moves every later `panTo`.
 */
function fitTo(maps: NaverMapsNamespace, map: NaverMap, box: Box) {
  map.fitBounds(
    new maps.LatLngBounds(
      new maps.LatLng(box.south, box.west),
      new maps.LatLng(box.north, box.east),
    ),
    { top: 24, right: 24, bottom: 24, left: 24 },
  );
}
