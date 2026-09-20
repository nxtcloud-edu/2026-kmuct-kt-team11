/**
 * Surface primitives.
 *
 * These exist so `.agents/visual-language.md`'s depth budget is enforced by the
 * type system rather than by everyone remembering it. The record allows exactly
 * two recipes:
 *
 *   Card    — the 4-layer shadow. Only content the user came for may float.
 *   Control — `inset 0 0 0 0.5px` hairline. Buttons, chips and inputs never lift.
 *
 * If a third kind of depth is ever needed, that is a `visual-designer` decision.
 * Do not add a `shadow` prop here to shortcut it.
 */
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react';

/* ── Card ─────────────────────────────────────────────────────────────────── */

// Props are `HTMLAttributes<HTMLElement>` rather than `ComponentProps<'div'>`:
// ref and event-handler types are element-specific, so a div-shaped signature
// cannot be spread onto an <li>. The generic base is assignable to all four.
export function Card({
  as: As = 'div',
  className = '',
  ...rest
}: HTMLAttributes<HTMLElement> & { as?: 'div' | 'article' | 'section' | 'li' }) {
  return (
    <As
      className={`bg-surface-1 rounded-card shadow-card transition-shadow duration-300 ease-standard ${className}`}
      {...rest}
    />
  );
}

/* ── Chip ─────────────────────────────────────────────────────────────────── */

/**
 * `danger` renders the red as a 2px rule, never as the words. `#ED2B32` is
 * 4.21:1 and fails AA as body text — the measurement is in the record's
 * contrast table and is not to be recomputed.
 */
export function Chip({
  tone = 'neutral',
  children,
  className = '',
  ...rest
}: ComponentProps<'span'> & { tone?: 'neutral' | 'danger' }) {
  const base =
    'inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs whitespace-nowrap';
  return tone === 'danger' ? (
    <span className={`${base} bg-danger-fill text-ink pl-1.5 ${className}`} {...rest}>
      <span aria-hidden className="mr-1 h-3.5 w-0.5 shrink-0 rounded-sm bg-danger" />
      {children}
    </span>
  ) : (
    <span
      className={`${base} bg-fill text-ink-muted shadow-control ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

/* ── Button ───────────────────────────────────────────────────────────────── */

/**
 * One pill, hierarchy by fill inversion only. There is no accent colour to make
 * a primary button out of, so "primary" is ink-filled and "secondary" is not.
 * Motion budget is opacity and border — no transform, no scale on press.
 */
export function Button({
  variant = 'secondary',
  className = '',
  ...rest
}: ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'quiet' }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-pill px-5 py-2.5 text-base ' +
    'transition-[opacity,background-color,box-shadow] duration-200 ease-standard ' +
    'disabled:opacity-40 disabled:cursor-not-allowed';
  const tone = {
    primary:   'bg-ink text-surface-1 hover:opacity-90',
    secondary: 'bg-surface-1 text-ink shadow-control hover:bg-fill',
    quiet:     'bg-transparent text-ink-muted hover:text-ink',
  }[variant];
  return <button className={`${base} ${tone} ${className}`} {...rest} />;
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

/** 600px reading column, per the record's grid. Page padding is 96/16/48. */
export function Content({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mx-auto w-full max-w-[600px] px-4 pt-6 pb-24 ${className}`}>{children}</div>
  );
}

export function PageHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <header className="mb-6">
      <h2>{title}</h2>
      {meta ? <p className="mt-1 text-sm text-ink-muted">{meta}</p> : null}
    </header>
  );
}
