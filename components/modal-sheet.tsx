'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A modal bottom sheet.
 *
 * WHY NOT `app/(app)/saved-places/sheet.tsx`. That one was read first and does
 * not fit: it is a *non-modal* detent panel that lives inside the map screen's
 * positioned container, has no open/closed state at all (it is always present,
 * only shorter or taller), no scrim, and no dismissal — its grab bar cycles
 * height. Everything a create-group or invite sheet needs is the half it does
 * not have. Reusing it would have meant bolting an open/close lifecycle, a
 * scrim, focus containment and Escape onto a component whose current job is
 * "how tall is the list", which is how one component becomes two behaviours
 * wearing one name.
 *
 * So this is a `<dialog>` rather than a second hand-built sheet. The platform
 * supplies exactly the missing half — top-layer stacking, the scrim via
 * `::backdrop`, focus containment, `inert` on everything behind it, and Escape —
 * and none of it is re-implemented here. `sheet.tsx` keeps its detents and this
 * keeps its lifecycle; neither grew the other's job.
 *
 * DEPTH. The record's three shadows are spent (canvas, tab bar, saved-places
 * sheet), so this one has none. The scrim is what separates it from the page,
 * which is not elevation — it is the page being covered.
 *
 * Escape is native, but `close` also fires when the dialog is closed any other
 * way, so `onDismiss` is wired to the event rather than to the key. That keeps
 * the parent's boolean and the element's own open state from disagreeing.
 */
export function ModalSheet({
  open,
  onDismiss,
  title,
  description,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  /** Rendered under the title and wired to `aria-describedby`. */
  description?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // A DOM method call, not a state repair: `showModal()` is the only way to get
  // the top layer and the backdrop, and there is no declarative prop for it.
  // Nothing here reads state back into state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onDismiss}
      aria-labelledby="modal-sheet-title"
      aria-describedby={description ? 'modal-sheet-desc' : undefined}
      // `m-0` and `max-w-none` undo the UA's centring and 80% cap. Centred on
      // the viewport at canvas width, the same way the tab bar is, so it lines
      // up with the frame on desktop and fills the screen below 480px.
      className="fixed bottom-0 left-1/2 m-0 max-h-[85dvh] w-[var(--canvas-width)]
                 max-w-none -translate-x-1/2 overflow-y-auto overscroll-contain
                 rounded-t-[var(--radius-canvas)] bg-canvas p-0 text-ink
                 backdrop:bg-[rgba(0,0,0,0.4)]
                 max-[479px]:w-full"
    >
      <div className="px-[var(--gutter)] pt-[var(--space-11)] pb-[var(--space-19)]">
        {/* Not a control. `sheet.tsx`'s grab bar resizes; there is nothing to
            resize here, so this is the affordance's shape without its promise. */}
        <div
          aria-hidden
          className="mx-auto h-[var(--space-3)] w-[36px] rounded-[var(--radius-pill)] bg-surface-2"
        />

        <div className="mt-[var(--space-15)] flex items-start gap-[var(--space-9)]">
          <div className="min-w-0 flex-1">
            <h2
              id="modal-sheet-title"
              style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}
            >
              {title}
            </h2>
            {description ? (
              <p
                id="modal-sheet-desc"
                className="mt-[var(--space-5)] text-secondary"
                style={{ font: 'var(--type-meta)' }}
              >
                {description}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="닫기"
            className="-mr-[var(--space-7)] -mt-[var(--space-8)] flex size-[var(--tap-min)]
                       shrink-0 items-center justify-center rounded-[var(--radius-pill)]
                       text-secondary transition-opacity duration-200
                       active:opacity-[var(--press-opacity)]"
            style={{ font: 'var(--type-body)' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="mt-[var(--space-15)]">{children}</div>
      </div>
    </dialog>
  );
}
