# Gaja StartView Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gaja's luma-derived visual language with StartView's design system, and add the five first-run screens: landing, sign-in, sign-up, onboarding and home.

**Architecture:** A 430px phone canvas centred on a grey backdrop, implemented once in the root layout so every route inherits it. StartView's six token files are vendored into `app/globals.css` and bridged into Tailwind v4 via `@theme inline`. Screens are built straight into production routes — no prototype namespace. Onboarding adds four nullable columns to `users` and extends the existing `PATCH /api/me`; no new endpoint is created.

**Tech Stack:** Next.js 16.3.5 App Router · React 19.2.8 · Tailwind v4 · Postgres 17 via `pg` · zod v4 · Supabase CLI for migrations

**Spec:** `docs/superpowers/specs/2026-09-20-gaja-startview-redesign-design.md`

## Global Constraints

- **There is no unit test runner in this repo.** Do not install vitest, jest or playwright. The test suite is `scripts/smoke.sh` — 40 curl assertions against live routes. API and schema work follows TDD *through that file*: add the failing case, run it, watch it fail, implement, watch it pass. UI work is verified by `npx tsc --noEmit`, `npm run lint`, `npm run build`, and by loading the page at 430px and 375px.
- **`scripts/smoke.sh` must stay green.** It requires a dev server and `supabase start`. Run it as: `npx next dev > /tmp/gaja-dev.log 2>&1 &` then `DEV_LOG=/tmp/gaja-dev.log bash scripts/smoke.sh`.
- **Korean, always**, for anything a user reads. English only in the wordmark, Latin numerals/units, and platform product names.
- **Register: polite informal** — `-요`/`-해요`. Never `-습니다` outside server-supplied notices.
- **Headings are nouns**, 2–6 characters. **Buttons are verb phrases** ending in `하기`, or a bare noun.
- **No emoji, anywhere.** Not in copy, not in empty states.
- **No terminal periods** on labels, chips or button text. `·` is the universal separator.
- **If there is no data behind a line, delete the line.** A section with no data is hidden entirely, heading included.
- **Gaja has no accent colour.** `#FFE600` and `#FEE500` are StartView's and are NOT vendored. A saturated value that is not semantic (`--like-red`, `--success`, `--error`, `--point-gold`, status pairs) is a bug.
- **Spacing is deliberately non-grid.** 5, 7, 9, 13, 18, 34px are intentional. Never snap to a 4/8 scale.
- **Line heights are absolute px.** Never convert to ratios.
- **Weight never exceeds 800**, and Poppins is structural only (wordmark, titles, section headings, onboarding headings, number figures). Inter is everything else.
- **Base resets go in `@layer base`.** Unlayered CSS outranks every layer and silently beats Tailwind utilities — this already bit this codebase once.
- **Commits carry no AI attribution.** No `Co-Authored-By`, no "Generated with". Imperative subject under ~72 chars, body explains *why*.
- **Contrast is measured, not assumed.** Ratios for this palette, computed before
  this plan was written — do not recompute, do not guess:

  | Pair | Ratio | Verdict |
  |---|---|---|
  | `--ink` on `--canvas` / `--surface-1` | 17.40 / 16.67 | AA body ✓ |
  | `--text-on-ink` on `--ink` | 17.40 | AA body ✓ |
  | `--text-secondary` on `--canvas` / `--surface-1` / `--surface-2` | 5.33 / 5.11 / 4.76 | AA body ✓ |
  | **`--text-tertiary` on `--canvas` / `--surface-1`** | **2.81 / 2.70** | **FAILS — decorative only** |
  | **`--status-cancel-fg` on `--status-cancel-bg`** | **2.97** | **FAILS even at 3:1** |
  | other `--status-*` and `--tag-*` pairs | 3.86–4.47 | large text / UI only |
  | `--ink` on `--status-cancel-bg` | 14.85 | AA body ✓ |

  **Two rules follow and both are load-bearing.** `--text-tertiary` may never carry
  text a user must read — dividers, disabled glyphs and placeholder marks only; use
  `--text-secondary` instead. And **the status and tag pairs may not carry body text**:
  set the label in `--ink` on the pastel background and let the saturated colour be a
  rule, an icon or the fill. The source system uses these pairs for text; that is a
  defect in it and is not adopted. Record this as a deviation in
  `.agents/visual-language.md`.
- **Source design system:** `~/Documents/startview-prototype/creator/_ds/startview-design-system-7416ce7c-06b5-400e-a350-b7ab509655f6` (referred to below as `$DS`).

---

## File Structure

**Created:**
- `public/fonts/*.woff2` — 8 vendored font files
- `app/globals.css` — rewritten: tokens + Tailwind bridge + base layer
- `app/canvas.tsx` — the phone-canvas shell, used once by the root layout
- `app/(public)/page.tsx` — landing (replaces `app/page.tsx`)
- `app/(public)/sign-up/page.tsx`, `app/(public)/sign-up/form.tsx`
- `app/(onboarding)/layout.tsx`, `app/(onboarding)/onboarding/page.tsx`, `.../steps.tsx`
- `app/(app)/home/page.tsx`
- `components/tab-bar.tsx` — replaces `components/app-shell.tsx`
- `lib/mbti.ts` — the type manifest
- `public/mbti/*.png` — character art
- `supabase/migrations/20260920000003_onboarding_profile.sql`

**Modified:**
- `.agents/visual-language.md` — record replaced, changelog bumped
- `components/surface.tsx`, `components/states.tsx` — restyled to the new grammar
- `lib/session.ts` — `SessionUser` and its SELECT gain the four new columns
- `app/api/me/route.ts` — `PATCH` accepts the new fields
- `app/(app)/layout.tsx` — onboarding gate
- `app/(public)/sign-in/page.tsx`, `form.tsx`, `social.tsx`, `sent/page.tsx` — restyled
- `scripts/smoke.sh` — new cases

**Deleted:**
- `app/page.tsx` (moves into `(public)`)
- `components/app-shell.tsx` (replaced by `tab-bar.tsx`)
- `app/prototype/` — its finding was derived from the retired luma premise; DEMO.md's own retirement rule says delete it once the direction changes

---

### Task 1: Vendor fonts and the token layer

**Files:**
- Create: `public/fonts/` (8 `.woff2` files)
- Modify: `app/globals.css` (full rewrite)
- Modify: `.agents/visual-language.md` (full rewrite)

**Interfaces:**
- Consumes: nothing
- Produces: CSS custom properties consumed by every later task — `--canvas`, `--surface-1`, `--surface-2`, `--divider`, `--hairline`, `--backdrop`, `--ink`, `--text-secondary`, `--text-tertiary`, `--text-on-ink`, `--like-red`, `--success`, `--error`, `--point-gold`, the `--status-*` and `--tag-*` pairs, `--type-display|screen-title|tab-header|section|body|card-title|button|meta|caption`, `--space-1..19`, `--gutter`, `--canvas-width`, `--section-gap`, `--field-height`, `--tap-min`, `--radius-photo|xs|sm|md|lg|xl|2xl|3xl|4xl|canvas|pill|circle`, `--shadow-float|card|canvas`, `--ease-nav|fade`, `--dur-push|modal|fade|tab`. Tailwind utilities `bg-canvas`, `bg-surface-1`, `bg-surface-2`, `text-ink`, `text-secondary`, `text-tertiary`, `rounded-lg|xl|2xl|3xl|4xl|pill`, `shadow-float`, `shadow-card`.

- [ ] **Step 1: Copy the fonts**

```bash
DS="$HOME/Documents/startview-prototype/creator/_ds/startview-design-system-7416ce7c-06b5-400e-a350-b7ab509655f6"
mkdir -p public/fonts
cp "$DS/assets/fonts/"*.woff2 public/fonts/
ls public/fonts/
```

Expected: 8 files — `inter-latin-{400,500,600,700}-normal.woff2`, `poppins-latin-{500,600,700,800}-normal.woff2`.

- [ ] **Step 2: Rewrite `app/globals.css`**

Replace the file entirely. Copy token *values* verbatim from `$DS/tokens/*.css`; do not reinterpret them. Omit `--yellow`, `--yellow-pressed` and `--kakao`.

```css
@import "tailwindcss";

/* Design tokens — transcribed from the StartView design system.
   Source: ~/Documents/startview-prototype/creator/_ds/startview-design-system-*/tokens/
   The record is `.agents/visual-language.md`; this file is its CSS transcription.

   Two omissions are deliberate: --yellow (#FFE600) and --kakao (#FEE500) are
   StartView's brand marks, and Gaja has its own brand. Gaja therefore has no
   accent colour, and a saturated value that is not semantic is a bug. */
:root {
  color-scheme: light;

  /* surfaces */
  --canvas:#FFFFFF;
  --surface-1:#FAFAFA;
  --surface-2:#F2F2F2;
  --divider:#ECECEC;
  --hairline:#F1F1F1;
  --backdrop:#E9E9EB;

  /* ink */
  --ink:#1A1A1A;
  --text-secondary:#6B6B6B;
  --text-tertiary:#9A9A9A;
  --text-on-ink:#FFFFFF;
  --icon-inactive:#C4C4C4;

  /* semantic — functional, not brand */
  --like-red:#FF2E63;
  --success:#1FB877;
  --error:#FF3B5C;
  --point-gold:#E9A400;

  /* scrims over imagery */
  --scrim:rgba(0,0,0,0.55);
  --wash-thumb:rgba(0,0,0,0.04);
  --scrim-badge:rgba(0,0,0,0.72);
  --puck-white:rgba(255,255,255,0.92);

  /* status pairs */
  --status-review-bg:#E6F0FB;  --status-review-fg:#2D6FB8;
  --status-picked-bg:#E4F5EC;  --status-picked-fg:#1F8A52;
  --status-done-bg:#E4F5EC;    --status-done-fg:#1FB877;
  --status-passed-bg:#F2F2F2;  --status-passed-fg:#9A9A9A;
  --status-cancel-bg:#FCE8EE;  --status-cancel-fg:#FF3B5C;

  /* tag pairs */
  --tag-mint-bg:#E4F5EC;     --tag-mint-fg:#1F8A52;
  --tag-blush-bg:#FCE8EE;    --tag-blush-fg:#C13E68;
  --tag-sky-bg:#E6F0FB;      --tag-sky-fg:#2D6FB8;
  --tag-butter-bg:#FFF6CC;   --tag-butter-fg:#8A7300;
  --tag-lavender-bg:#F0EAFB; --tag-lavender-fg:#7050B0;

  /* families */
  --font-display:'Poppins-ExtraBold';
  --font-display-bold:'Poppins-Bold';
  --font-display-semibold:'Poppins-SemiBold';
  --font-display-medium:'Poppins-Medium';
  --font-body:'Inter-Regular';
  --font-body-medium:'Inter-Medium';
  --font-body-semibold:'Inter-SemiBold';
  --font-body-bold:'Inter-Bold';
  --font-fallback-kr:'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;

  /* type — line heights are ABSOLUTE px, never ratios */
  --display-size:32px;      --display-lh:38px;      --display-ls:-0.5px;
  --screen-title-size:26px; --screen-title-lh:33px; --screen-title-ls:-0.3px;
  --tab-header-size:22px;   --tab-header-lh:29px;   --tab-header-ls:-0.3px;
  --post-title-size:18px;   --post-title-lh:24px;   --post-title-ls:-0.2px;
  --subheading-size:17px;   --subheading-lh:23px;   --subheading-ls:-0.1px;
  --section-size:18px;      --section-lh:24px;      --section-ls:-0.2px;
  --heading-size:24px;      --heading-ls:-0.4px;
  --wordmark-size:30px;     --wordmark-ls:-0.5px;
  --body-size:16px;         --body-lh:25px;
  --card-title-size:13px;   --card-title-lh:18px;
  --button-size:15px;       --button-lh:15px;
  --meta-size:13px;         --meta-lh:18px;
  --byline-size:11px;       --byline-lh:14px;
  --tag-size:11px;          --tag-lh:11px;          --tag-ls:0.1px;
  --tab-size:10px;          --tab-lh:10px;          --tab-ls:0.1px;
  --caption-size:12px;      --caption-lh:16px;

  --type-display:800 var(--display-size)/var(--display-lh) var(--font-display),var(--font-fallback-kr);
  --type-screen-title:700 var(--screen-title-size)/var(--screen-title-lh) var(--font-display-bold),var(--font-fallback-kr);
  --type-tab-header:600 var(--tab-header-size)/var(--tab-header-lh) var(--font-display-semibold),var(--font-fallback-kr);
  --type-section:500 var(--section-size)/var(--section-lh) var(--font-display-medium),var(--font-fallback-kr);
  --type-body:400 var(--body-size)/var(--body-lh) var(--font-body),var(--font-fallback-kr);
  --type-card-title:600 var(--card-title-size)/var(--card-title-lh) var(--font-body-semibold),var(--font-fallback-kr);
  --type-button:700 var(--button-size)/var(--button-lh) var(--font-body-bold),var(--font-fallback-kr);
  --type-meta:400 var(--meta-size)/var(--meta-lh) var(--font-body),var(--font-fallback-kr);
  --type-caption:400 var(--caption-size)/var(--caption-lh) var(--font-body),var(--font-fallback-kr);

  /* spacing — odd values are deliberate, do not snap to a 4/8 grid */
  --space-1:2px;  --space-2:3px;  --space-3:4px;  --space-4:5px;  --space-5:6px;
  --space-6:7px;  --space-7:8px;  --space-8:10px; --space-9:12px; --space-10:14px;
  --space-11:16px;--space-12:18px;--space-13:20px;--space-14:22px;--space-15:24px;
  --space-16:28px;--space-17:32px;--space-18:34px;--space-19:48px;

  --gutter:16px;
  --canvas-width:430px;
  --section-gap:28px;
  --section-gap-tight:22px;
  --section-gap-wide:48px;
  --rail-gap:12px;
  --tab-bar-height:62px;
  --tab-bar-bottom:16px;
  --field-height:56px;
  --search-height:46px;
  --tap-min:44px;

  /* radius */
  --radius-photo:2px; --radius-xs:6px;  --radius-sm:8px;  --radius-md:10px;
  --radius-lg:12px;   --radius-xl:14px; --radius-2xl:16px;--radius-3xl:18px;
  --radius-4xl:20px;  --radius-canvas:24px; --radius-pill:999px; --radius-circle:50%;

  /* elevation — only three shadows exist */
  --shadow-float:0 8px 20px rgba(0,0,0,0.1);
  --shadow-card:0 4px 12px rgba(0,0,0,0.06);
  --shadow-canvas:0 24px 60px rgba(0,0,0,0.18);
  --border-hairline:1px solid var(--divider);

  /* motion */
  --ease-nav:cubic-bezier(0.32,0.72,0,1);
  --ease-fade:ease-in-out;
  --dur-push:350ms; --dur-modal:400ms; --dur-fade:250ms; --dur-tab:0ms;
  --press-opacity:0.9; --press-opacity-strong:0.7; --press-scale:0.98;
}

/* Korean fallback: declared with local() only, so nothing is shipped. */
@font-face{font-family:'Apple SD Gothic Neo';src:local('Apple SD Gothic Neo'),local('AppleSDGothicNeo-Regular');font-weight:400;font-display:swap}
@font-face{font-family:'Apple SD Gothic Neo';src:local('Apple SD Gothic Neo Medium'),local('AppleSDGothicNeo-Medium');font-weight:500;font-display:swap}
@font-face{font-family:'Apple SD Gothic Neo';src:local('Apple SD Gothic Neo SemiBold'),local('AppleSDGothicNeo-SemiBold');font-weight:600;font-display:swap}
@font-face{font-family:'Apple SD Gothic Neo';src:local('Apple SD Gothic Neo Bold'),local('AppleSDGothicNeo-Bold');font-weight:700;font-display:swap}

@font-face{font-family:'Inter-Regular';src:url("/fonts/inter-latin-400-normal.woff2") format("woff2");font-weight:400;font-display:swap}
@font-face{font-family:'Inter-Medium';src:url("/fonts/inter-latin-500-normal.woff2") format("woff2");font-weight:500;font-display:swap}
@font-face{font-family:'Inter-SemiBold';src:url("/fonts/inter-latin-600-normal.woff2") format("woff2");font-weight:600;font-display:swap}
@font-face{font-family:'Inter-Bold';src:url("/fonts/inter-latin-700-normal.woff2") format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:'Poppins-Medium';src:url("/fonts/poppins-latin-500-normal.woff2") format("woff2");font-weight:500;font-display:swap}
@font-face{font-family:'Poppins-SemiBold';src:url("/fonts/poppins-latin-600-normal.woff2") format("woff2");font-weight:600;font-display:swap}
@font-face{font-family:'Poppins-Bold';src:url("/fonts/poppins-latin-700-normal.woff2") format("woff2");font-weight:700;font-display:swap}
@font-face{font-family:'Poppins-ExtraBold';src:url("/fonts/poppins-latin-800-normal.woff2") format("woff2");font-weight:800;font-display:swap}

@theme inline {
  --color-canvas:var(--canvas);
  --color-surface-1:var(--surface-1);
  --color-surface-2:var(--surface-2);
  --color-divider:var(--divider);
  --color-hairline:var(--hairline);
  --color-backdrop:var(--backdrop);
  --color-ink:var(--ink);
  --color-secondary:var(--text-secondary);
  --color-tertiary:var(--text-tertiary);
  --color-on-ink:var(--text-on-ink);
  --color-like-red:var(--like-red);
  --color-success:var(--success);
  --color-error:var(--error);
  --color-point-gold:var(--point-gold);

  --radius-photo:var(--radius-photo);
  --radius-xs:var(--radius-xs);
  --radius-sm:var(--radius-sm);
  --radius-md:var(--radius-md);
  --radius-lg:var(--radius-lg);
  --radius-xl:var(--radius-xl);
  --radius-2xl:var(--radius-2xl);
  --radius-3xl:var(--radius-3xl);
  --radius-4xl:var(--radius-4xl);
  --radius-pill:var(--radius-pill);

  --shadow-float:var(--shadow-float);
  --shadow-card:var(--shadow-card);
  --shadow-canvas:var(--shadow-canvas);

  --ease-nav:var(--ease-nav);
}

/* Base resets MUST stay in @layer base. Unlayered CSS outranks every layer, so a
   reset written outside one silently beats the utilities — this has already
   caused an invisible button in this codebase. */
@layer base {
  *,*::before,*::after{box-sizing:border-box}

  /* word-break:keep-all is the important one. Without it a browser breaks
     between any two Hangul syllables, splitting 어절 mid-word. */
  body{
    margin:0;
    font:var(--type-body);
    color:var(--ink);
    background:var(--backdrop);
    -webkit-font-smoothing:antialiased;
    -moz-osx-font-smoothing:grayscale;
    word-break:keep-all;
    overflow-wrap:break-word;
  }

  h1,h2,h3,h4,h5,h6{margin:0}
  p{margin:0}
  button{font-family:inherit;background:none;border:none;cursor:pointer;color:inherit}
  a{color:var(--ink);text-decoration:none}
  a,button,[role='button']{-webkit-tap-highlight-color:transparent;touch-action:manipulation}
  input,textarea,select{font:inherit;color:inherit}
  input::placeholder,textarea::placeholder{color:var(--text-tertiary)}
  :focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:4px}
}

@media (prefers-reduced-motion:reduce){
  :root{--dur-push:0ms;--dur-modal:0ms;--dur-fade:0ms}
  *,*::before,*::after{transition-duration:.01ms !important;animation-duration:.01ms !important}
}
```

- [ ] **Step 3: Verify it compiles and the tokens resolve**

```bash
npx tsc --noEmit && npm run lint && npm run build 2>&1 | grep -E 'Compiled|Error'
```

Expected: `✓ Compiled successfully`, no lint output, no type errors.

- [ ] **Step 4: Rewrite `.agents/visual-language.md`**

Replace the file. Keep the same section shape (Concept / Tokens / Rules / Deviations / Contrast) so downstream roles find what they expect. Required content:

- Header: `**Updated** 2026-09-20 · **Written by** the user, not visual-designer`
- Changelog entry: `2026-09-20: replaces the luma.com adoption of 2026-09-18 in full. Adopts the StartView design system. Gaja takes the system, not the brand — #FFE600 is StartView's and is not inherited, so Gaja still has no accent colour.`
- The token block above, in YAML, matching the CSS exactly.
- Rules, at minimum: no accent colour exists · colour enters through imagery only · depth budget is three shadows, cards sit on tinted surfaces instead · spacing is deliberately non-grid · line heights are absolute px · Poppins is structural, Inter is everything else · Korean line-breaking uses `word-break:keep-all` · no emoji.
- A note that the contrast table from the luma version described a different palette and does **not** transfer; the new table is filled in by Task 12.

- [ ] **Step 5: Commit**

```bash
git add public/fonts app/globals.css .agents/visual-language.md
git commit -m "Replace the luma direction with the StartView token layer

Vendors Poppins and Inter as real webfonts and transcribes StartView's colour,
type, spacing, radius, elevation and motion tokens into globals.css, bridged
into Tailwind with @theme inline.

Gaja takes the system and not the brand: --yellow and --kakao are StartView's
marks and are not vendored, so Gaja still has no accent colour and any
saturated value that is not semantic is a bug.

word-break:keep-all is carried over deliberately — without it browsers break
between any two Hangul syllables, splitting words mid-어절."
```

---

### Task 2: The phone canvas shell

**Files:**
- Create: `app/canvas.tsx`
- Modify: `app/layout.tsx`

**Interfaces:**
- Consumes: `--canvas-width`, `--radius-canvas`, `--shadow-canvas`, `--backdrop`, `--canvas` from Task 1
- Produces: `<Canvas>{children}</Canvas>` — wraps all routes; every page below it can assume a 430px-wide column

- [ ] **Step 1: Create `app/canvas.tsx`**

```tsx
/**
 * The phone canvas. 430px wide, centred on the grey backdrop, exactly as the
 * source system renders on desktop.
 *
 * Below 480px the frame is dropped entirely — no radius, no shadow, no
 * backdrop — and the app fills the viewport. A rounded card inside a phone is
 * a picture of an app; on a phone it should just be the app.
 */
export function Canvas({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh justify-center bg-backdrop max-[479px]:block max-[479px]:bg-canvas">
      <div
        className="relative flex min-h-dvh w-full max-w-[430px] flex-col bg-canvas
                   shadow-canvas max-[479px]:max-w-none max-[479px]:shadow-none
                   min-[480px]:my-0 min-[480px]:rounded-[var(--radius-canvas)]"
      >
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wrap the root layout**

Modify `app/layout.tsx` — keep `lang="ko"`, keep the metadata template, wrap `{children}`:

```tsx
import { Canvas } from './canvas';
// ...
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ko">
      <body>
        <Canvas>{children}</Canvas>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Verify at both widths**

```bash
npm run build 2>&1 | grep -E 'Compiled|Error'
npx next dev > /tmp/gaja-dev.log 2>&1 &
sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/sign-in
```

Then load `http://localhost:3000/sign-in` in a browser at **1024px** and confirm: a 430px white column, 24px corners, drop shadow, grey `#E9E9EB` around it. Resize to **375px** and confirm: full-bleed white, no shadow, no rounded corners, and **no horizontal scrollbar**.

- [ ] **Step 4: Commit**

```bash
git add app/canvas.tsx app/layout.tsx
git commit -m "Render every route inside the 430px phone canvas

Matches the source system, which designs one surface at phone width and centres
it on a grey backdrop for desktop. Below 480px the frame is dropped entirely:
on an actual phone the app should be the app, not a picture of one."
```

---

### Task 3: Restyle the surface and state primitives

**Files:**
- Modify: `components/surface.tsx`
- Modify: `components/states.tsx`

**Interfaces:**
- Consumes: tokens from Task 1
- Produces: `Card`, `Chip`, `Button`, `Content`, `PageHeader` (unchanged names and props) · `Notice`, `ListSkeleton`, `EmptyState`, `ErrorState`, `NotAllowedState`, `OfflineState` (unchanged names and props). Existing call sites in `/saved-places`, `/groups`, `/account` must keep working without edits.

- [ ] **Step 1: Restyle `Card`**

The four-layer shadow is gone. Cards are **tinted surfaces with no border and no shadow** — this single decision drives the system. Replace the class string in `Card` with:

```tsx
className={`bg-surface-1 rounded-[var(--radius-2xl)] ${className}`}
```

Delete the `transition-shadow` — nothing about a card animates.

- [ ] **Step 2: Restyle `Chip`**

```tsx
const base =
  'inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1 whitespace-nowrap';
// neutral: bg-surface-2 text-secondary, font:var(--type-tag)
// danger:  bg-[var(--status-cancel-bg)] text-[var(--status-cancel-fg)]
```

The `danger` tone sets its label in **`--ink`**, not in `--status-cancel-fg`. Measured,
that pair is 2.97:1 — it fails even the 3:1 UI threshold, so the saturated colour stays
a 2px rule and `--ink` on `--status-cancel-bg` (14.85:1) carries the words:

```tsx
// danger: bg-[var(--status-cancel-bg)] text-ink, with a 2px --error rule before the label
```

The source system sets these pairs as text. That is a defect in it, and adopting the
system does not mean adopting the defect.

- [ ] **Step 3: Restyle `Button`**

```tsx
const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-lg)] px-5 ' +
  'h-[var(--field-height)] transition-opacity duration-200 ' +
  'active:opacity-[var(--press-opacity)] disabled:opacity-40 disabled:cursor-not-allowed';
const tone = {
  primary:   'bg-ink text-on-ink',
  secondary: 'bg-surface-2 text-ink',
  quiet:     'bg-transparent text-secondary',
}[variant];
```

Apply `font: var(--type-button)` via inline style or a utility. Note there is **no hover vocabulary** in this system — it is a touch app; press feedback is opacity.

- [ ] **Step 4: Restyle `Content` and `PageHeader`**

`Content` drops `max-w-[600px]` (the canvas now constrains width) and uses the gutter:

```tsx
<div className={`w-full px-[var(--gutter)] pt-6 pb-[calc(var(--tab-bar-height)+var(--tab-bar-bottom)+24px)] ${className}`}>
```

`PageHeader`'s title takes `font: var(--type-tab-header)`; `meta` takes `var(--type-meta)` in `--text-secondary`.

- [ ] **Step 5: Update `states.tsx`**

`Notice`'s `danger` tone loses the `border-l-2 border-danger` and uses `bg-[var(--status-cancel-bg)]`. `ListSkeleton`'s placeholder blocks change `bg-fill` → `bg-surface-2` and the card wrapper picks up the new `Card`. `ErrorState`'s `request_id` line takes `var(--type-caption)` in `--text-secondary`.

- [ ] **Step 6: Verify existing screens still render**

```bash
npx tsc --noEmit && npm run lint && npm run build 2>&1 | grep -E 'Compiled|Error'
```

Then sign in via `bash scripts/seed-prototype.sh` and load `/saved-places`, `/groups`, `/account`. Confirm each renders without layout breakage and no element carries a drop shadow.

- [ ] **Step 7: Commit**

```bash
git add components/surface.tsx components/states.tsx
git commit -m "Restyle the primitives to tinted surfaces

The four-layer card shadow is gone. In this system cards are tinted surfaces
with no border and no shadow, and only three shadows exist in the whole app —
none of them on a card. Chip's danger tone now uses the designed status pair
rather than the 2px rule the previous palette needed, because that pair is
built to carry text.

Component names and props are unchanged, so /saved-places, /groups and
/account pick the new look up without edits."
```

---

### Task 4: Schema — the onboarding profile columns

**Files:**
- Create: `supabase/migrations/20260920000003_onboarding_profile.sql`
- Modify: `scripts/smoke.sh`

**Interfaces:**
- Consumes: nothing
- Produces: `users.gender`, `users.age_band`, `users.mbti`, `users.onboarded_at` — all nullable

- [ ] **Step 1: Write the failing smoke case**

Add to `scripts/smoke.sh`, immediately before the `── sign out ──` section:

```bash
echo "── onboarding profile ─────────────────────────────────────────────────"
r=$(req -X PATCH "$BASE/api/me" -H 'content-type: application/json' \
      -d '{"gender":"female","age_band":"20s","mbti":"INFJ","home_area":"성수"}')
ck "PATCH /me accepts the onboarding fields" 200 "$(code "$r")" \
   "$([ "$(body "$r" | jget "['mbti']")" = "INFJ" ] && echo ok || echo 'mbti not returned')"

r=$(req -X PATCH "$BASE/api/me" -H 'content-type: application/json' -d '{"mbti":"XXXX"}')
ck "an invalid MBTI is 422" 422 "$(code "$r")"

r=$(req -X PATCH "$BASE/api/me" -H 'content-type: application/json' -d '{"age_band":"99s"}')
ck "an invalid age_band is 422" 422 "$(code "$r")"
```

- [ ] **Step 2: Run it and watch it fail**

```bash
DEV_LOG=/tmp/gaja-dev.log bash scripts/smoke.sh 2>&1 | tail -8
```

Expected: `43 total`, with the three new cases failing — `mbti not returned` because the column does not exist and `PATCH` ignores unknown fields (`Body` is `.passthrough()`), and the two validation cases returning 200 instead of 422.

- [ ] **Step 3: Write the migration**

```sql
-- Onboarding profile.
--
-- Four nullable columns for the four things onboarding asks after the nickname.
-- display_name is reused as the nickname rather than adding a column: it is
-- already not null, already rendered in groups, and a second name field would
-- immediately raise the question of which one is shown where.
--
-- age_band, not an exact age. It buckets identically for recommendation
-- purposes and is materially less invasive to ask of someone who has just
-- arrived. Every column here is optional; only the nickname is required, and
-- that one already existed.

alter table users
  add column gender       text check (gender in ('female','male','undisclosed')),
  add column age_band     text check (age_band in ('10s','20s','30s','40s','50plus')),
  add column mbti         text check (mbti ~ '^[EI][SN][TF][JP]$'),
  -- Set when onboarding finishes, whether or not the optional steps were
  -- answered. Skipping is a valid answer; being asked twice is not.
  add column onboarded_at timestamptz;

create index users_onboarded_idx on users (onboarded_at) where onboarded_at is null;
```

No RLS or grant statements are needed: `20260920000001` already enabled RLS on `users` and revoked the roles, and `alter table ... add column` inherits both.

- [ ] **Step 4: Apply locally and confirm the columns exist**

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -q \
  -f supabase/migrations/20260920000003_onboarding_profile.sql
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -At -c \
  "select string_agg(column_name,',' order by column_name) from information_schema.columns
    where table_name='users' and column_name in ('gender','age_band','mbti','onboarded_at');"
```

Expected: `age_band,gender,mbti,onboarded_at`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260920000003_onboarding_profile.sql scripts/smoke.sh
git commit -m "Add the onboarding profile columns

Four nullable columns for what onboarding asks after the nickname. display_name
is reused as the nickname rather than adding a second name field.

age_band rather than an exact age: it buckets identically for recommendations
and is less invasive to ask on first run. onboarded_at records that the flow
finished, whether or not the optional steps were answered — skipping is a valid
answer, being asked twice is not.

RLS and the revoked grants are inherited from 20260920000001; added columns do
not need them restated."
```

---

### Task 5: `PATCH /api/me` accepts the profile fields

**Files:**
- Modify: `lib/session.ts`
- Modify: `app/api/me/route.ts`

**Interfaces:**
- Consumes: the columns from Task 4
- Produces: `SessionUser` gains `gender: Gender | null`, `age_band: AgeBand | null`, `mbti: string | null`, `onboarded_at: Date | null`. `toMe()` returns the same four. `PATCH /api/me` accepts them.

- [ ] **Step 1: Extend `SessionUser` and its SELECT in `lib/session.ts`**

```ts
export type Gender = 'female' | 'male' | 'undisclosed';
export type AgeBand = '10s' | '20s' | '30s' | '40s' | '50plus';

export type SessionUser = {
  // ...existing fields unchanged...
  gender: Gender | null;
  age_band: AgeBand | null;
  mbti: string | null;
  onboarded_at: Date | null;
};
```

Add `u.gender, u.age_band, u.mbti, u.onboarded_at` to the SELECT list in `currentUser()`, and the same four (unprefixed) to the `returning` clauses in `app/api/auth/session/route.ts` — there are **three** of them, one per branch. Missing one produces `undefined` for that branch only, which is exactly the kind of bug that survives a smoke run.

Extend `toMe()`:

```ts
    gender: u.gender,
    age_band: u.age_band,
    mbti: u.mbti,
    onboarded: u.onboarded_at !== null,
```

- [ ] **Step 2: Extend the `PATCH` body and SQL in `app/api/me/route.ts`**

```ts
const Body = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    locale: z.enum(['ko', 'en']).optional(),
    home_area: z.string().max(80).nullable().optional(),
    profile_visible_in_groups: z.boolean().optional(),
    gender: z.enum(['female', 'male', 'undisclosed']).nullable().optional(),
    age_band: z.enum(['10s', '20s', '30s', '40s', '50plus']).nullable().optional(),
    // Validated here as well as by the CHECK so a typo is a 422 with a field
    // name, not a 500 from a constraint violation.
    mbti: z.string().regex(/^[EI][SN][TF][JP]$/, 'Not a valid MBTI type.').nullable().optional(),
    onboarded: z.literal(true).optional(),
  })
  .passthrough();
```

In the UPDATE, follow the existing `home_area` idiom — a presence boolean plus a value, so that an explicit `null` clears the field and an absent key leaves it alone:

```sql
        gender       = case when $7::boolean  then $8  else gender end,
        age_band     = case when $9::boolean  then $10 else age_band end,
        mbti         = case when $11::boolean then $12 else mbti end,
        onboarded_at = case when $13::boolean then now() else onboarded_at end,
```

with parameters `'gender' in body, body.gender ?? null, 'age_band' in body, body.age_band ?? null, 'mbti' in body, body.mbti ?? null, body.onboarded === true`. Add the four new columns to the `returning` list.

- [ ] **Step 3: Run the smoke suite and watch the new cases pass**

```bash
DEV_LOG=/tmp/gaja-dev.log bash scripts/smoke.sh 2>&1 | tail -8
```

Expected: `43 passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add lib/session.ts app/api/me/route.ts app/api/auth/session/route.ts
git commit -m "Accept the onboarding profile fields on PATCH /me

MBTI is validated in zod as well as by the CHECK constraint so a typo comes
back as a 422 naming the field rather than a 500 from a constraint violation.

The nullable fields follow the existing home_area idiom — a presence boolean
plus a value — so an explicit null clears a field while an absent key leaves it
untouched. onboarded is write-once-ish: it sets the timestamp and never clears
it, because 'I finished onboarding' is not a thing that becomes false."
```

---

### Task 6: MBTI assets and manifest

**Files:**
- Create: `public/mbti/*.png`
- Create: `lib/mbti.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `MBTI_TYPES: readonly MbtiType[]` — the types that actually have art · `type MbtiType = string` (4 letters) · `mbtiImage(t: MbtiType): string`

- [ ] **Step 1: Copy the art**

```bash
mkdir -p public/mbti
cp ~/Downloads/mbit-new/*.png public/mbti/
ls public/mbti/ | wc -l
```

Expected: 15. `ISFJ-1.png` is a duplicate filename, not a duplicate type — see Step 3.

- [ ] **Step 2: Remove the mislabelled file for now**

```bash
rm public/mbti/ISFJ-1.png
ls public/mbti/ | sed 's/\.png//' | sort | tr '\n' ' '
```

Expected: `ENFJ ENFP ENTJ ENTP ESFJ ESFP ESTJ ESTP INFJ INFP INTJ ISFJ ISFP ISTP`  — 14 types.

`ISFJ-1.png` is a dark-blue figure in rectangular glasses holding a document; it is almost certainly the missing **ISTJ**, but it must be confirmed by a human before being renamed and shipped. **ISTJ and INTP remain missing.**

- [ ] **Step 3: Create `lib/mbti.ts`**

```ts
/**
 * The MBTI types Gaja can actually show.
 *
 * Driven by which character illustrations exist, not by the canonical 16 — two
 * are still missing (ISTJ, INTP) and a picker with empty cells is worse than a
 * shorter picker. Adding the art and adding the string here is the whole change.
 *
 * `잘 모르겠어요` is not a type; it is rendered as an extra cell by the step and
 * writes null, because forcing a guess poisons the recommendations this exists
 * to feed.
 */
export const MBTI_TYPES = [
  'INFJ', 'INFP', 'INTJ', 'ISFJ', 'ISFP', 'ISTP',
  'ENFJ', 'ENFP', 'ENTJ', 'ENTP', 'ESFJ', 'ESFP', 'ESTJ', 'ESTP',
] as const;

export type MbtiType = (typeof MBTI_TYPES)[number];

export function mbtiImage(t: MbtiType): string {
  return `/mbti/${t}.png`;
}

export function isMbtiType(v: string): v is MbtiType {
  return (MBTI_TYPES as readonly string[]).includes(v);
}
```

- [ ] **Step 4: Verify every declared type has a file**

```bash
node -e "
const fs=require('fs');
const {MBTI_TYPES}=['INFJ','INFP','INTJ','ISFJ','ISFP','ISTP','ENFJ','ENFP','ENTJ','ENTP','ESFJ','ESFP','ESTJ','ESTP'].reduce((a,t)=>a,{MBTI_TYPES:['INFJ','INFP','INTJ','ISFJ','ISFP','ISTP','ENFJ','ENFP','ENTJ','ENTP','ESFJ','ESFP','ESTJ','ESTP']});
const missing=MBTI_TYPES.filter(t=>!fs.existsSync('public/mbti/'+t+'.png'));
console.log(missing.length?'MISSING: '+missing.join(','):'all 14 present');
"
```

Expected: `all 14 present`

- [ ] **Step 5: Commit**

```bash
git add public/mbti lib/mbti.ts
git commit -m "Add the MBTI character art and its manifest

The manifest lists the types that have illustrations rather than the canonical
sixteen. ISTJ and INTP have no art yet, and a picker with empty cells is worse
than a shorter picker — adding the file and the string is the whole change when
they arrive.

ISFJ-1.png is held back rather than shipped: it is not a second ISFJ but a
distinct character that reads as the missing ISTJ, and that needs confirming by
someone before it is renamed."
```

---

### Task 7: Landing at `/`

**Files:**
- Delete: `app/page.tsx`
- Create: `app/(public)/page.tsx`
- Modify: `app/(public)/layout.tsx`

**Interfaces:**
- Consumes: `currentUser()` from `lib/session`, `Button` from Task 3
- Produces: `/` renders the landing when signed out; redirects otherwise

- [ ] **Step 1: Delete the old root page and widen the public layout**

```bash
git rm app/page.tsx
```

`app/(public)/layout.tsx` currently centres a 380px column. The canvas now constrains width, so change it to a full-height flex column with the gutter:

```tsx
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col px-[var(--gutter)]">{children}</div>;
}
```

- [ ] **Step 2: Create `app/(public)/page.tsx`**

```tsx
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { currentUser } from '@/lib/session';

/**
 * Landing. Type-led on purpose: the source system's login screen rests on a
 * three-panel hero illustration, Gaja has no such asset, and inventing one
 * would break the content rule this design adopts — if there is nothing behind
 * a line, there is no line. No screenshots, no illustration, no social proof.
 */
export default async function Landing() {
  const user = await currentUser();
  if (user) redirect(user.onboarded_at ? '/home' : '/onboarding');

  return (
    <main className="flex flex-1 flex-col justify-between py-[var(--space-19)]">
      <div>
        <p style={{ font: `500 var(--wordmark-size)/1.1 var(--font-display-medium), var(--font-fallback-kr)`,
                    letterSpacing: 'var(--wordmark-ls)' }}>
          Gaja
        </p>
        <h1 className="mt-[var(--space-15)]"
            style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}>
          저장만 해두고<br />못 가본 곳들
        </h1>
        <p className="mt-[var(--space-9)] text-secondary" style={{ font: 'var(--type-body)' }}>
          인스타에서 저장한 릴스를 하루 코스로 묶어드려요
        </p>

        <ul className="mt-[var(--space-17)] flex list-none flex-col gap-[var(--space-11)] p-0">
          {[
            '릴스를 공유하면 장소를 찾아드려요',
            '영업시간과 웨이팅까지 확인해요',
            '동선에 맞춰 하루를 짜드려요',
          ].map((line) => (
            <li key={line} className="flex gap-[var(--space-8)] text-secondary"
                style={{ font: 'var(--type-meta)' }}>
              {/* decorative only — --text-tertiary is 2.81:1 and may not carry words */}
              <span aria-hidden className="text-tertiary">·</span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-[var(--space-8)]">
        <Link href="/sign-up"
              className="flex h-[var(--field-height)] items-center justify-center rounded-[var(--radius-lg)] bg-ink text-on-ink"
              style={{ font: 'var(--type-button)' }}>
          시작하기
        </Link>
        <Link href="/sign-in"
              className="flex h-[var(--tap-min)] items-center justify-center text-secondary"
              style={{ font: 'var(--type-meta)' }}>
          이미 계정이 있어요
        </Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Verify the three routing states**

```bash
npm run build 2>&1 | grep -E 'Compiled|Error'
curl -s -o /dev/null -w 'signed out / -> %{http_code}\n' http://localhost:3000/
curl -s http://localhost:3000/ | grep -oE 'Gaja|시작하기|이미 계정이 있어요' | sort -u
```

Expected: `200`, and all three strings present. Then sign in with `bash scripts/seed-prototype.sh` and confirm in a browser that `/` redirects (to `/onboarding`, since the seeded user has no `onboarded_at` yet).

- [ ] **Step 4: Commit**

```bash
git add -A app/\(public\)/page.tsx app/\(public\)/layout.tsx app/page.tsx
git commit -m "Add the landing screen and move / into the public group

/ is now the signed-out entry rather than a redirect. It is type-led: the
source system's login screen rests on a hero illustration that Gaja does not
have, and inventing one would break the content rule this design adopts.

Signed-in visitors are sent to /home, or to /onboarding if they have not
finished it."
```

---

### Task 8: `/sign-up`, and sign-in restyled

**Files:**
- Create: `app/(public)/sign-up/page.tsx`, `app/(public)/sign-up/form.tsx`
- Modify: `app/(public)/sign-in/page.tsx`, `form.tsx`, `social.tsx`, `sent/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `NetworkError` from `lib/api/client`; `socialSignInConfigured()` from `lib/supabase`
- Produces: `/sign-up` posting to the same `POST /api/auth/magic-link`

- [ ] **Step 1: Create the sign-up form**

Copy `app/(public)/sign-in/form.tsx` to `app/(public)/sign-up/form.tsx` and change only the copy — the endpoint, the error map and the `next` handling are identical and must stay identical. Export it as `SignUpForm`. Button label: `가입 링크 받기`. On success it routes to `/sign-in/sent`, the same terminal screen.

Add a header comment stating why this is a copy rather than a shared component:

```tsx
/**
 * Deliberately a sibling of sign-in/form.tsx rather than a shared component
 * with a `mode` prop. The two screens post to the same endpoint today, but
 * sign-up is where terms, a referral code or a channel pre-selection would land
 * if any of them are ever added — and a boolean-flagged twin is harder to split
 * later than two files are to keep in step now.
 */
```

- [ ] **Step 2: Create `app/(public)/sign-up/page.tsx`**

Mirror the sign-in page structure. Title `회원가입` at `var(--type-screen-title)`. Subcopy: `이메일만 있으면 돼요. 비밀번호는 없어요.` Terms line below the button in `var(--type-caption)`, **`--text-secondary`** (not `--text-tertiary`, which fails at 2.81:1): `가입하면 이용약관과 개인정보처리방침에 동의하는 것으로 봐요`. Footer link to `/sign-in` reading `이미 계정이 있어요`.

- [ ] **Step 3: Restyle sign-in**

In `page.tsx`: title to `var(--type-screen-title)`, subcopy to `var(--type-meta)` in `--text-secondary`, add a footer link to `/sign-up` reading `아직 계정이 없어요`.

In `form.tsx`: the input becomes `h-[var(--field-height)] bg-surface-1 rounded-[var(--radius-2xl)] px-[var(--space-11)]` with no ring and no border; the invalid state swaps the background to `var(--status-cancel-bg)` rather than adding a red rule. The error paragraph takes `var(--type-caption)`.

In `social.tsx`: the Google link takes the `secondary` Button treatment — `bg-surface-2 text-ink rounded-[var(--radius-lg)] h-[var(--field-height)]`.

In `sent/page.tsx`: card becomes `bg-surface-1 rounded-[var(--radius-2xl)]`, no shadow.

- [ ] **Step 4: Verify both doors hit one endpoint**

```bash
npx tsc --noEmit && npm run lint && npm run build 2>&1 | grep -E 'Compiled|Error'
grep -c "'/auth/magic-link'" "app/(public)/sign-in/form.tsx" "app/(public)/sign-up/form.tsx"
```

Expected: `1` for each file. Then load both screens and submit a fresh address on each; both must land on `/sign-in/sent`.

- [ ] **Step 5: Commit**

```bash
git add "app/(public)"
git commit -m "Add the sign-up screen and restyle sign-in

Two doors, one endpoint. The dual semantics in POST /api/auth/session decide
the outcome at exchange time from whether a session exists, not from which
screen the request came from — so someone arriving at 회원가입 with an existing
account is signed in, and neither door can produce a wrong result.

sign-up/form.tsx is a sibling rather than a shared component with a mode flag:
it is where terms or a referral code would land, and a boolean-flagged twin is
harder to split later than two files are to keep in step now."
```

---

### Task 9: Onboarding

**Files:**
- Create: `app/(onboarding)/layout.tsx`, `app/(onboarding)/onboarding/page.tsx`, `app/(onboarding)/onboarding/steps.tsx`
- Modify: `app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `requireSession()` from `lib/require-session`, `MBTI_TYPES`/`mbtiImage` from Task 6, `apiFetch` from `lib/api/client`, `PATCH /api/me` from Task 5
- Produces: `/onboarding`; `(app)` routes gated on `onboarded_at`

- [ ] **Step 1: Create the onboarding group layout**

```tsx
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/require-session';

/**
 * Its own route group, not part of (app): it needs a session but must NOT be
 * behind the onboarding gate, or it would redirect to itself forever. It also
 * gets no tab bar — there is nowhere else to go until this is finished.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  if (user.onboarded_at) redirect('/home');
  return <div className="flex min-h-dvh flex-col px-[var(--gutter)]">{children}</div>;
}
```

- [ ] **Step 2: Add the gate to `app/(app)/layout.tsx`**

```tsx
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  // Onboarding is not optional-but-skippable at the route level: every step
  // inside it can be skipped, but the flow itself runs once before the app.
  if (!user.onboarded_at) redirect('/onboarding');
  return <TabBarShell user={user}>{children}</TabBarShell>;
}
```

(`TabBarShell` arrives in Task 10; until then keep the existing `AppShell` import so the tree builds.)

- [ ] **Step 3: Build `steps.tsx` as a client component**

A single client component owning `step` (0–3) and a draft object. Cross-fade between steps at `var(--dur-fade)` on `var(--ease-fade)` — opacity only, no transform, because the system's motion budget has no transforms.

Each step renders: a progress row (`4단계 중 N`, `var(--type-caption)`, **`--text-secondary`**), a heading at `var(--heading-size)` Poppins-Medium with `var(--heading-ls)`, the control, then `다음` (primary) and — on steps 2–4 — `건너뛰기` (quiet).

- **Step 1 닉네임:** `어떻게 부를까요?` · text input, `--field-height`, `bg-surface-1`, `rounded-[var(--radius-2xl)]`. `다음` disabled while empty. **Not skippable.**
- **Step 2 성별 · 연령대:** `조금만 알려주세요` · two segmented rows of pill buttons. 성별: `여성 · 남성 · 선택 안 함`. 연령대: `10대 · 20대 · 30대 · 40대 · 50대+`. Selected pill is `bg-ink text-on-ink`; unselected `bg-surface-2 text-secondary`.
- **Step 3 MBTI:** `MBTI가 어떻게 되세요?` · `grid-cols-4 gap-[var(--space-8)]` over `MBTI_TYPES`, each cell an image at `rounded-[var(--radius-md)] bg-surface-2` with the 4-letter label beneath in `var(--type-tag)`. A final full-width `잘 모르겠어요` cell writes `null`.
- **Step 4 활동 지역:** `주로 어디서 노세요?` · pill grid of Seoul areas — `성수 · 연남 · 한남 · 강남 · 을지로 · 홍대 · 압구정 · 여의도 · 잠실 · 기타`. Writes `home_area`.

On finish, one request:

```ts
await apiFetch('/me', { method: 'PATCH', body: { ...draft, onboarded: true } });
router.replace('/home');
router.refresh(); // the (app) gate reads onboarded_at from a fresh server render
```

Skipping a step simply omits that key from `draft`; `PATCH` leaves absent keys alone.

- [ ] **Step 4: Verify the flow and the gate**

```bash
npm run build 2>&1 | grep -E 'Compiled|Error'
```

Reset the seeded user and walk it:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "update users set onboarded_at=null, mbti=null, gender=null, age_band=null where email='proto@example.com';"
```

Then in a browser: `/home` must redirect to `/onboarding`. Complete all four steps. Confirm it lands on `/home`, and:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -At -c \
  "select display_name, gender, age_band, mbti, home_area, onboarded_at is not null
     from users where email='proto@example.com';"
```

Expected: the values you entered, and `t`. Reload `/onboarding` — it must now redirect to `/home`.

- [ ] **Step 5: Commit**

```bash
git add "app/(onboarding)" "app/(app)/layout.tsx"
git commit -m "Add onboarding and gate the app behind it

Four steps: nickname, gender and age band, MBTI, and home area. Only the
nickname is required — every other step can be skipped, and skipping writes
nothing for that field while still completing the flow, because skipping is an
answer and being asked twice is not.

MBTI offers 잘 모르겠어요 for the same reason: a forced guess would poison the
recommendations the question exists to feed.

It lives in its own route group rather than under (app) because it needs a
session but must not sit behind the onboarding gate, which would redirect it to
itself."
```

---

### Task 10: The floating tab bar

**Files:**
- Create: `components/tab-bar.tsx`
- Delete: `components/app-shell.tsx`
- Modify: `app/(app)/layout.tsx`

**Interfaces:**
- Consumes: tokens from Task 1
- Produces: `TabBarShell({ displayName, children })`

- [ ] **Step 1: Create `components/tab-bar.tsx`**

Client component (needs `usePathname`). A fixed pill, `height: var(--tab-bar-height)`, `bottom: var(--tab-bar-bottom)`, `border-radius: var(--radius-3xl)`, `box-shadow: var(--shadow-float)`, `background: var(--canvas)`, centred and constrained to the canvas width minus two gutters.

Four tabs: `홈 → /home`, `저장한 곳 → /saved-places`, `그룹 → /groups`, `계정 → /account`. Labels at `var(--type-tab)` — `--tab-size 10px`, Inter-Medium, `--tab-ls 0.1px`. Active is `--ink`; inactive is `--icon-inactive`.

```tsx
/**
 * Tab switches are instant. The bar renders inside the animating subtree, so
 * giving tab routes a transition would slide the bar itself — the source system
 * sets --dur-tab to 0ms for exactly this reason.
 */
```

Because the bar is fixed, `Content`'s bottom padding (Task 3, Step 4) already reserves room for it; do not add margin to individual pages.

- [ ] **Step 2: Swap it into `app/(app)/layout.tsx` and delete the old shell**

```bash
git rm components/app-shell.tsx
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit && npm run lint && npm run build 2>&1 | grep -E 'Compiled|Error'
grep -rn 'app-shell' app components || echo "no stale imports"
```

Expected: no stale imports. Then load each of the four tabs and confirm the active label is ink, the others grey, the bar does not move between tabs, and no page content is hidden behind it at 375px.

- [ ] **Step 4: Commit**

```bash
git add components/tab-bar.tsx "app/(app)/layout.tsx" components/app-shell.tsx
git commit -m "Replace the top header with a floating tab bar

Four tabs in a fixed pill, one of only three elevated things in this system.
Tab switches are instant: the bar renders inside the animating subtree, so a
transition on tab routes would slide the bar itself.

The fourth tab is 계정, matching the existing page title rather than introducing
a second name for the same destination."
```

---

### Task 11: Home

**Files:**
- Create: `app/(app)/home/page.tsx`
- Modify: `lib/saved-places.ts`

**Interfaces:**
- Consumes: `requireSession()`, `listSavedPlacesForUser()`, `query` from `lib/db`
- Produces: `/home`

- [ ] **Step 1: Add an area query to `lib/saved-places.ts`**

```ts
/**
 * Places in an area, excluding ones this user already saved — a "near you"
 * section that shows what you have already got is not a recommendation.
 */
export async function listPlacesNearby(area: string, userId: string, limit = 10) {
  return query<{ id: string; name: string; category: string; area: string }>(
    `select p.id, p.name, p.category, p.area
       from places p
      where p.area = $1
        and not exists (select 1 from saved_places sp
                         where sp.place_id = p.id and sp.user_id = $2)
      order by p.created_at desc
      limit $3`,
    [area, userId, limit],
  );
}
```

- [ ] **Step 2: Build `app/(app)/home/page.tsx`**

```tsx
/**
 * Home.
 *
 * Every section is hidden entirely — heading included — when it has no data.
 * That is the adopted system's strongest content rule and it is load-bearing
 * here rather than decorative: there is no recommendation engine yet, so the
 * MBTI section does not render at all. Day one this screen is honestly the
 * saved places and whatever is near you, and that is the correct output of the
 * rule, not a gap.
 */
```

Structure: greeting row (`{display_name}님`, `var(--type-tab-header)`; beneath it `오늘 어디 갈까요?` in `var(--type-meta)`, `--text-secondary`), then sections at `var(--section-gap)`.

Section component — the rule in code:

```tsx
function Section({ title, href, children, empty }: {
  title: string; href?: string; empty: boolean; children: React.ReactNode;
}) {
  if (empty) return null;   // heading included — this is the whole rule
  return (
    <section className="mt-[var(--section-gap)]">
      <div className="flex items-baseline justify-between">
        <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>{title}</h2>
        {href ? <Link href={href} className="text-secondary" style={{ font: 'var(--type-meta)' }}>더보기 ›</Link> : null}
      </div>
      <div className="mt-[var(--space-9)]">{children}</div>
    </section>
  );
}
```

Sections, in order:
1. `저장한 곳` — horizontal rail, `gap: var(--rail-gap)`, `overflow-x-auto`, thumbnails `rounded-[var(--radius-photo)]` on `bg-surface-2`. `더보기 ›` → `/saved-places`. Hidden when the user has none.
2. `{mbti}에게 어울리는 곳` — **rendered only when `user.mbti` is set AND a recommendation source exists.** There is none, so pass `empty={true}` and leave a comment naming the task that will supply it. Do not fabricate rows.
3. `{home_area} 근처` — from `listPlacesNearby`. Hidden when `home_area` is null or the query is empty.

If **every** section is empty, render one line — `아직 저장한 곳이 없어요` — and nothing else. No illustration, no CTA (the empty state is not the fix; saving from Instagram is, and that is slice 3).

- [ ] **Step 3: Verify both the populated and the bare state**

```bash
npm run build 2>&1 | grep -E 'Compiled|Error'
```

With the seeded user (13 saved places, `home_area` 성수), load `/home` and confirm: greeting, a saved-places rail, a `성수 근처` section, and **no MBTI heading anywhere**. Then:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "update users set home_area=null where email='proto@example.com';"
```

Reload; the `근처` section and its heading must both be gone — not an empty box.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/home" lib/saved-places.ts
git commit -m "Add the home feed

Sections are hidden entirely, heading included, when they have no data. That is
the adopted system's strongest content rule and it is doing real work here:
there is no recommendation engine, so the MBTI section does not render at all
rather than showing an empty shelf.

Day one this screen is the saved places and what is near you. That is the
correct output of the rule rather than a gap in the design."
```

---

### Task 12: Retire the prototype and sweep

**Files:**
- Delete: `app/prototype/`
- Modify: `.agents/visual-language.md` (contrast table)
- Modify: `README.md`

- [ ] **Step 1: Delete the prototype**

```bash
git rm -r app/prototype
```

Its own `DEMO.md` sets the retirement rule, and its finding was reasoning from the luma premise that this redesign retires. Leaving it would leave a screen in the tree arguing for a direction the record no longer holds.

- [ ] **Step 2: Write the measured contrast table into the record**

The ratios are already measured — they are in Global Constraints above. Copy that table into `.agents/visual-language.md`, together with the two rules that follow from it, and then **audit Tasks 7–11 for any use of `--text-tertiary` or a status/tag pair behind readable text**. The luma table described a different palette and none of its ratios transfer.

| Text | On | Needed |
|---|---|---|
| `--ink #1A1A1A` | `--canvas #FFFFFF` | AA body |
| `--ink #1A1A1A` | `--surface-1 #FAFAFA` | AA body |
| `--text-secondary #6B6B6B` | `--canvas` | AA body |
| `--text-secondary #6B6B6B` | `--surface-1` | AA body |
| `--text-tertiary #9A9A9A` | `--canvas` | record the ratio; if below 4.5:1 mark it **decorative only** |
| `--status-cancel-fg` | `--status-cancel-bg` | AA large |
| `--text-on-ink #FFFFFF` | `--ink` | AA body |

```bash
node -e "
const L=h=>{const c=[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2]};
const R=(a,b)=>{const x=L(a),y=L(b);return ((Math.max(x,y)+.05)/(Math.min(x,y)+.05)).toFixed(2)};
[['#1A1A1A','#FFFFFF'],['#1A1A1A','#FAFAFA'],['#6B6B6B','#FFFFFF'],['#6B6B6B','#FAFAFA'],['#9A9A9A','#FFFFFF'],['#FF3B5C','#FCE8EE'],['#FFFFFF','#1A1A1A']]
 .forEach(([f,b])=>console.log(f,'on',b,'=',R(f,b)+':1'));
"
```

Record the output verbatim. **If `--text-tertiary` falls below 4.5:1, add a rule stating it may never carry text a user must read**, and audit every use added in Tasks 7–11.

- [ ] **Step 3: Update the README**

The Layout section still describes `app/prototype/` and `components/` as they were. Update it, and add the canvas and the no-accent rule to the conventions list.

- [ ] **Step 4: Full verification sweep**

```bash
npx tsc --noEmit && npm run lint && npm run build 2>&1 | grep -E 'Compiled|Error'
DEV_LOG=/tmp/gaja-dev.log bash scripts/smoke.sh 2>&1 | tail -3
git log --all --format='%B' | grep -icE 'claude|co-authored|anthropic'
```

Expected: clean build, `43 passed, 0 failed`, attribution count `0`.

Then walk every screen at **430px** and **375px**: `/` · `/sign-in` · `/sign-up` · `/sign-in/sent` · `/onboarding` (all four steps) · `/home` · `/saved-places` · `/groups` · `/account`. At 375px confirm no horizontal scrollbar on any of them, and that the tab bar never covers content.

- [ ] **Step 5: Apply the migration to the remote and commit**

```bash
supabase db push    # confirm the prompt; applies 20260920000003
git add -A
git commit -m "Retire the saved-places prototype and record the new contrast table

The prototype argued for grouping saved places by area, reasoning from luma's
agenda rule. That premise is retired, so per its own DEMO.md the prototype goes
rather than sitting in the tree arguing for a direction the record no longer
holds.

The contrast table is re-measured: the previous one described the luma ink
tiers and none of its ratios transfer to this palette."
git push origin main
```

---

## Self-Review

**Spec coverage.** §2 record replacement → Task 1 Step 4. §3 tokens/colour/type/canvas → Tasks 1–2. §4 landing → Task 7. §5 sign-in/sign-up → Task 8. §6 onboarding → Tasks 4, 5, 6, 9. §7 navigation and home → Tasks 10, 11. §7a routing → Tasks 7 (`/`), 9 (gates), 10. §8 content rules → Global Constraints. §9 schema → Task 4. §10 blocked assets → Task 6 Step 2. §11 out of scope → nothing implements recommendation ranking; §12 verification → Task 12.

**Gap found and closed:** the spec's §12 requires contrast re-measurement, which no task originally carried. It is now Task 12 Step 2 with a runnable calculation, because `--text-tertiary #9A9A9A` on white is near the AA threshold and Tasks 7–11 place it under real text.

**Type consistency.** `SessionUser.onboarded_at` is a `Date | null` throughout (Tasks 5, 7, 9) — note `toMe()` exposes it to the wire as the boolean `onboarded`, and those are deliberately different names for different layers. `MBTI_TYPES`/`mbtiImage`/`isMbtiType` are used exactly as defined in Task 6. `TabBarShell` is named identically in Tasks 9, 10. `listPlacesNearby(area, userId, limit)` is defined and called only in Task 11.

**Known incompleteness, by design:** the MBTI grid ships at 14 of 16 types. This is stated in the spec (§10), the manifest comment, and Task 6's commit message, and it does not block any other task.
