# Gaja — StartView design adoption and the five first-run screens

**Date** 2026-09-20 · **Status** approved, not yet implemented
**Supersedes** the luma.com direction in `.agents/visual-language.md` (2026-09-18)
**Source system** `~/Documents/startview-prototype/creator/_ds/startview-design-system-7416ce7c-06b5-400e-a350-b7ab509655f6`

## 1. What this is

Gaja adopts StartView's design system wholesale and gains five screens it does not
have: landing, sign-in, sign-up, onboarding, and a home feed.

StartView (`startview.co.kr`) is a Korean creator↔brand marketplace — a different
product with the same owner. Gaja takes its **design system**, not its brand: same
tokens, canvas, type and component grammar; its own wordmark.

### Settled decisions

| Question | Decision |
|---|---|
| Brand | Gaja's own wordmark, StartView's system |
| Brand colour | **None.** `#FFE600` is StartView's and is not inherited |
| Onboarding collects | 닉네임 · 성별 · 연령대 · MBTI · 활동 지역 |
| Home | Recommendation feed, saved places as one section |
| Landing | Signed-out entry inside the phone canvas; no marketing site |
| Build route | Straight into production routes, no prototype namespace |

## 2. The record is replaced, not amended

`.agents/visual-language.md` is rewritten and its changelog bumped. The luma adoption
is retired in full. Every rule below contradicts it:

| | luma (retired) | StartView (adopted) |
|---|---|---|
| Type | system stack, **no webfont** | Poppins + Inter, real webfonts |
| Weight | never above 500 | 400–800 (Poppins ExtraBold) |
| Canvas | `#F7F8F9`, 960px container | `#FFFFFF`, 430px phone canvas |
| Ink | `#131517` + alpha tiers | `#1A1A1A` / `#6B6B6B` / `#9A9A9A` |
| Depth | 4-layer card shadow, inset controls | three shadows total; tinted surfaces instead |
| Grid | 4px base | deliberately non-grid; 16px gutter constant |

**Consequence to record explicitly:** the saved-places prototype finding
(`app/prototype/saved-places/DEMO.md`, variant B — group by area) was derived from
luma's "agenda, not catalog" rule. That premise no longer holds. The finding is not
carried forward; saved places become a section of the home feed, per §7.

## 3. Foundation

### Tokens

StartView's six token files are imported near-verbatim into `app/globals.css`:
`colors.css`, `typography.css`, `spacing.css`, `radius.css`, `elevation.css`,
`motion.css`. Values are transcribed, not reinterpreted — including the deliberately
non-grid spacing (5, 7, 9, 13, 18, 34px) which must not be snapped to a 4/8 scale,
and the absolute-px line heights which must not be converted to ratios.

Tokens are bridged into Tailwind v4 with `@theme inline`, and base resets stay inside
`@layer base` — both for the reason already documented in `globals.css`: unlayered CSS
outranks every layer and silently beats the utilities.

### Colour

Adopted unchanged, with one omission. `--yellow #FFE600` and `--kakao #FEE500` are
**not** carried over: the first is StartView's brand mark, the second serves a Kakao
login button Gaja does not have. Everything else transfers, including the semantic
set (`--like-red`, `--success`, `--error`, `--point-gold`) and the pastel status pairs,
because those are functional rather than brand.

Gaja therefore still has no accent colour — now for a stated reason rather than an
inherited one. The app is white, two greys, near-black ink, and whatever colour the
imagery brings.

### Type

Poppins (500/600/700/800) and Inter (400/500/600/700), Latin subsets, `woff2`, copied
from the source `_ds/assets/fonts`. Hangul falls through to the reader's system Korean
face via `--font-fallback-kr` — **no Korean webfont is added**, matching the source.

Poppins is structural: wordmark, screen titles, section headings, onboarding headings,
and money/number figures. Inter is everything else.

### Canvas

430px wide, `--radius-canvas 24px`, `--shadow-canvas 0 24px 60px rgba(0,0,0,0.18)`,
centred on an `#E9E9EB` backdrop. Below 480px it fills the viewport edge to edge with
no frame, no radius and no shadow. Implemented once in the root layout so every route
inherits it.

## 4. Landing — `/`, signed out

Type-led. StartView's login screen rests on a three-panel `login-hero.png`; Gaja has
no equivalent asset, and inventing one would violate the content rule adopted in §8.

Composition, top to bottom in the canvas: wordmark · one-line promise · three short
lines of how it works · `시작하기` (primary, ink fill) · `로그인` (text link).

No screenshots, no illustration, no social proof. Nothing on this screen makes a claim
the product cannot yet keep.

## 5. Sign-in and sign-up

Two screens, **one endpoint**. Both post to `POST /api/auth/magic-link` with
`intent: 'sign_in'`.

This is safe rather than sloppy: the D3 dual semantics in `POST /api/auth/session`
decide the outcome at exchange time from whether a session exists, not from anything
in the token or the originating screen. A person who lands on 회원가입 with an existing
account is signed in; a person who lands on 로그인 with a new address gets an account.
Neither door can produce a wrong result, so the split is presentational and needs no
backend change.

- **`/sign-in`** — 로그인. Email field, `로그인 링크 받기`, link to 회원가입.
- **`/sign-up`** — 회원가입. Email field, `가입 링크 받기`, terms line, link to 로그인.
  Subcopy states the model plainly: 이메일만 있으면 돼요. 비밀번호는 없어요.

The Google button already renders only when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are
set (`socialSignInConfigured()`); that behaviour is unchanged, and the button is
restyled to the new token set.

## 6. Onboarding — `/onboarding`

Four steps, cross-faded at `--dur-fade 250ms` on `--ease-fade`, per the source's own
onboarding motion. Step headings are Poppins-Medium 24/−0.4 (`--heading-size`).

| Step | Collects | Required |
|---|---|---|
| 1 | 닉네임 → `users.display_name` | yes |
| 2 | 성별 · 연령대 → `gender`, `age_band` | no |
| 3 | MBTI → `mbti` | no |
| 4 | 활동 지역 → `home_area` | no |

Two deliberate departures from the brief, both to reduce first-run cost:

- **연령대, not exact age.** 10대 / 20대 / 30대 / 40대 / 50대+. Equally useful for
  recommendation bucketing and materially less invasive to ask of someone who has
  just arrived.
- **성별 includes 선택 안 함**, and MBTI includes `잘 모르겠어요`. Forcing a guess on
  MBTI would poison the recommendations that are the only reason to collect it.

Step 3 renders the character art from `~/Downloads/mbit-new` in a 4-column grid, one
cell per type plus a final `잘 모르겠어요` cell. At 16 types that is a clean 4×4 plus
one; until the missing art arrives it is 14 plus one and the last row is short. **See
§10.** The grid must not be hard-coded to 16 cells — it renders whatever types have
art, so completing the set is a matter of dropping in files.

Entry is gated on `users.onboarded_at`: null and signed in → `/onboarding`; set →
`/home`. Skipping a step writes nothing for that field and still advances
`onboarded_at`, so onboarding is never shown twice.

## 7. Home — `/home`, signed in

### Navigation

The top header (`components/app-shell.tsx`) is replaced by StartView's floating tab
bar: `--tab-bar-height 62px`, `--radius-3xl 18px`, `--shadow-float`, 16px from the
bottom. Four tabs: `홈 · 저장한 곳 · 그룹 · 계정` — the last matching the existing
`/account` page title rather than introducing a second name for it. Tab switches are instant
(`--dur-tab 0ms`) — the bar renders inside the animating subtree, so animating it
would slide the bar itself.

### Composition

Greeting row, then stacked sections at `--section-gap 28px`:

1. `저장한 곳` — rail of saved places, `더보기 ›` to the full list
2. `{MBTI}에게 어울리는 곳` — MBTI-matched recommendations
3. `{home_area} 근처` — places in the user's area

**Every section is hidden entirely, heading included, when it has no data.** This is
the adopted system's strongest content rule and it is load-bearing here, not
decorative: there is no recommendation engine and slice 2's pipeline does not exist,
so section 2 does not render at all until something can populate it.

Day one, home is honestly section 1 and section 3. That is the correct output of the
rule, not a gap in the design.

## 7a. Routing

`/` is the only route whose meaning depends on session state. Everything else is
unambiguous.

| Route | Signed out | Signed in, not onboarded | Signed in, onboarded |
|---|---|---|---|
| `/` | landing (§4) | → `/onboarding` | → `/home` |
| `/sign-in`, `/sign-up` | the screen | → `/onboarding` | → `/home` |
| `/onboarding` | → `/sign-in` | the screen | → `/home` |
| `/home` | → `/sign-in?next=` | → `/onboarding` | the screen |
| `/saved-places`, `/groups`, `/account` | → `/sign-in?next=` | → `/onboarding` | the screen |

This changes `app/page.tsx`, which today redirects straight to `/saved-places`, and
adds an onboarding check to the `(app)` group's gate. The `?next=` return address
established in `lib/require-session.ts` is preserved — a signed-out visitor deep-linked
to `/groups` still lands there after finishing sign-in *and* onboarding.

`/sign-in/sent` and `/auth/callback` are unchanged.

## 8. Content rules

Inherited from the source and binding on all new copy:

- **Korean, always.** English survives only in the wordmark, Latin numerals and units,
  and platform product names (`Instagram 릴스`).
- **Register:** polite informal, `-요`/`-해요`. Never `-습니다` except in server-supplied
  notices.
- **Headings are nouns**, 2–6 characters. **Buttons are verb phrases** ending in 하기,
  or a bare noun.
- **Empty states are one short line**, no illustration, no CTA unless the CTA is the fix.
  User-owned lists use `-없어요`; system lists use `-없습니다`.
- **`·` is the universal separator.** No terminal periods on labels, chips or buttons.
- **No emoji, anywhere.** There is not one in the source and none is introduced.
- **If there is no data behind a line, delete the line.**

## 9. Schema

One migration, following the convention set by `20260920000001_lock_down_data_api.sql`:
RLS enabled, `anon` and `authenticated` revoked.

```sql
alter table users
  add column gender       text check (gender in ('female','male','undisclosed')),
  add column age_band     text check (age_band in ('10s','20s','30s','40s','50plus')),
  add column mbti         text check (mbti ~ '^[EI][SN][TF][JP]$'),
  add column onboarded_at timestamptz;
```

`display_name` is **reused** as the nickname rather than adding a column: it is
already `not null`, already rendered in the shell and in groups, and a second name
field would immediately raise the question of which one is shown where.

All four columns are nullable. Only `display_name` is required by onboarding, and it
already exists.

## 10. Blocked on assets

**ISTJ and INTP character art is missing.** `~/Downloads/mbit-new` holds 15 files
covering 14 unique types. `ISFJ-1.png` is not a second ISFJ — it is a dark-blue figure
in rectangular glasses holding a document, and reads as the missing ISTJ.

Required before step 3 is complete: confirm `ISFJ-1.png`'s true type and rename it,
then produce the one still missing. Until both exist the grid renders 14 cells plus
`잘 모르겠어요`, which is shippable but incomplete.

This is the longest-lead item in the whole design; nothing else here waits on a person.

## 11. Out of scope

- Recommendation logic. Collecting MBTI is in scope; ranking places by it is not.
- Any marketing site above 430px.
- Dark mode. The source declares a dark palette but ships no screen using it.
- Kakao sign-in, removed in `c098052` and not reinstated here.
- `/saved-places`, `/groups` and `/account` keep their current structure; they are
  restyled by the token swap and must be re-checked, not redesigned.

## 12. Verification

- `tsc`, `eslint`, `next build` clean.
- `scripts/smoke.sh` still 40/40 — the token swap and new screens must not touch the
  API contract, and the migration must not break the recovery-channel CHECK.
- Every screen checked at 430px and at 375px, where the canvas frame is dropped.
- Contrast re-measured against the new palette. The retired contrast table in
  `.agents/visual-language.md` described luma's ink tiers and does not transfer.
