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

## Layout

```
app/(public)/     signed-out: sign-in, magic-link callback
app/(app)/        signed-in: auth-gated in layout.tsx, wrapped in the app shell
app/api/          13 route handlers — the contract in docs/gaja/openapi.yaml
app/prototype/    throwaway direction prototype; delete once its finding lands
components/       surface primitives and the UI-state set
lib/              db, session, problems, pagination, idempotency
lib/api/          browser-side client — Server Components use lib/db directly
proxy.ts          stamps x-gaja-pathname; NOT the auth boundary
```

Conventions worth knowing before changing anything:

- **`.agents/visual-language.md` is the record.** There is no brand colour, weight
  never exceeds 500, and `#ED2B32` may not carry body text. `app/globals.css` is its
  transcription — change the record first, then the CSS.
- **Auth is gated in `app/(app)/layout.tsx`, not in `proxy.ts`.** The session is an
  opaque token checked against Postgres, and Proxy must not do database work.
- **Errors are RFC 9457 problem documents.** Branch on `type`, never on `detail`.
