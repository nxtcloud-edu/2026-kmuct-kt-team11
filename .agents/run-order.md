# Run order — Gaja

**Cast by:** `/run-order` on 2026-09-18 (re-cast; supersedes the 5-role cast of the same date) · **Request:** Instagram reel → trip planner. IG-scoped user ID is the account, no login. Architecture B (fixed pipeline, bounded repair loop). User web app + admin console. Naver Place needs scraping.

**Cast:** `product-engineer` → { `data-engineer` · `ai-engineer` · `product-designer` } → `ai-interaction-designer` → `prompt-engineer`

**Cast is 6, over the limit of 5. Justification, one line each:**
`product-engineer` every other step reads its contract · `data-engineer` the scrape is the project's most fragile surface and nothing else owns freshness · `ai-engineer` five agents with no eval set is a demo that fails live · `product-designer` two new surfaces, cast as one step instead of its six delegates · `ai-interaction-designer` the product's whole value is an agent overruling the user's saved place, and nothing else owns the override · `prompt-engineer` five instruction layers and the typed handoffs between them.

<!-- Resume: a step is done when every path on its `produces:` line exists.
     Steps with `produces: —` are conversation-only; tick them by hand. -->

### 1. System contract — NARROWED 2026-09-18
- **skill:** `product-engineer`
- **answers:** What is the HTTP contract between the web app, the admin console, and the pipeline?
- **needs:** `docs/superpowers/specs/2026-09-18-gaja-design.md` ✓ written 2026-09-18, 606 lines
- **produces:** `docs/gaja/api-contract.md`
- **done when:** slice-1 routes have paths, request and response shapes, RFC 9457 error bodies, the two idempotency keys (`mid` on ingest, the planning key) declared as headers, and pagination on the saved-places list

> **Two thirds of this step was absorbed by the design spec.** `RequestEnvelope`, `VerifiedPlace`,
> `Itinerary`, `Violation` and the Naver-independent `PlaceSource` interface are all settled in
> §4–§5 of the spec, and the ADR content lives in §3 "Settled decisions" and §4 "Architecture".
> Read those rather than re-deriving them. Only the HTTP contract is genuinely missing — the spec
> mentions idempotency once, in prose, and declares no endpoints at all.
>
> **Scope it to slice 1 first** (§14: users, groups, group_members, group_invites, places,
> place_refs, saved_places, magic-link auth, hand-entered places). The pipeline routes belong to
> slice 2 and need nothing from this step to be designed.

### 2. Data reliability
- **skill:** `data-engineer`
- **answers:** How does Naver Place data get in, stay fresh, and fail loudly — and where does the preference history live?
- **needs:** spec §4 (architecture) · spec §5 (data model) · source systems (Naver Place, Kakao Local, Google Places)
- **produces:** `docs/gaja/data-contracts.md` · `docs/gaja/pipelines.md`
- **done when:** the scrape has a freshness TTL, a staleness detector, a block/backoff policy and a cost ceiling — and stale hours are a detectable condition rather than a silently wrong itinerary
- **blocked by:** step 1

### 3. Agent viability
- **skill:** `ai-engineer`
- **answers:** Which of these agents genuinely needs a model, where does each fail, and how do we know it worked?
- **needs:** spec §4 · spec §7 (research) · spec §8 (planning and validation) · `docs/gaja/api-contract.md`
- **produces:** `.agents/ai-context.md` · `docs/gaja/evals/`
- **done when:** every agent has a stated failure mode and eval cases — including reel→place extraction, the wait-time judgment read from Korean review text, and the bounded validation→replan loop
- **blocked by:** step 1

### 4. Two surfaces
- **skill:** `product-designer`
- **answers:** What are the journey, the IA and the screens for the user web app and the admin console?
- **needs:** `docs/gaja/api-contract.md` · `.agents/visual-language.md` ✓ supplied 2026-09-18
- **produces:** `.agents/design-system.md` · `docs/gaja/screens/`
- **done when:** saved-place browsing, the planning request, the live pipeline view and the admin's failed-extraction queue all have flows and screen specs
- **blocked by:** step 1

### 5. Control sharing
- **skill:** `ai-interaction-designer`
- **answers:** When does the agent decide alone, when does it ask, and how does the user overrule a swap and get the day re-planned?
- **needs:** `.agents/ai-context.md` (failure shapes) · the settled flow from `docs/gaja/screens/`
- **produces:** `docs/gaja/interaction-spec.md`
- **done when:** every agent decision is marked silent, shown, or confirmed, and the swap/reject/re-plan surface is specified
- **blocked by:** steps 3 and 4

### 6. Instruction layer
- **skill:** `prompt-engineer`
- **answers:** What exactly does each agent get told, and how do the handoffs between them stay typed?
- **needs:** `.agents/ai-context.md` · `docs/gaja/evals/` · `docs/gaja/interaction-spec.md`
- **produces:** `docs/gaja/prompts/`
- **done when:** orchestrator, collection, research, planning and validation each have a prompt spec that passes its step-3 eval cases
- **blocked by:** step 5

## Any order

Steps 2, 3 and 4 depend only on step 1 and not on each other. Run them in whatever order suits, or in parallel.

## Build slices (spec §14) — how the roles map onto them

The spec decomposes the build into four vertical slices. The cast above is a *role* sequence; §14
is a *build* sequence. They overlay like this:

| slice | what it is | roles it actually needs |
|---|---|---|
| 1 — Spine | auth, groups, places, hand-entered saved places. No Instagram, no scraping. | step 1 (API contract only) |
| 2 — Pipeline *(the demo)* | PlaceSource, research fusion, planning, validation, repair loop, streaming feed | steps 2, 3, 4, 5 |
| 3 — Ingestion | IG webhook, extraction ladder, admin review queue | steps 2, 4, 6 |
| 4 — Personalization | preference signals, user profile, planner attribution | steps 3, 6 |

**Slice 1 needs almost nothing from this cast.** Narrowed step 1, then build. Do not wait on
steps 2–6 to start it.

**§12's unverified assumptions are not blocking.** All six concern Instagram and Naver, which
slices 1 and 2 do not touch. Verify them in parallel, before slice 3 — not before slice 1.

## Dangling input — CLOSED 2026-09-18

`.agents/visual-language.md` was required by step 4 with nothing in the cast producing it.
**Closed by option 1:** the `luma.com` taste analysis adopted wholesale as Gaja's direction.
`visual-designer` and `brand-strategist` stay uncast; the cast remains 6.

Why luma over the other five: its governing rule is *"agenda, not catalog — time-ordered single
column, times scannable at the card's left edge"*, which is a description of a day itinerary; it
already has a 64px day-group rhythm; its chrome contributes zero hue so place photography carries
all colour; and its single saturated colour is semantic, so `영업 종료` and wait warnings have a
colour that cannot be confused with branding.

**The deferred cost, stated so it is not a surprise later.** luma has no brand accent, so Gaja
has no colour of its own — it will look like well-made neutral chrome around other people's
photographs. That is right for v1 and wrong the moment Gaja needs to be recognisable. At that
point cast `brand-strategist` → `visual-designer`, who owns and rewrites that file.

**Two measured constraints came out of it** and belong in step 4's screen specs:
`rgba(19,21,23,0.36)` is 2.30:1 and may never carry readable text; `#ED2B32` is 4.21:1 and
therefore **cannot be body text** — the wait-time line must be `ink`/`ink-muted` at body size
with red carrying it only as a large label, icon, border or chip.

## Not cast, and why

- `product-manager` — was step 1 in the previous cast. Dropped: the in-flight `/brainstorming` session is settling scope, surface, identity, coverage and architecture directly with you, and terminates in a committed design spec. That spec is the artifact `product-manager` would have produced.
- `product-strategist` — the bet is stated and argued in your brief. Re-deciding it is not the bottleneck.
- `software-architect` — whole-system structure for a five-agent pipeline is step 1's ADR. Cast it if Gaja outgrows one deployable.
- `ux-strategist` · `ux-researcher` · `service-planner-kr` · `ux-designer` · `ui-designer` · `accessibility-designer` — all six are `product-designer`'s own delegates. Casting them alongside it is double-booking.
- `backend-engineer` · `frontend-engineer` — they build against steps 1, 2 and 4. Implementation sessions, not role sessions, unless the team grows past one builder.
- `security-engineer` — **the strongest candidate for role 7.** Three real surfaces: the magic link is a bearer credential in a DM, you are storing other people's Instagram message content, and scraping Naver Place has a terms-of-service exposure that is a product risk, not a code risk. Not cast only because nothing ships yet. Cast it before the first real user.
- `business-strategist` · `go-to-market-strategist` · `growth-strategist` · `product-marketing-manager` · `brand-strategist` — no funnel, no price, nothing being sold yet.
