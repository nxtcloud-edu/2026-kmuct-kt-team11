# Visual language — Gaja

<!-- Canonical visual context. Downstream agents (ui-designer, product-designer,
     frontend-engineer) read this before making any visual decision.
     Settled decisions only. Do not edit by hand without bumping the changelog. -->

**Updated** 2026-09-18 · **Written by** the user, not `visual-designer`
**Changelog** 2026-09-18: initial. Adopts the `luma.com` taste analysis wholesale as Gaja's
direction, to close the dangling `.agents/visual-language.md` input on run-order step 4.
**Upstream** none. **There is no `.agents/brand-context.md` and no brand strategy.** This file
is a *taste adoption*, not a visual identity. See "What this file is not".

**Source** `~/Documents/taste/luma.com.md` · `luma.com.json` · summary in `~/CLAUDE.md`

## What this file is not

A `visual-designer` pass did not happen. Gaja has **no brand colour, no logo direction, and no
ownable visual idea** — by choice, deferred. Downstream agents should treat these tokens as
settled and build on them, but must **not** describe the result as Gaja's brand. When Gaja needs
to be recognisable rather than merely well-made, cast `brand-strategist` → `visual-designer`
and this file gets rewritten by its real owner.

## Concept

- **Feels like:** a well-kept agenda someone made for you. Quiet chrome, loud content.
- **Never feels like:** a discovery app, a feed, a travel brochure, or an AI product. No
  gradients, no glow, no sparkle icons, no "powered by AI" chrome.
- **Tension:** an agent did aggressive work on your behalf (swapped a café, cut a stop), and the
  interface has to stay calm enough that you trust it and legible enough that you can undo it.
- **Recognisable without a logo by:** a single time-ordered column, times at the card's left
  edge, thumbnails hard-right, and the fact that the only saturated colour on screen means
  something factual.

## Tokens

```yaml
color:
  canvas:      "#F7F8F9"
  surface-1:   "#FFFFFF"        # cards
  ink:         "#131517"
  ink-muted:   "rgba(19,21,23,0.64)"
  ink-subtle:  "rgba(19,21,23,0.36)"   # DECORATIVE ONLY — fails AA, see Contrast
  fill:        "rgba(19,21,23,0.04)"
  hairline:    "rgba(19,21,23,0.08)"
  accent:      null              # Gaja has no brand colour. Do not invent one.
  focus:       "#131517"         # focus ring = ink, 2px, :focus-visible only
  danger:      "#ED2B32"
  danger-fill: "rgba(237,43,50,0.13)"
  glass-dim:   "rgba(255,255,255,0.08)"   # over photography
  glass-solid: "rgba(255,255,255,0.80)"   # over photography, for legible text

type:
  family:   "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', system-ui, sans-serif"
  display:  { size: 52px, line-height: 1.2, weight: 500 }
  h2:       { size: 28px, line-height: 1.3, weight: 500 }
  h3:       { size: 20px, line-height: 1.4, weight: 500 }
  body:     { size: 16px, line-height: 1.5, weight: 400 }
  small:    { size: 14px, line-height: 1.4, weight: 400 }
  micro:    { size: 12px, line-height: 1.3, weight: 400 }
  # Weight never exceeds 500. There is no 600, no 700, no display face, no mono.

space:    [4, 8, 12, 16, 24, 48, 64, 120]
  # 64 between day groups. Container padding 96px 16px 48px.
  # Optical one-offs (6/7/9/10) permitted only inside pill padding.

radius:   { card: 16px, pill: 1000px, avatar: 50% }
  # Sharp corners do not exist in this language.

motion:   { curve: "cubic-bezier(0.4,0,0.2,1)", quick: 0.2s, standard: 0.3s }
  # 0.2s opacity · 0.3s border and shadow. Nothing else animates.

grid:     { container: 960px, content: 600px, sidebar: 320px, display: flex }
```

## Rules (read these — the tokens alone will be misapplied)

- **No accent exists.** There is no brand colour and none may be introduced. Hierarchy comes from
  size, weight 400↔500, and the ink alpha tiers. A saturated colour that is not `danger` is a bug.
- **Colour enters through photography only.** Reel stills and place photos supply every hue on
  screen. The chrome contributes zero. This is the rule that makes user content look like the
  product rather than like an attachment to it.
- **`#ED2B32` is a statement of fact, not a mood.** It marks conditions that are *true*: closed
  now, closed on this day, wait over threshold, agent removed this stop. It never marks emphasis,
  never marks a CTA, never marks brand. If red also means "important", red stops meaning "this
  will not work".
- **Neutrals are derived, never picked.** Every gray is `#131517` at an alpha step so it
  composites correctly over canvas, card, and photography alike. Never hand-pick a hex.
- **Depth is merchandising, and the budget is two recipes.** Content cards (a place, a day, a
  saved reel) get the 4-layer shadow `rgba(0,0,0,.06/.09/.12/.16)` at 1/2/3/7px. Every control —
  button, chip, input, toggle — gets `inset 0 0 0 0.5px rgba(19,21,23,0.08)` and never floats.
  Only the things the user came for are allowed to lift off the page.
- **Type over imagery gets a plate, not a scrim.** Text on a reel still sits on `glass-solid`
  (`rgba(255,255,255,0.80)`); `glass-dim` is for non-text controls only. No text directly on
  photography, ever — Korean place names over a busy café photo are unreadable, and a gradient
  scrim only half-fixes it.
- **Motion budget: opacity and border.** No transforms, no layout animation, no spring. Honour
  `prefers-reduced-motion` by dropping to 0s. The pipeline's live stage-by-stage view updates by
  fading text in — it must not slide, bounce, or shimmer.
- **Agenda, not catalog.** Time-ordered single column, dated markers, times scannable at the
  card's left edge. A grid of place cards is out of bounds even on the saved-places screen —
  that screen is reverse-chronological by save date, not a gallery.

## Gaja deviations from luma

luma was read from an events listing. Three things it does not specify:

1. **Reel thumbnails are 9:16, not 1:1.** luma's card art is square. A reel still cropped square
   loses the frame the user chose. Rule: **saved reels render 9:16 at 64px wide** in the
   agenda column; **places extracted from them render 1:1** at luma's own sizing. The aspect
   ratio is what tells the two apart, so never normalise them to one shape.
2. **Korean and Japanese text in the same column.** The system stack resolves to Apple SD Gothic
   Neo and Hiragino; no webfont is needed and none may be added. Line-height 1.5 at body is the
   floor for Hangul — do not tighten it to match a Latin-only mock.
3. **Agent-authored changes need a mark, and it is not a colour.** When the planner swaps a stop,
   the changed card carries a `fill`-backed micro chip reading what changed. It does **not** get
   `danger` — the swap is not a failure, it is the product working. `danger` stays reserved for
   the underlying fact (`영업 종료` / closed) that caused it.

## Contrast (measured 2026-09-18 — do not recompute, do not guess)

| Text role | On | Ratio | Verdict |
|---|---|---|---|
| `ink` 1.0 | `#FFFFFF` card | **18.30:1** | AA body ✓ |
| `ink` 1.0 | `#F7F8F9` canvas | **17.21:1** | AA body ✓ |
| `ink-muted` 0.64 | `#FFFFFF` card | **5.50:1** | AA body ✓ |
| `ink-muted` 0.64 | `#F7F8F9` canvas | **5.35:1** | AA body ✓ |
| `ink-subtle` 0.36 | `#FFFFFF` card | **2.30:1** | **FAILS** — decorative only |
| `danger` `#ED2B32` | `#FFFFFF` card | **4.21:1** | **large text / UI only** |
| `danger` on `danger-fill` | `#fde3e4` | **3.46:1** | **large text / UI only** |

**Two constraints follow, and both are load-bearing:**

- `ink-subtle` (0.36) may never carry text a user must read. Dividers, disabled glyphs,
  placeholder marks only. luma uses it for tertiary metadata; at 2.30:1 that is not accessible
  and Gaja does not copy it.
- **`danger` fails AA as body text.** The signature moment — *"recent reviews say two hours on
  Saturday"* — must therefore be `ink` or `ink-muted` at body size, with `danger` carrying it
  only as a 20px+ label, an icon, a 2px left border, or the `danger-fill` chip behind it.
  Red 14px body copy on white is not shippable. Specify this in the screen specs; it is the
  easiest rule in this file to break by accident.
