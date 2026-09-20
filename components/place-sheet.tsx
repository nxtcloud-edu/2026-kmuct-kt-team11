'use client';

import { useEffect, useRef } from 'react';

/**
 * The bottom sheet the place detail sits in when it opens over the map.
 *
 * WHY A SHEET AND NOT A PAGE. The Map View checklist is explicit: "Tapping a
 * marker expanding a bottom sheet with details about that location — NOT a
 * full-screen navigation away from the map." Navigating away costs the user the
 * one thing the map gave them, which is where this place is relative to
 * everything else they saved. The standalone route at
 * `app/(app)/saved-places/[saved_place_id]` exists so a place is linkable and
 * shareable, not as the way you normally reach one.
 *
 * WHY `<dialog>` AND NOT A DIV. Everything this needs is already in the element:
 * Escape closes it, focus is trapped inside it while it is open, the rest of the
 * page is inert to a screen reader, and it renders in the top layer so it is
 * never clipped by the phone canvas's `overflow`. A hand-rolled sheet reimplements
 * all four and usually gets the focus trap wrong. Jakob's Law applies to
 * assistive technology too — a native dialog behaves the way every other native
 * dialog behaves.
 *
 * DEPTH BUDGET. The record allows three shadows and two are structural (the phone
 * canvas, the tab bar). This does NOT spend the third. Separation from the map
 * comes from the `::backdrop` scrim and a flat white surface with a hairline —
 * "if you are reaching for a fourth, the answer is a tinted surface."
 *
 * MOTION BUDGET. Opacity only. `.agents/visual-language.md` scopes transforms to
 * `home/deck.tsx` alone, so this fades in over `--dur-modal` using the one
 * keyframe the system has, and does not slide. Under `prefers-reduced-motion` the
 * global rule in `globals.css` already collapses that animation to nothing — no
 * second media query here, because two places deciding the same thing is two
 * places to forget.
 */
export function PlaceSheet({
  onClose,
  label,
  children,
}: {
  /** Called for every dismissal — Escape, backdrop, the close button. */
  onClose: () => void;
  /** Names the dialog for assistive technology. The venue's name. */
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `showModal` rather than the `open` attribute: only the imperative call puts
    // the element in the top layer and turns on the focus trap and the backdrop.
    if (!el.open) el.showModal();
    return () => { if (el.open) el.close(); };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      // `close` and not `cancel`: Escape fires cancel THEN close, and the close
      // button and backdrop only fire close. Listening to the one event every
      // dismissal ends in means no path out can skip the callback.
      onClose={onClose}
      onClick={(e) => {
        // A modal dialog's backdrop is part of the dialog element's own box, so a
        // click on it targets the dialog itself; anything inside targets a child.
        if (e.target === e.currentTarget) ref.current?.close();
      }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[85dvh] w-full max-w-[430px]
                 overflow-y-auto rounded-t-[var(--radius-canvas)] border-0 bg-canvas p-0
                 text-ink backdrop:bg-[var(--scrim)] min-[480px]:mx-auto"
      style={{ animation: 'fade var(--dur-modal) var(--ease-fade)' }}
    >
      {/* Sticky, so the way out is reachable however far the sheet is scrolled —
          a detail view is long and a dismiss control that scrolls off is a trap
          for anyone who cannot press Escape. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-[var(--hairline)] bg-canvas px-[var(--gutter)] py-3">
        {/* The grab handle is decoration; the button beside it is the control. */}
        <span aria-hidden className="h-1 w-9 rounded-[var(--radius-pill)] bg-[var(--divider)]" />
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="text-secondary transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-button)' }}
        >
          닫기
        </button>
      </div>

      <div className="px-[var(--gutter)] pt-[var(--space-13)] pb-[var(--space-17)]">{children}</div>
    </dialog>
  );
}
