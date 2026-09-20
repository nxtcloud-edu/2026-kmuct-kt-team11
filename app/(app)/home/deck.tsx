'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SavedPlace } from '@/lib/api/types';
import { reelThumb } from '@/lib/reel-thumb';
import { Icon, type IconName } from '@/components/icons';

/**
 * The saved-places deck.
 *
 * A stack you move through one place at a time, rather than a list you scan.
 * The premise is that a saved place is a decision you deferred, so the screen
 * shows you one and asks; a list of thirteen asks nothing.
 *
 * DELIBERATE DEVIATION FROM `.agents/visual-language.md`: the motion budget is
 * opacity and border only, with no transforms. A deck cannot be built inside
 * that budget — the cards have to move. The deviation is confined to this
 * component and is recorded in the visual-language changelog; do not read it as
 * permission to animate transforms elsewhere.
 *
 * Swipe is an accelerator, never the only way through. Every action has a
 * button, arrow keys work, position is announced politely, and under
 * `prefers-reduced-motion` the cards swap with no travel at all. A deck that can
 * only be swiped is a deck a lot of people cannot use.
 */

export type SortKey = 'recent' | 'area' | 'name';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'recent', label: '최신순' },
  { key: 'area', label: '지역순' },
  { key: 'name', label: '이름순' },
];

const CATEGORY_KO: Record<string, string> = {
  cafe: '카페',
  restaurant: '음식점',
  exhibition: '전시',
  shop: '가게',
  activity: '체험',
};

/** Far enough that a scroll or a stray tap is not mistaken for a decision. */
const COMMIT_PX = 72;

/**
 * Below this the pointer did not really move and the gesture was a tap.
 * Deliberately larger than 0: a finger never lifts from exactly where it
 * landed, and a 1px tremor must not be read as a swipe that went nowhere.
 */
const TAP_PX = 6;

export function PlaceDeck({ places }: { places: SavedPlace[] }) {
  const [sort, setSort] = useState<SortKey>('recent');
  const [index, setIndex] = useState(0);
  const router = useRouter();
  const [drag, setDrag] = useState(0);
  // Whether a drag is in flight is state, not a ref: it decides whether the card
  // gets a transition, which is a render-time question. Reading a ref during
  // render is exactly the bug React warns about.
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number | null>(null);

  const sorted = useMemo(() => {
    const copy = [...places];
    if (sort === 'name') {
      // localeCompare with 'ko' so Hangul sorts by 가나다 rather than code point.
      return copy.sort((a, b) =>
        (a.place?.name ?? '').localeCompare(b.place?.name ?? '', 'ko'),
      );
    }
    if (sort === 'area') {
      return copy.sort(
        (a, b) =>
          (a.place?.area ?? '').localeCompare(b.place?.area ?? '', 'ko') ||
          (a.place?.name ?? '').localeCompare(b.place?.name ?? '', 'ko'),
      );
    }
    return copy; // the server already returns newest first
  }, [places, sort]);

  const total = sorted.length;

  const go = useCallback(
    (delta: number) => {
      setDrag(0);
      // Clamped, not wrapped. Looping a finite deck hides that you reached the
      // end, which is the one thing the deck has to be able to say.
      setIndex((i) => Math.min(Math.max(i + delta, 0), Math.max(total - 1, 0)));
    },
    [total],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  if (total === 0) return null;

  const current = sorted[index];
  const behind = sorted.slice(index + 1, index + 3);

  // How far this gesture has carried the stack forward, 0..1. Derived, never
  // stored: it is a pure function of `drag`, and a second copy in state would
  // be one render behind the card it is supposed to move with.
  const lift = Math.min(Math.abs(drag) / COMMIT_PX, 1);

  function onPointerDown(e: React.PointerEvent) {
    dragStart.current = e.clientX;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragStart.current === null) return;
    setDrag(e.clientX - dragStart.current);
  }
  function onPointerUp() {
    if (dragStart.current === null) return;
    // A tap and a swipe arrive through the same three events, so the only thing
    // separating them is how far the pointer travelled. Under TAP_PX it was a
    // tap and the card opens; past COMMIT_PX it was a swipe and the deck turns.
    // Wrapping the card in a <Link> instead would have been simpler and wrong:
    // the browser starts a native link-drag on pointer-down, which eats the
    // gesture this deck exists for.
    const travelled = Math.abs(drag);
    if (drag <= -COMMIT_PX && index < total - 1) go(1);
    else if (drag >= COMMIT_PX && index > 0) go(-1);
    else {
      setDrag(0);
      if (travelled < TAP_PX) router.push(`/saved-places/${current.id}`);
    }
    dragStart.current = null;
    setDragging(false);
  }

  return (
    <section className="mt-[var(--space-15)]">
      {/* Sort is a row of chips, not a select: three options fit, and a chip row
          shows what the alternatives are without a tap to find out. */}
      <div role="tablist" aria-label="정렬" className="flex gap-[var(--space-7)]">
        {SORTS.map((s) => {
          const on = sort === s.key;
          return (
            <button
              key={s.key}
              role="tab"
              aria-selected={on}
              onClick={() => {
                // Reset here rather than in an effect on [sort]: a synchronous
                // setState inside an effect body cascades renders, and this repo
                // has an eslint rule and two prior commits about it.
                setSort(s.key);
                setIndex(0);
              }}
              className={`flex h-[var(--tap-min)] items-center rounded-[var(--radius-pill)] px-[var(--space-11)] transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
                on ? 'bg-ink text-on-ink' : 'bg-surface-1 text-secondary'
              }`}
              style={{ font: 'var(--type-meta)' }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="relative mt-[var(--space-17)]">
        {/* The cards behind carry the NEXT places, not empty slabs. An empty
            ghost is fine at rest — it only has to say "there is more under
            this" — but the moment the front card slides away it is the thing
            you are looking at, and a blank grey rectangle mid-swipe reads as
            the card having failed to load rather than as a deck.

            They also advance WITH the drag rather than waiting for it to
            commit: `lift` is how far the gesture has travelled toward the
            threshold, so the stack rises and grows under your finger and the
            motion is continuous instead of a jump at 72px. */}
        {behind.map((p, i) => {
          const step = i + 1 - lift;
          return (
            <div
              key={p.id}
              aria-hidden
              // inset-0, not a fixed height: the container is sized by the real
              // card, so the ghosts match it instead of poking out below.
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-[var(--radius-4xl)]
                         bg-surface-1 motion-safe:transition-transform motion-safe:duration-300
                         motion-safe:[transition-timing-function:var(--ease-nav)]"
              style={{
                // Uniform scale from the TOP edge, not scaleX. Scaling only the
                // width squashes the photo and the Hangul inside it; anchoring
                // the origin to the top means the card shrinks downward, and the
                // negative translate is what lifts it into view above the front
                // card. The two together are the peek.
                transformOrigin: 'top center',
                transform: `translateY(${-step * 10}px) scale(${1 - step * 0.045})`,
                opacity: Math.max(0, 1 - step * 0.35),
                zIndex: -1 - i,
              }}
            >
              <CardFace saved={p} />
            </div>
          );
        })}

        <article
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative touch-pan-y select-none rounded-[var(--radius-4xl)] bg-surface-1"
          style={{
            // `will-change` so the compositor promotes the card once rather than
            // on the first pointermove, which is where the stutter at the start
            // of a swipe came from.
            willChange: 'transform',
            // Rotation scaled to the canvas rather than a fixed /60: the same
            // 72px commit on a 430px card should tilt the same amount it does on
            // a wider one, and a constant divisor makes the gesture feel heavier
            // the narrower the screen gets.
            transform: `translateX(${drag}px) rotate(${drag / 60}deg)`,
            // No transition WHILE dragging — the card has to track the finger
            // exactly — and an eased one on release so it settles rather than
            // snaps. `--dur-push` (350ms) rather than `--dur-fade` (250ms):
            // this is a card travelling across the screen, which is the same
            // kind of movement a push transition is, and at 250ms it arrives
            // before the eye has followed it.
            //
            // Both tokens drop to 0ms inside the reduced-motion block in
            // globals.css, so honouring that preference costs nothing here —
            // the card simply arrives.
            transition: dragging ? 'none' : 'transform var(--dur-push) var(--ease-nav)',
          }}
        >
          <CardFace saved={current} />
        </article>
      </div>

      <div className="mt-[var(--space-15)] flex items-center justify-between">
        <p aria-live="polite" className="text-secondary tabular-nums" style={{ font: 'var(--type-caption)' }}>
          {index + 1} / {total}
        </p>

        <div className="flex gap-[var(--space-7)]">
          <DeckButton label="이전 장소" disabled={index === 0} onClick={() => go(-1)}>
            ‹
          </DeckButton>
          <DeckButton label="다음 장소" disabled={index >= total - 1} onClick={() => go(1)}>
            ›
          </DeckButton>
        </div>
      </div>

      <Link
        href="/saved-places"
        className="mt-[var(--space-11)] flex h-[var(--tap-min)] items-center justify-center text-secondary"
        style={{ font: 'var(--type-meta)' }}
      >
        전체 보기 ›
      </Link>
    </section>
  );
}

/**
 * The chevron is a text node, so it inherits size and colour for free — but it
 * is meaningless to a screen reader, hence the aria-label carrying the real one.
 */
/**
 * One card's face, used by the front card AND by the ghosts behind it.
 *
 * Shared deliberately. When these were two things the ghosts were empty grey
 * slabs, which is fine at rest but wrong the moment a swipe is in progress —
 * the thing sliding into view was a blank rectangle, and a blank rectangle
 * where a photo should be reads as a failure to load rather than as the next
 * card. Sharing the face also means the two can never drift: whatever the front
 * card shows, the deck shows one step early.
 *
 * Padding lives here rather than on the <article>, so the ghost's rounded
 * corners clip this the same way the front card's do.
 */
function CardFace({ saved }: { saved: SavedPlace }) {
  return (
    <div className="p-[var(--space-13)]">
      {saved.place?.category ? (
        <span
          className="inline-flex items-center gap-[var(--space-4)] rounded-[var(--radius-sm)] bg-[var(--tag-mint-bg)] px-[var(--space-7)] py-[var(--space-4)] text-ink"
          style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
        >
          <Icon name={saved.place.category as IconName} size={14} />
          {CATEGORY_KO[saved.place.category] ?? saved.place.category}
        </span>
      ) : null}

      <h3
        className="mt-[var(--space-9)]"
        style={{ font: 'var(--type-post-title)', letterSpacing: 'var(--post-title-ls)' }}
      >
        {saved.place?.name ?? '장소를 확인하는 중이에요'}
      </h3>

      {saved.place?.address || saved.place?.area ? (
        <p
          className="mt-[var(--space-3)] truncate text-secondary"
          style={{ font: 'var(--type-meta)' }}
        >
          {saved.place.address ?? saved.place.area}
        </p>
      ) : null}

      {/* The reel's real cover frame when we captured one, the stock still
          otherwise — see lib/reel-thumb.ts, now a fallback rather than the only
          path. Seeded rows, hand-entered places and reels whose download failed
          all have a null `thumb_url`, and a hole where a picture should be is
          worse than a picture that is not this reel's. Portrait, because a reel
          is portrait and a landscape crop would misrepresent the frame the
          creator chose. `draggable=false` so dragging the card does not start a
          native image drag instead of a swipe. */}
      <div className="mt-[var(--space-11)] relative aspect-[4/5] w-[62%] overflow-hidden rounded-[var(--radius-lg)] bg-surface-2">
        <Image
          src={saved.thumb_url ?? reelThumb(saved.id)}
          alt=""
          fill
          draggable={false}
          sizes="260px"
          className="object-cover"
        />
        {saved.hook ? (
          // The caption sits on a solid plate, never straight on the photo:
          // Korean place names over a busy frame are unreadable, and a gradient
          // scrim only half-fixes it.
          <p
            className="absolute inset-x-[var(--space-5)] bottom-[var(--space-5)] rounded-[var(--radius-sm)] bg-[var(--puck-white)] px-[var(--space-7)] py-[var(--space-5)] text-ink"
            style={{ font: 'var(--type-card-title)' }}
          >
            {saved.hook}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DeckButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-[var(--tap-min)] w-[var(--tap-min)] items-center justify-center rounded-[var(--radius-pill)] bg-surface-1 text-ink transition-opacity duration-200 active:opacity-[var(--press-opacity)] disabled:opacity-30"
      style={{ font: 'var(--type-section)' }}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}
