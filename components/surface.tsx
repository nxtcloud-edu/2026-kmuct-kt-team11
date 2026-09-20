/**
 * Surface primitives.
 *
 * These exist so `.agents/visual-language.md`'s depth budget is enforced in one
 * place rather than by everyone remembering it. The record allows exactly three
 * shadows in the whole app — `--shadow-float`, `--shadow-card`, `--shadow-canvas`
 * — and none of them belongs on a card.
 *
 *   Card    — a tinted surface. No border, no shadow, no transition.
 *   Control — flat fill. Buttons and chips never lift and never hover.
 *
 * Grouping comes from the surface step (`--canvas` → `--surface-1` →
 * `--surface-2`), not from elevation. If a fourth kind of depth is ever needed,
 * that is a `visual-designer` decision — do not add a `shadow` prop here to
 * shortcut it.
 *
 * There is no hover vocabulary in this system: it is a touch app, and press
 * feedback is `--press-opacity`.
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
  return <As className={`bg-surface-1 rounded-[var(--radius-2xl)] ${className}`} {...rest} />;
}

/* ── Chip ─────────────────────────────────────────────────────────────────── */

/**
 * `danger` renders the red as a 2px rule, never as the words. `--status-cancel-fg`
 * on `--status-cancel-bg` measures 2.97:1 — it fails even the 3:1 UI threshold —
 * so `--ink` on the pastel (14.85:1) carries the label instead. The source system
 * sets that pair as text; that is a defect in it and is not adopted. The
 * measurement is in the record's contrast table and is not to be recomputed.
 */
export function Chip({
  tone = 'neutral',
  children,
  className = '',
  style,
  ...rest
}: ComponentProps<'span'> & { tone?: 'neutral' | 'danger' }) {
  const base =
    'inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1 whitespace-nowrap';
  // letter-spacing cannot live in the `font` shorthand, so --tag-ls is paired
  // with --type-tag here, at the call site, exactly as globals.css asks.
  const type = { font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)', ...style };

  return tone === 'danger' ? (
    <span
      className={`${base} bg-[var(--status-cancel-bg)] text-ink pl-1.5 ${className}`}
      style={type}
      {...rest}
    >
      <span
        aria-hidden
        className="mr-1 h-3.5 w-0.5 shrink-0 rounded-[var(--radius-photo)] bg-error"
      />
      {children}
    </span>
  ) : (
    <span className={`${base} bg-surface-2 text-secondary ${className}`} style={type} {...rest}>
      {children}
    </span>
  );
}

/* ── Button ───────────────────────────────────────────────────────────────── */

/**
 * Hierarchy by fill only. There is no accent colour to make a primary button out
 * of, so "primary" is ink-filled, "secondary" is a tinted fill and "quiet" is
 * nothing at all. Motion budget is opacity — no transform, no scale, no hover.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-lg)] px-5 ' +
  'h-[var(--field-height)] transition-opacity duration-200 ' +
  'active:opacity-[var(--press-opacity)] disabled:opacity-40 disabled:cursor-not-allowed';

const BUTTON_TONE: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-on-ink',
  secondary: 'bg-surface-2 text-ink',
  quiet: 'bg-transparent text-secondary',
};

export function Button({
  variant = 'secondary',
  className = '',
  style,
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  return (
    <button
      className={`${BUTTON_BASE} ${BUTTON_TONE[variant]} ${className}`}
      style={{ font: 'var(--type-button)', ...style }}
      {...rest}
    />
  );
}

/**
 * The same button, as a link.
 *
 * Exists because `<Link><Button/></Link>` is invalid: an `<a>` may not contain a
 * `<button>`, and browsers reparent it — which in practice means a tap can land
 * on the anchor, the button, or neither. The style recipe is shared with
 * `Button` above so the two cannot drift; only the element and its semantics
 * differ, and this one is a navigation, not an action.
 */
export function buttonClassName(variant: ButtonVariant = 'secondary'): string {
  return `${BUTTON_BASE} ${BUTTON_TONE[variant]}`;
}

/* ── ChoicePill ───────────────────────────────────────────────────────────── */

/**
 * A selectable pill. Onboarding asks the profile questions with these and the
 * account screen edits the same answers with them, so there is one definition —
 * two would be two chances for "selected" to mean two different things.
 *
 * Selection is an inverted fill rather than an outline, which is the one place
 * this system does invert: a pill carries no imagery for a fill to fight, and
 * `--ink` on `--on-ink` measures 17.40:1. The MBTI tiles go the other way for
 * exactly that reason — see components/mbti-picker.tsx.
 *
 * `aria-pressed` and not `role="radio"`: several of these groups are genuinely
 * optional, so "none pressed" has to be a legal and announced state, and a radio
 * group with no checked member is not.
 */
export function ChoicePill({
  selected,
  className = '',
  ...rest
}: ComponentProps<'button'> & { selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`flex h-[var(--tap-min)] items-center rounded-[var(--radius-pill)] px-[var(--space-11)] transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
        selected ? 'bg-ink text-on-ink' : 'bg-surface-2 text-secondary'
      } ${className}`}
      style={{ font: 'var(--type-meta)' }}
      {...rest}
    />
  );
}

/* ── Layout ───────────────────────────────────────────────────────────────── */

/**
 * The page column. No max-width of its own — the phone canvas constrains width
 * now, so a second constraint here would only fight it. Bottom padding reserves
 * the fixed tab bar's height plus its offset, so the last row of a list is never
 * parked underneath it.
 */
export function Content({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`w-full px-[var(--gutter)] pt-6 pb-[calc(var(--tab-bar-height)+var(--tab-bar-bottom)+24px)] ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <header className="mb-6">
      <h2 style={{ font: 'var(--type-tab-header)', letterSpacing: 'var(--tab-header-ls)' }}>
        {title}
      </h2>
      {meta ? (
        <p className="mt-1 text-secondary" style={{ font: 'var(--type-meta)' }}>
          {meta}
        </p>
      ) : null}
    </header>
  );
}
