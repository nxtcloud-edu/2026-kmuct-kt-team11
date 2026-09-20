# Gaja

2026년 국민대학교 캠퍼스타운 키로톤 11팀 **아노야 부탁해** 레포지토리입니다.

Instagram reels → a planned day in Seoul. Save places from reels, and the planner
builds a time-ordered itinerary that is actually open when you get there.

## Status

Built in vertical slices (`docs/superpowers/specs/2026-09-18-gaja-design.md` §14).

| Slice | What | State |
|---|---|---|
| 1 — Spine | auth, groups, places, hand-entered saved places | API complete · frontend scaffolded |
| 2 — Pipeline | PlaceSource, research, planning, validation, repair loop | not started |
| 3 — Ingestion | IG webhook, extraction ladder, admin review queue | not started |
| 4 — Personalization | preference signals, planner attribution | not started |

Slice 1's screens are deliberately minimal. The IA and screen specs belong to step 4
of `.agents/run-order.md` (`product-designer`), which has not run — what exists is the
chassis, not the design.

## Running it

Needs Node 20+, Docker (for local Postgres), and the Supabase CLI.

```bash
npm install
supabase start                  # Postgres on :54322
psql "$DATABASE_URL" -f supabase/migrations/20260918000001_slice1_spine.sql
npm run dev
```

`.env.local` holds the local defaults and is committed on purpose — they are the
documented Supabase local values, not secrets.

Magic links are not emailed in development; they are printed to the dev server
console. See `lib/mail.ts` — no provider is chosen yet, and slice 1 cannot send
mail in production until one is.

## Verifying

```bash
npm run build && npm run lint
```

The backend has a 40-case suite covering object-level authorization, idempotency
replay, the recovery-channel constraint and the duplicate-save index. It drives the
real HTTP routes, so it needs the dev server and Postgres both up:

```bash
npx next dev > /tmp/gaja-dev.log 2>&1 & bash scripts/smoke.sh
```

It reads magic-link tokens out of that log, which is why `DEV_LOG` has to point at
wherever the server is writing.

To browse real data, `bash scripts/seed-prototype.sh` signs in a fixture user and
creates 13 saved places across three Seoul areas.

### Demo accounts

`bash scripts/seed-accounts.sh` creates the two states worth demoing — a brand-new
account that still has onboarding ahead of it, and an established one whose home
screen is already full. Both use the password `gaja-demo-1234`:

| Account | Lands on |
|---|---|
| `demo-new@example.com` | `/onboarding`, step 1 of 5 |
| `demo-home@example.com` | `/home` — 민지, 활동 지역 성수, 8 saved places and a 성수 근처 map |

The addresses are fixed, so the script deletes those two users before recreating
them; re-running it gives a fresh un-onboarded account rather than a 409. It
refuses to run unless `DATABASE_URL` and `BASE` both point at localhost — these
accounts have a published password, and that is only safe locally.

## Deploying

Vercel, on the Hobby plan. The repo lives in a GitHub org, which Hobby can still build
from — a GitHub org admin just has to approve the Vercel app for the org once, after
which the normal "Import Project" flow works and every push gets a preview URL.

`vercel.ts` (typed, via `@vercel/config`) pins two things: `framework: 'nextjs'` and
`regions: ['icn1']`. Seoul, not the `iad1` default — see the comment in that file.

Environment variables to set in the Vercel project, for Production and Preview both:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler, port 6543** — not the direct connection on 5432. |
| `NEXT_PUBLIC_APP_URL` | The deployment's own origin. Magic-link callbacks are built from it, so a wrong value sends people to localhost. |
| `SUPABASE_URL` | Project URL. |
| `SUPABASE_ANON_KEY` | Anon key. Public by design; row-level security is what protects the data. |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | **Must carry an HTTP-referrer restriction** — see below. |

Two of those are load-bearing enough to repeat:

- **`DATABASE_URL` must be the 6543 transaction pooler.** Serverless functions multiply
  with traffic and each instance opens its own pool, so direct 5432 connections run out.
  `lib/db.ts` drops the pool to one connection per instance when `VERCEL` is set, which
  only adds up if the other end is pooling too.
- **The Maps key ships in the browser bundle.** Anything prefixed `NEXT_PUBLIC_` is
  compiled into client JavaScript and is readable by anyone who loads the page. The key
  is not a secret and cannot be made one; restrict it instead — HTTP-referrer restriction
  to the deployment's domains, plus an API restriction to only the Maps APIs in use.
  An unrestricted key is someone else's billable quota.

**Magic links do not work in production yet.** No transactional email provider is wired
into `lib/mail.ts`, so `POST /api/auth/magic-link` fails there; it currently surfaces as
a 500, and becomes a clean 503 once the `mail-unavailable` problem code lands (see the
note in `lib/mail.ts`). Password sign-in and sign-up work regardless and are the
supported way in until a provider is chosen.

## Layout

```
app/(public)/     signed-out: landing, sign-in, sign-up, magic-link callback
app/(onboarding)/ signed-in but not yet onboarded; no tab bar
app/(app)/        signed-in and onboarded: gated in layout.tsx, wrapped in the tab bar
app/api/          route handlers — the contract in docs/gaja/openapi.yaml
app/canvas.tsx    the 430px phone canvas every route renders inside
components/       surface primitives, UI states, the tab bar
lib/              db, session, problems, pagination, idempotency, mbti
lib/api/          browser-side client — Server Components use lib/db directly
proxy.ts          stamps x-gaja-pathname; NOT the auth boundary
```

Conventions worth knowing before changing anything:

- **`.agents/visual-language.md` is the record.** `app/globals.css` is its
  transcription — change the record first, then the CSS.
- **Every screen renders inside a 430px phone canvas**, centred on grey above 480px
  and full-bleed below it. Screens are designed at phone width, always.
- **There is no accent colour.** A saturated value that is not semantic is a bug, and
  no status or tag foreground may carry body text — set the label in ink over the
  pastel. See the measured contrast table in the record.
- **Spacing is not on a 4/8 grid** and line heights are absolute px. Both are
  deliberate; snapping them is a regression.
- **Auth is gated in `app/(app)/layout.tsx`, not in `proxy.ts`.** The session is an
  opaque token checked against Postgres, and Proxy must not do database work.
- **Errors are RFC 9457 problem documents.** Branch on `type`, never on `detail`.
