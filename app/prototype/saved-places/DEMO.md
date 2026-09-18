# Prototype — does "agenda, not catalog" survive saved places?

**Built** 2026-09-19 · **Status** throwaway, sub-shape B (`prototype/UI.md`)
**Run** `bash scripts/seed-prototype.sh`, then `/prototype/saved-places?variant=A|B|C`
**States** append `&state=loading|empty|error`
**Switcher** bottom pill, or ← / → arrow keys

## The uncertainty

> **luma's "agenda, not catalog" rule was derived from a page of events that happen at
> times. A saved place has no time — only the moment you happened to save it. If the
> agenda's organising fact is meaningless here, the direction breaks on the product's
> main screen.**

What would change if the answer came back "no": the governing rule in
`.agents/visual-language.md` — and therefore the composition of every list screen in
Gaja — would have to be restated before `product-designer` runs step 4 of the run order.

## What was built

Three variants that disagree about **the organising fact**, not about styling:

| | organising fact | premise |
|---|---|---|
| **A** Agenda | save date | luma faithful — a saved place behaves like an event on a day |
| **B** Area board | `place.area` | you plan "a Saturday in 성수", so *where* is the axis |
| **C** Flat stream | none | null hypothesis — grouping is overhead that does not earn its keep |

All three use the real `/api/saved-places` route and real Postgres rows. Tokens come from
`.agents/visual-language.md`; nothing visual was invented here.

## Findings — `[heuristic]`, not `[observed]`

No user has touched this. These are expert judgments from building and driving it, and
they are labelled that way deliberately.

**1. A fails on its own premise. (critical)**
luma puts the time at the card's left edge because that is when you must show up. Gaja's
left edge reads `22:18`, `20:47`, `23:57` — the moment a row was written. It occupies the
most scannable position on the card and carries no information anyone will ever act on.

**2. A also fragments. (major)**
13 places produce five date groups, several holding one item, at 64px separation. You
scroll a long way to see very little. The fragmentation gets worse as the list grows,
which is the opposite of what a list layout should do.

**3. B answers the question the user actually has. (major, in B's favour)**
`성수 5곳 · 카페 · 쇼핑 · 전시` is a plannable unit — it is nearly the trip request itself.
`places.area` is already denormalised for exactly this (spec §5.1, "resolved once,
denormalized for filtering"), so the data model was already built for B.

**4. C is a real fallback, and beats A. (minor)**
Filter chips give the area axis on demand without committing the layout to it. Honest at
13 items. It will not hold at 200, and the saved list only grows.

**5. The category glyphs violate the direction's own rule. (major)**
☕ and 🛍 render as saturated colour emoji. `.agents/visual-language.md` rule 2 says the
chrome contributes zero hue and the only saturated value is `--danger`. They are a
placeholder for slice-3 reel stills, but if they reach production the direction is broken
by its own placeholder. Route to `ui-designer`: monochrome glyphs, or no glyph at all.

**6. Half the direction cannot be judged yet. (noted, not a defect)**
Slice 1 has no imagery — `places` has no photo column and reel stills arrive in slice 3.
A large part of why luma works is photography carrying all the colour. What was tested
here is the *organising principle*; the *visual* half of the adoption remains untested.

## Recommendation

**B, taking C's filter chips.** Group by area; keep the save date as right-aligned
metadata; put C's chip row above the groups for narrowing.

The direction is not wrong — its governing rule was **mis-transplanted**. What transfers
from luma is "one column, grouped, scannable left edge, no discovery grid". What does not
transfer is *date as the grouping key*, because luma's dates mean something and Gaja's do
not.

## Fake list

Everything simulated, so no finding is ever recorded against a fake.

**REAL** — the API, Postgres, the session, cursor pagination, all rendering, all states,
the responsive behaviour, the tokens.

**FAKED**
- **Category glyph tiles** stand in for reel stills (slice 3). Real thumbnails will change
  the visual weight of every card substantially. **Finding 5 is about the fake itself.**
- `&state=loading|empty|error` force states rather than provoking them.
- Fixture data is invented but shaped correctly — real Seoul venues, real areas, hooks in
  the register the extractor is meant to produce. Save timestamps were backdated with SQL.

**ABSENT** — add a place, tap into a place, groups, sign-in, search, sorting, infinite
scroll. Every control on screen either works or is inert-by-design; the chips in C do not
filter, which is on this list.

## Not validated

- Nobody but the builder has used it. Findings are `[heuristic]`.
- Behaviour at 200+ saved places is untested; the fixture set is 13.
- Korean line-breaking was checked with real Hangul but not with the longest real names.
- This is prototype-grade QA. E2E, cross-browser and visual regression belong to
  `web-qa-engineer`.

## Retiring this

Per `prototype-designer` §5.14: once a variant is chosen, fold the decision into
`.agents/visual-language.md` (the record), promote the winner into the real
`/saved-places` route, and delete `app/prototype/` from main. The prototype is evidence
about the record — it is never the record.
