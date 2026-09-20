'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The bottom sheet.
 *
 * TWO DELIBERATE DEVIATIONS FROM `.agents/visual-language.md`, both scoped to
 * this file. Neither is a licence to repeat them elsewhere, and both want
 * ratifying by that file's owner.
 *
 * 1. THE THIRD AND LAST SHADOW. The record allows three and two are structural
 *    (the desktop phone canvas, the floating tab bar). This spends the reserved
 *    `--shadow-card` recipe — same blur, same 6% alpha — mirrored in Y, because
 *    a sheet rises from the bottom edge and `0 4px 12px` would fall off-canvas
 *    where nobody can see it. Only the direction changes. The budget is now
 *    spent: everything else on this screen that needs separating is separated by
 *    a surface step or a border.
 *
 * 2. ONE ANIMATED LAYOUT PROPERTY. The record's motion budget is opacity and
 *    border, with transforms carved out for the home deck alone. A sheet you can
 *    drag cannot live inside that: the height follows the finger. During a drag
 *    there is no transition at all — the element tracks the pointer, which is
 *    direct manipulation rather than motion — and only the snap at the end is
 *    animated, on `height`, for one `--dur-fade`. Under `prefers-reduced-motion`
 *    globals.css already forces every transition to 0.01ms and `--dur-fade` to
 *    0, so the snap is instant and the drag is unaffected.
 *
 * Keyboard reaches everything the finger does. The grab bar is a real button:
 * Enter/Space steps the sheet up and wraps back to its smallest, and the arrow
 * keys move it one detent at a time.
 */

export function Sheet({
  height,
  detents,
  onHeight,
  header,
  children,
  label,
}: {
  height: number;
  /** Ascending, at least one. The smallest is the collapsed rest position. */
  detents: number[];
  onHeight: (height: number) => void;
  header: ReactNode;
  children: ReactNode;
  label: string;
}) {
  // Whether a drag is in flight is state, not a ref: it decides whether the
  // sheet gets a transition, which is a render-time question. Reading a ref
  // during render is exactly the bug React warns about.
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; height: number } | null>(null);

  const min = detents[0];
  const max = detents[detents.length - 1];

  const snap = useCallback(
    (to: number) => {
      // Nearest, not "whichever way you were going". A sheet that keeps
      // travelling after the finger stops is a sheet that overshoots the detent
      // the user was aiming at.
      const nearest = detents.reduce((best, d) =>
        Math.abs(d - to) < Math.abs(best - to) ? d : best,
      );
      onHeight(nearest);
    },
    [detents, onHeight],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      const index = detents.findIndex((d) => d === height);
      const from = index === -1 ? detents.findIndex((d) => d >= height) : index;
      const next = Math.min(Math.max((from === -1 ? detents.length - 1 : from) + direction, 0), detents.length - 1);
      onHeight(detents[next]);
    },
    [detents, height, onHeight],
  );

  function onPointerDown(e: React.PointerEvent) {
    start.current = { y: e.clientY, height };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!start.current) return;
    // Up is taller: the sheet's top edge follows the finger, so the height grows
    // by however far the pointer travelled against the Y axis.
    const next = start.current.height - (e.clientY - start.current.y);
    onHeight(Math.min(Math.max(next, min), max));
  }

  function onPointerUp() {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    snap(height);
  }

  return (
    <section
      aria-label={label}
      className="absolute inset-x-0 bottom-0 z-10 flex flex-col overflow-hidden
                 rounded-t-[var(--radius-canvas)] bg-canvas"
      style={{
        height,
        // See deviation 1 above. Written inline rather than added to
        // globals.css: that file is a transcription of the record, and the
        // record has to change before its transcription does.
        boxShadow: '0 -4px 12px rgba(0,0,0,0.06)',
        transition: dragging ? 'none' : 'height var(--dur-fade) var(--ease-nav)',
      }}
    >
      <button
        type="button"
        aria-label="목록 크기 조절"
        aria-expanded={height > min}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => {
          // A tap that follows a drag would fire on top of the snap; `start` is
          // already null by then and the height already equals a detent, so the
          // cycle below is the only thing a real tap does.
          if (height >= max) onHeight(min);
          else step(1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(-1);
          }
        }}
        // `touch-none` so dragging the grab bar resizes the sheet instead of
        // scrolling the page underneath it.
        className="flex h-[var(--space-15)] w-full shrink-0 touch-none items-center justify-center"
      >
        <span
          aria-hidden
          className="h-[var(--space-3)] w-[36px] rounded-[var(--radius-pill)] bg-surface-2"
        />
      </button>

      <div className="shrink-0 px-[var(--gutter)] pb-[var(--space-9)]">{header}</div>

      {/* `min-h-0` or the flex child refuses to shrink and the scroll never
          engages. Bottom padding clears the floating tab bar, which is fixed and
          sits above this sheet — without it the last row parks underneath it. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--gutter)]
                   pb-[calc(var(--tab-bar-height)+var(--tab-bar-bottom)+var(--space-9))]"
      >
        {children}
      </div>
    </section>
  );
}

/**
 * The detents, derived from however tall the screen actually is.
 *
 * `peek` is a measured sum rather than a round number: the tab bar's reserved
 * strip, plus the grab bar and header, plus enough of the list that the first
 * row is visibly cut off — a list that ends flush with the sheet's edge looks
 * finished, and this one is not.
 */
export function detentsFor(containerHeight: number): number[] {
  // Clamped so the list is never empty — the first measurement happens before
  // layout and reports 0, and `detents[0]` has to be a number even then.
  const full = Math.max(160, containerHeight - 96);
  const peek = Math.min(232, full);
  const middle = Math.round(containerHeight * 0.55);
  return [...new Set([peek, middle, full])]
    .filter((h) => h >= peek && h <= full)
    .sort((a, b) => a - b);
}

/** Re-measures the element on resize — a rotated phone has different detents. */
export function useMeasuredHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}
