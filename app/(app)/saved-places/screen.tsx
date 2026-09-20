'use client';

import Image from 'next/image';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Content, PageHeader } from '@/components/surface';
import { Notice } from '@/components/states';
import type { PlaceCategory, SavedPlace } from '@/lib/api/types';
import { CATEGORY_ICON } from '@/lib/categories';
import { PlaceList } from './place-list';
import { PlacesMap } from './places-map';
import { Sheet, detentsFor, useMeasuredHeight } from './sheet';
import { categoryFacets, groupPlaces, isLocated, splitByDistance } from './model';

/**
 * 저장한 곳 — map first.
 *
 * The screen it replaces was a reverse-chronological list of cards: name, 동,
 * date. The question a saved place is actually holding is "where is this, and
 * what else is near it", and a date-ordered list answers neither. So the map is
 * the screen and the list rides on top of it in a sheet.
 *
 * Three things are load-bearing and none of them is the map:
 *   · a pin and its row are ONE object (see `place-list.tsx`);
 *   · the list is chunked by 구, not by save date (see `model.ts`);
 *   · the café 60km outside Seoul is plotted but not framed (`splitByDistance`).
 *
 * The no-map paths are not afterthoughts. Without a Maps key, and when the
 * script or the key check fails, this renders the grouped list on its own — the
 * place names are the data and they are readable without Naver. That is also the
 * Map View checklist's offline item: a map that cannot draw says so and gets out
 * of the way, rather than leaving a grey rectangle where a map should be.
 */
export function SavedPlacesScreen({ places }: { places: SavedPlace[] }) {
  const clientId = process.env.NEXT_PUBLIC_NAVER_MAP_CLIENT_ID;
  // A rejected key produces a map that renders nothing, which is the one outcome
  // worse than no map.
  const [mapDown, setMapDown] = useState(false);

  if (!clientId || mapDown) {
    return <ListOnly places={places} explain={mapDown} />;
  }
  return <MapFirst places={places} clientId={clientId} onMapDown={() => setMapDown(true)} />;
}

/* -------------------------------------------------------------------------- */
/* Map-first                                                                   */
/* -------------------------------------------------------------------------- */

function MapFirst({
  places,
  clientId,
  onMapDown,
}: {
  places: SavedPlace[];
  clientId: string;
  onMapDown: () => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const containerHeight = useMeasuredHeight(frameRef);

  const [category, setCategory] = useState<PlaceCategory | null>(null);
  // Both of these are stored raw and CORRECTED DURING RENDER, a few lines down,
  // rather than repaired by an effect. An effect that calls setState to fix
  // state it just read renders twice for every change and briefly shows the
  // wrong frame; this codebase has had that bug three times, so the pattern is
  // derive-don't-sync. The setters stay — a tap is a real event and belongs in
  // state; it is only the *validity* of what they hold that is derived.
  const [selectedIdRaw, setSelectedId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);

  const detents = useMemo(() => detentsFor(containerHeight), [containerHeight]);
  const [sheetHeightRaw, setSheetHeight] = useState(detents[0]);

  // A resize (or the first real measurement) invalidates whatever height the
  // sheet was holding. Snapping back to the collapsed detent is the honest
  // answer — the alternative is a sheet left at 400px on a 300px screen.
  const sheetHeight = detents.includes(sheetHeightRaw) ? sheetHeightRaw : detents[0];

  /* ── What is on screen ──────────────────────────────────────────────────── */

  // Facets come from ALL rows, not from the filtered ones: a chip row that loses
  // the chip you need to get back out of a filter is a trap.
  const facets = useMemo(() => categoryFacets(places), [places]);

  const visible = useMemo(
    () => (category ? places.filter((p) => p.place?.category === category) : places),
    [places, category],
  );
  const located = useMemo(() => visible.filter(isLocated), [visible]);
  const { near, far } = useMemo(() => splitByDistance(located), [located]);
  const farIds = useMemo(() => new Set(far.map((p) => p.id)), [far]);
  const groups = useMemo(() => groupPlaces(visible, farIds), [visible, farIds]);

  /* ── Selection ──────────────────────────────────────────────────────────── */

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      // Tapping a marker expands the sheet onto that place's detail rather than
      // navigating anywhere — the Map View checklist is explicit that the map
      // must not go away. One detent up is enough to show the detail without
      // burying the pin that opened it.
      if (id) setSheetHeight((h) => Math.max(h, detents[Math.min(1, detents.length - 1)]));
    },
    [detents],
  );

  // A filter that hides the selected place must not leave it selected: the pin
  // is gone, so the row is marking nothing. Derived rather than synced, for the
  // reason given where `selectedIdRaw` is declared — and note this is also more
  // correct than the effect was, because the correction now lands in the SAME
  // render as the filter change instead of one frame later.
  const selectedId =
    selectedIdRaw && visible.some((p) => p.id === selectedIdRaw) ? selectedIdRaw : null;

  /* ── Current location ───────────────────────────────────────────────────── */

  const [myPosition, setMyPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [locate, setLocate] = useState<'idle' | 'asking' | 'busy' | 'denied' | 'error'>('idle');

  const requestPosition = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocate('error');
      return;
    }
    setLocate('busy');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setMyPosition({ lat: position.coords.latitude, lng: position.coords.longitude });
        setLocate('idle');
      },
      (error) => setLocate(error.code === error.PERMISSION_DENIED ? 'denied' : 'error'),
      // Street-level is enough to answer "is this near me"; high accuracy costs
      // seconds and, on a phone, the GPS radio.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }, []);

  /**
   * LOCATION PERMISSION, at the moment it is relevant and not before.
   *
   * Nothing asks on page load. The button is the intent, and the explanation
   * comes BEFORE the browser's own prompt rather than beside it, because the
   * browser prompt says only "localhost wants to know your location" — it cannot
   * say what for or for how long. When the permission is already granted there
   * is no prompt to explain, so the explanation is skipped and the map just
   * moves. `permissions.query` is missing for geolocation in some browsers; the
   * catch falls through to showing the explanation, which is the safe direction.
   */
  const onLocateTap = useCallback(async () => {
    if (locate === 'asking') {
      setLocate('idle');
      return;
    }
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
      if (status?.state === 'granted') {
        requestPosition();
        return;
      }
    } catch {
      /* no permissions API — fall through to asking */
    }
    setLocate('asking');
  }, [locate, requestPosition]);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  const mapPadding = useMemo(
    () => ({
      top: 0,
      right: 0,
      // Half the sheet moves the optical centre up by a quarter of the screen,
      // which is where a selected pin wants to sit. Clamped, because at the tall
      // detent the sheet is most of the screen and the full offset would push
      // the centre off the top of it.
      bottom: Math.min(sheetHeight, Math.round(containerHeight * 0.5)),
      left: 0,
    }),
    [sheetHeight, containerHeight],
  );

  return (
    <div
      ref={frameRef}
      // The map is full-bleed, so the screen is exactly the canvas and clips to
      // it: without `overflow-hidden` the tiles square off the phone frame's
      // rounded corners on desktop.
      className="relative h-dvh overflow-hidden min-[480px]:rounded-[var(--radius-canvas)]"
    >
      <PlacesMap
        clientId={clientId}
        places={located}
        frame={near}
        selectedId={selectedId}
        onSelect={select}
        padding={mapPadding}
        myPosition={myPosition}
        fitToken={fitToken}
        onUnavailable={onMapDown}
      />

      {/* Filter row first, camera controls under it on the right — both anchored
          to the top, so both stay clear of the sheet at every detent.

          The two used to share one line, chips left and plate right. Six chips
          wearing icons do not fit in what was left after the plate: the row
          showed three and a half of them and the rest were a swipe away, which
          is not what "all five, always" means. The plate costs one line of
          vertical space and the map underneath it is still the map. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-stretch gap-[var(--space-7)] p-[var(--gutter)]">
        <div className="pointer-events-auto min-w-0">
          <FacetChips facets={facets} value={category} onChange={setCategory} />
        </div>

        <div className="pointer-events-auto flex shrink-0 flex-col items-end gap-[var(--space-7)] self-end">
          <Plate>
            <PlateButton
              onClick={() => {
                setSelectedId(null);
                setFitToken((t) => t + 1);
              }}
            >
              전체
            </PlateButton>
            <span aria-hidden className="h-[1px] w-full bg-[var(--divider)]" />
            <PlateButton onClick={onLocateTap} busy={locate === 'busy'}>
              내 위치
            </PlateButton>
          </Plate>

          {locate === 'asking' ? (
            <Explain
              title="현재 위치 사용"
              body="지도를 내 위치로 옮기는 데에만 써요. 위치를 저장하거나 어디에도 보내지 않아요."
              confirm="허용하고 보기"
              onConfirm={requestPosition}
              onDismiss={() => setLocate('idle')}
            />
          ) : null}

          {locate === 'denied' ? (
            <Explain
              title="위치 권한이 꺼져 있어요"
              body="주소창의 자물쇠 아이콘을 눌러 사이트 설정에서 위치를 허용하면 다시 쓸 수 있어요."
              onDismiss={() => setLocate('idle')}
            />
          ) : null}

          {locate === 'error' ? (
            <Explain
              title="위치를 가져오지 못했어요"
              body="잠시 뒤에 다시 시도해 주세요."
              onDismiss={() => setLocate('idle')}
            />
          ) : null}
        </div>
      </div>

      <Sheet
        label="저장한 곳 목록"
        height={sheetHeight}
        detents={detents}
        onHeight={setSheetHeight}
        header={
          <div className="flex items-baseline justify-between gap-[var(--space-7)]">
            <h1 style={{ font: 'var(--type-tab-header)', letterSpacing: 'var(--tab-header-ls)' }}>
              저장한 곳
            </h1>
            <p className="shrink-0 text-secondary tabular-nums" style={{ font: 'var(--type-meta)' }}>
              {visible.length}곳 · {groups.length}개 지역
            </p>
          </div>
        }
      >
        <PlaceList groups={groups} selectedId={selectedId} onSelect={select} />
      </Sheet>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Controls over imagery                                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE ONE DECISION THIS SCREEN HAD TO MAKE THAT THE RECORD DOES NOT COVER.
 *
 * `.agents/visual-language.md` says cards are tinted surfaces with no border and
 * no shadow. That rule works because it assumes a known background: `--surface-1`
 * reads as a group precisely because the canvas behind it is white. Map tiles are
 * not a known background — white roads, grey blocks, green parks — so a
 * `--surface-1` chip over them is neither legible nor separable, and the measured
 * contrast table stops describing anything real.
 *
 * Three options, and why this is the third.
 *
 *   A fourth shadow is out. The budget is three, two are structural, and the
 *   sheet on this screen has taken the last one.
 *
 *   A translucent plate is out, and the arithmetic is the reason rather than
 *   taste. The system already owns one — `--puck-white`, `rgba(255,255,255,0.92)`,
 *   which the home deck puts over reel stills. Ink survives it: over the darkest
 *   thing a tile can be, `--ink` still measures about 14:1. `--text-secondary`
 *   does not. It has 5.33:1 on white and only 0.83 of headroom above AA, and at
 *   0.92 over a dark tile it lands at roughly 4.5:1 — on the line, which is not
 *   a place to put a chip label whose background is user-supplied cartography.
 *
 *   So: an OPAQUE `--canvas` plate. Opacity is the whole point of it — every
 *   ratio in the record's table stays literally true because the thing behind
 *   the text is white, not "white over whatever". `--ink` is 17.40:1, the
 *   inactive chip's `--text-secondary` on `--surface-2` is 4.76:1, both measured,
 *   both unchanged by the map.
 *
 * Separation from the map is then carried by shape and by the surface step the
 * rest of the app already uses, inverted: on the white canvas a card steps DOWN
 * to `--surface-1`; over tiles the control steps UP to pure white while the map
 * is the darker, busier field. No border, no shadow, no blur. The residual risk
 * is honest — a white plate over a white road is a low-contrast edge — and it is
 * bounded by the pill geometry and by the tinted chips inside it, neither of
 * which a basemap produces.
 */
function Plate({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-stretch overflow-hidden rounded-[var(--radius-xl)] bg-canvas">
      {children}
    </div>
  );
}

function PlateButton({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-busy={busy || undefined}
      className="flex h-[var(--tap-min)] items-center justify-center px-[var(--space-11)]
                 text-ink transition-opacity duration-200
                 active:opacity-[var(--press-opacity)] disabled:opacity-40"
      style={{ font: 'var(--type-meta)' }}
    >
      {children}
    </button>
  );
}

/**
 * The filter, as a persistent overlay on the map rather than a screen you leave
 * for — the applied filter has to stay visible next to the pins it is hiding.
 * Active state is a fill inversion, not a colour: there is no accent to spend,
 * and the record marks selection the same way in the tab bar.
 *
 * ALL FIVE CATEGORIES, ALWAYS — and the two consequences of that.
 *
 * 1. THE COUNT IS ALWAYS ON THE CHIP, `0` INCLUDED. The comment on the facets
 *    said a chip row that loses the chip you need to get back out of a filter is
 *    a trap. A chip that leads somewhere empty is the same trap seen from the
 *    other side: you tap 전시, every pin vanishes, the sheet says 0곳, and
 *    nothing on screen tells you whether the filter is broken or you simply have
 *    no exhibitions saved. The count answers that BEFORE the tap, which is the
 *    only time the answer is worth anything.
 *
 * 2. A ZERO CHIP IS NOT PRESSABLE, and what marks it is the missing fill. In
 *    this system a chip IS its tinted surface — `--surface-2` is what makes the
 *    word look like an object you can push. Take the fill away and the same word
 *    reads as a label, which is exactly what it now is. This is the only
 *    treatment available that says "not a control" without breaking the measured
 *    contrast table: dimming the chip the way `PlateButton` dims (opacity 40%)
 *    would drop `--text-secondary` to roughly 2:1 on the plate, and `--tertiary`
 *    is decorative-only for the same reason. Label on the white plate is
 *    5.33:1 — better than the 4.76:1 the live chips have on `--surface-2`.
 *    The 3D icon dims instead, because the icon is `alt=""` decoration and the
 *    table does not cover it.
 *
 * The icons need no treatment of their own: they sit on the opaque `--canvas`
 * plate documented above `Plate`, never on tiles, so the map cannot get behind
 * them. `transition-opacity` was already the chip's only motion and stays.
 */
function FacetChips({
  facets,
  value,
  onChange,
}: {
  facets: { key: PlaceCategory; label: string; count: number }[];
  value: PlaceCategory | null;
  onChange: (next: PlaceCategory | null) => void;
}) {
  return (
    <div
      role="group"
      aria-label="분류 필터"
      // SCROLLS, does not wrap. Six tiles do not fit the 430px canvas, and a
      // second line cost 41px of the map on a screen whose whole point is the
      // map. Horizontal overflow keeps the row one line tall; the tiles are
      // deliberately narrow enough that the sixth is half-visible at rest,
      // which is what tells you the row continues without a scrollbar.
      //
      // `scrollbar-width: none` hides the desktop bar; the row stays reachable
      // by trackpad, shift-wheel, and keyboard focus, which moves the scroller
      // on its own.
      className="flex snap-x gap-[var(--space-6)] overflow-x-auto overscroll-x-contain
                 rounded-[var(--radius-xl)] bg-canvas px-[var(--space-7)] py-[var(--space-6)]
                 [-ms-overflow-style:none] [scrollbar-width:none]
                 [&::-webkit-scrollbar]:hidden"
    >
      {/* No 전체 tile. It is not a kind of place, and the state it represents —
          no filter — is reachable by tapping the active tile again, which is
          where a user already looks to undo a filter they just set. One fewer
          control, and the row is then six things of one kind rather than five
          plus an odd one out. */}
      {facets.map((facet) => (
        <FacetChip
          key={facet.key}
          on={value === facet.key}
          empty={facet.count === 0}
          icon={CATEGORY_ICON[facet.key]}
          label={facet.label}
          count={facet.count}
          onClick={() => onChange(value === facet.key ? null : facet.key)}
        />
      ))}
    </div>
  );
}

function FacetChip({
  on,
  empty,
  icon,
  label,
  count,
  onClick,
}: {
  on: boolean;
  empty?: boolean;
  icon?: string;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      // The count is in the accessible name rather than only in the visible
      // digit, so a screen reader reads "카페 11곳" and not a bare category.
      aria-label={`${label} ${count}곳`}
      // `disabled` rather than `aria-disabled`: there is nothing to explain on
      // focus that the visible 0 does not already say, and a focusable control
      // that swallows its own press is worse than one you cannot reach.
      disabled={empty}
      className={`flex w-[62px] shrink-0 snap-start flex-col items-center gap-[var(--space-3)]
                  rounded-[var(--radius-lg)] px-[var(--space-3)] py-[var(--space-5)]
                  transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
                    on ? 'bg-ink text-on-ink' : empty ? 'text-tertiary' : 'text-secondary'
                  }`}
      onClick={onClick}
    >
      {icon ? (
        <Image
          src={icon}
          alt=""
          width={30}
          height={30}
          // A 3D render carries its own light. Dimming rather than greying keeps
          // an empty category recognisable as the same object, which is the
          // point of showing it at all.
          className={empty ? 'opacity-30' : undefined}
        />
      ) : null}

      {/* Label under the icon, not beside it. Beside it the row measured 482px
          against a 430px canvas and wrapped; stacked, the tile is as wide as
          its widest word and six fit in one scrollable line.

          The count is NOT drawn. A row of digits is noise on a filter whose
          whole job is to be glanced at, and the map behind it already shows how
          many pins a category has. It survives in `aria-label` because a screen
          reader has no map to glance at, and in the dimmed state, which is what
          an empty category looks like without spelling out a zero. */}
      <span className="whitespace-nowrap" style={{ font: 'var(--type-caption)' }}>
        {label}
      </span>
    </button>
  );
}

/** A short opaque plate of prose, used for the three things geolocation can say. */
function Explain({
  title,
  body,
  confirm,
  onConfirm,
  onDismiss,
}: {
  title: string;
  body: string;
  confirm?: string;
  onConfirm?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="w-[248px] rounded-[var(--radius-xl)] bg-canvas p-[var(--space-11)]"
    >
      <p style={{ font: 'var(--type-card-title)' }}>{title}</p>
      <p className="mt-[var(--space-4)] text-secondary" style={{ font: 'var(--type-caption)' }}>
        {body}
      </p>
      <div className="mt-[var(--space-9)] flex justify-end gap-[var(--space-7)]">
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-[var(--tap-min)] items-center px-[var(--space-7)] text-secondary
                     transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-meta)' }}
        >
          {confirm ? '안 할래요' : '닫기'}
        </button>
        {confirm ? (
          <button
            type="button"
            onClick={() => {
              onDismiss();
              onConfirm?.();
            }}
            className="flex h-[var(--tap-min)] items-center rounded-[var(--radius-md)] bg-ink
                       px-[var(--space-11)] text-on-ink transition-opacity duration-200
                       active:opacity-[var(--press-opacity)]"
            style={{ font: 'var(--type-meta)' }}
          >
            {confirm}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* No map                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The same grouped list, without a map under it. This is what a clone with no
 * Maps key gets, and what everyone gets when the tiles cannot be reached — the
 * place names are the data, and they are readable without Naver.
 */
function ListOnly({ places, explain }: { places: SavedPlace[]; explain: boolean }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const groups = useMemo(() => groupPlaces(places, new Set<string>()), [places]);

  return (
    <Content>
      <PageHeader title="저장한 곳" meta={`${places.length}곳 · ${groups.length}개 지역`} />
      {explain ? (
        <div className="mb-[var(--space-15)]">
          <Notice
            title="지도를 불러오지 못했어요"
            body="네트워크가 끊겼거나 지도 서비스에 연결하지 못했어요. 저장한 곳은 그대로 볼 수 있어요."
          />
        </div>
      ) : null}
      <PlaceList
        groups={groups}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
      />
    </Content>
  );
}
