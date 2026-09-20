# Gaja Slice 1 (Spine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the identity, group and place spine of Gaja — every account, group and saved place the rest of the system depends on — with no Instagram, no scraping and no planning pipeline.

**Architecture:** Next.js App Router on Vercel with a Postgres database accessed through Drizzle ORM. Authentication is a purpose-built magic link with dual semantics: the same token both signs a user in and links an Instagram-scoped ID to an existing account. Every account is guaranteed at least one recovery channel by a database `CHECK` constraint, not by application convention.

**Tech Stack:** TypeScript · Next.js 15 (App Router) · Drizzle ORM + drizzle-kit · Postgres 16 (Docker locally) · Vitest · Node 24

**Spec:** `docs/superpowers/specs/2026-09-18-gaja-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **D3:** `CHECK (igsid IS NOT NULL OR email IS NOT NULL)` — every account has ≥1 recovery channel. This is a database constraint, never an application-layer check alone.
- **D3:** `email` is **never requested at first touch.** IG users are never prompted. Only an invite-joiner is asked, and only at the point they would otherwise have no recovery channel.
- **D10:** Degrade loudly, never silently. No swallowed errors, no default-on-failure.
- **§5.1:** `place_refs` has `unique (source, source_id)`. The same real-world place has one `places` row and N `place_refs` rows.
- **§5.2:** `saved_places` has `unique (user_id, reel_video_id)`. Manual entries have `reel_video_id = NULL`; Postgres treats NULLs as distinct, so manual entries never collide.
- **§5.2:** `saved_places` rows are created with `status = 'pending'` by the ingestion path. Slice 1 has no ingestion, so **manual entries are created with `status = 'resolved'`.**
- **§13:** `assertQuota()` is built and returns `true` unconditionally. No billing, no plans, no paywalls.
- **Out of scope for this slice:** Instagram webhooks, scraping, `place_facts`, `preference_signals`, `user_profile`, `itineraries`, `itinerary_stops`, `violations`.

## Spec additions made by this plan

§5.2 of the spec defines no tables for authentication. This plan adds two, and the spec should be updated to match after execution:

- `auth_tokens` — single-use, hashed, short-TTL tokens. Carries an optional `igsid` (the DM path) or an optional `group_id` (the invite path).
- `sessions` — opaque server-side sessions, revocable. Chosen over a JWT because §13 flags that a leaked magic link is a bearer credential; revocability matters more here than statelessness.

## File Structure

```
gaja/
  docker-compose.yml           Postgres 16 for local + test
  drizzle.config.ts            migration config
  vitest.config.ts             test config, loads .env.test
  src/
    db/
      schema/
        users.ts               users + the D3 CHECK constraint
        auth.ts                auth_tokens, sessions
        groups.ts              groups, group_members, group_invites
        places.ts              places, place_refs
        saved.ts               saved_places
        usage.ts               usage_counters
        index.ts               re-exports every table for drizzle-kit
      client.ts                the Drizzle client singleton
    auth/
      tokens.ts                newToken/hashToken — crypto only, no DB
      magic-link.ts            issueMagicLink, resolveMagicLink  ← the heart
      session.ts               createSession, readSession, destroySession
    groups/
      service.ts               createGroup, createInvite, acceptInvite
    places/
      service.ts               upsertPlace, addPlaceRef, findPlaceByRef
    saved/
      service.ts               savePlaceManually, listSavedPlaces
    quota/
      assert.ts                assertQuota — the metering seam
    app/
      layout.tsx               shell
      page.tsx                 landing / saved list
      auth/[token]/route.ts    token consumption endpoint
      groups/page.tsx          group list + invite UI
  tests/
    helpers/db.ts              resetDb, withTestDb
    *.test.ts                  one file per service module
```

Files are split by responsibility, not by layer: `auth/` holds everything that decides who someone is; `groups/`, `places/`, `saved/` each own one noun. `tokens.ts` is deliberately separate from `magic-link.ts` because it is pure crypto with no database — that makes it trivially testable and reusable by the invite path.

---

### Task 1: Project skeleton and test harness

**Files:**
- Create: `package.json`, `docker-compose.yml`, `drizzle.config.ts`, `vitest.config.ts`, `.env.test`, `src/db/client.ts`, `src/db/schema/index.ts`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `db` (Drizzle client from `src/db/client.ts`), `npm test` runs Vitest against a live Postgres

- [ ] **Step 1: Scaffold the Next.js app**

```bash
cd /Users/anubilegdemberel/gaja
npx create-next-app@latest . --typescript --app --tailwind --eslint --src-dir --import-alias "@/*" --use-npm --yes
```

- [ ] **Step 2: Install dependencies**

```bash
npm install drizzle-orm postgres
npm install -D drizzle-kit vitest dotenv @types/node
```

- [ ] **Step 3: Create the local Postgres**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: gaja
      POSTGRES_PASSWORD: gaja
      POSTGRES_DB: gaja
    ports:
      - "55432:5432"
```

Then:

```bash
docker compose up -d db
```

- [ ] **Step 4: Create env and config files**

`.env.test`:

```
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja
```

`drizzle.config.ts`:

```ts
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { config } from 'dotenv'

config({ path: '.env.test' })

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
  },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
})
```

`fileParallelism: false` matters: the tests share one database and truncate between runs. Parallel files would race.

- [ ] **Step 5: Create the database client**

`src/db/client.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')

export const sql = postgres(url, { max: 5 })
export const db = drizzle(sql, { schema })
```

`src/db/schema/index.ts`:

```ts
export {}
```

- [ ] **Step 6: Write the failing smoke test**

`tests/smoke.test.ts`:

```ts
import { expect, test } from 'vitest'
import { sql } from '@/db/client'

test('database is reachable', async () => {
  const rows = await sql`SELECT 1 AS one`
  expect(rows[0].one).toBe(1)
})
```

- [ ] **Step 7: Run it and watch it fail**

```bash
npx vitest run tests/smoke.test.ts
```

Expected: FAIL — `DATABASE_URL is not set` or a connection error, because the test script is not wired up yet.

- [ ] **Step 8: Wire up the test script**

Add to `package.json` `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest",
"db:push": "drizzle-kit push"
```

- [ ] **Step 9: Run it and watch it pass**

```bash
npm test
```

Expected: PASS, 1 test.

- [ ] **Step 10: Commit**

```bash
git init
git add -A
git commit -m "chore: scaffold Next.js app, Postgres, Drizzle and Vitest harness

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `users` and the recovery-channel constraint

This is the most important task in the slice. Global constraint D3 exists because an invite-joiner with no `igsid` and no `email` is permanently locked out, and that is a data-loss bug. The test that proves the constraint fires is the one that matters.

**Files:**
- Create: `src/db/schema/users.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/users.test.ts`, `tests/helpers/db.ts`

**Interfaces:**
- Consumes: `db` from Task 1
- Produces: `users` table. Columns: `id` uuid pk, `displayName` text, `avatarUrl` text, `email` text unique nullable, `emailVerifiedAt` timestamptz, `igsid` text unique nullable, `locale` text default `'ko'`, `homeArea` text, `profileVisibleInGroups` boolean not null default true, `plan` text not null default `'free'`, `createdAt` timestamptz not null default now, `lastActiveAt` timestamptz. Also produces `resetDb()` from `tests/helpers/db.ts`.

- [ ] **Step 1: Write the test helper**

`tests/helpers/db.ts`:

```ts
import { sql } from '@/db/client'

export async function resetDb() {
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations'
  `
  if (tables.length === 0) return
  const list = tables.map((t) => `"${t.tablename}"`).join(', ')
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
}
```

- [ ] **Step 2: Write the failing tests**

`tests/users.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

describe('users recovery channel', () => {
  test('an account with only an igsid is allowed', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_1' }).returning()
    expect(u.igsid).toBe('IG_1')
    expect(u.plan).toBe('free')
    expect(u.profileVisibleInGroups).toBe(true)
  })

  test('an account with only an email is allowed', async () => {
    const [u] = await db.insert(users).values({ email: 'a@b.com' }).returning()
    expect(u.email).toBe('a@b.com')
  })

  test('an account with neither is REJECTED', async () => {
    await expect(
      db.insert(users).values({ displayName: 'nobody' }),
    ).rejects.toThrow(/recovery_channel/)
  })

  test('igsid is unique', async () => {
    await db.insert(users).values({ igsid: 'IG_2' })
    await expect(db.insert(users).values({ igsid: 'IG_2' })).rejects.toThrow()
  })

  test('email is unique', async () => {
    await db.insert(users).values({ email: 'dup@b.com' })
    await expect(db.insert(users).values({ email: 'dup@b.com' })).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run and watch it fail**

```bash
npx vitest run tests/users.test.ts
```

Expected: FAIL — cannot resolve `@/db/schema/users`.

- [ ] **Step 4: Write the schema**

`src/db/schema/users.ts`:

```ts
import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    email: text('email').unique(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    igsid: text('igsid').unique(),
    locale: text('locale').notNull().default('ko'),
    homeArea: text('home_area'),
    profileVisibleInGroups: boolean('profile_visible_in_groups').notNull().default(true),
    plan: text('plan').notNull().default('free'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
  },
  (t) => [
    check('recovery_channel', sql`${t.igsid} IS NOT NULL OR ${t.email} IS NOT NULL`),
  ],
)
```

`src/db/schema/index.ts`:

```ts
export * from './users'
```

- [ ] **Step 5: Push the schema and run the tests**

```bash
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja npx drizzle-kit push --force
npx vitest run tests/users.test.ts
```

Expected: PASS, 5 tests. If "an account with neither is REJECTED" passes for the wrong reason, verify the constraint exists:

```bash
docker compose exec db psql -U gaja -d gaja -c "\d+ users" | grep recovery_channel
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: users table with the recovery-channel CHECK constraint (D3)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Token primitives

Pure crypto, no database. Kept separate from `magic-link.ts` so the invite path in Task 6 can reuse it and so it can be tested without a database round trip.

**Files:**
- Create: `src/auth/tokens.ts`
- Test: `tests/tokens.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `newToken(): { raw: string; hash: string }` and `hashToken(raw: string): string`. `raw` is base64url of 32 random bytes; `hash` is the lowercase hex sha256 of `raw`.

- [ ] **Step 1: Write the failing test**

`tests/tokens.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { hashToken, newToken } from '@/auth/tokens'

describe('token primitives', () => {
  test('newToken returns a raw token and its hash', () => {
    const { raw, hash } = newToken()
    expect(raw.length).toBeGreaterThanOrEqual(40)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(raw)
  })

  test('hashToken is deterministic and matches newToken', () => {
    const { raw, hash } = newToken()
    expect(hashToken(raw)).toBe(hash)
  })

  test('two tokens never collide', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newToken().raw))
    expect(seen.size).toBe(500)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/tokens.test.ts
```

Expected: FAIL — cannot resolve `@/auth/tokens`.

- [ ] **Step 3: Implement**

`src/auth/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: hashToken(raw) }
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run tests/tokens.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: hashed single-use token primitives

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `auth_tokens`, `sessions`, and token consumption

**Files:**
- Create: `src/db/schema/auth.ts`, `src/auth/session.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/session.test.ts`

**Interfaces:**
- Consumes: `db`, `users`, `newToken`, `hashToken`
- Produces:
  - `authTokens` table: `id` uuid pk, `tokenHash` text not null unique, `igsid` text nullable, `groupId` uuid nullable, `expiresAt` timestamptz not null, `usedAt` timestamptz nullable, `createdAt` timestamptz not null default now
  - `sessions` table: `id` uuid pk, `userId` uuid not null → users, `expiresAt` timestamptz not null, `createdAt` timestamptz not null default now
  - `consumeToken(raw: string): Promise<AuthToken>` — throws `TokenError` with `code` of `'not_found' | 'expired' | 'already_used'`
  - `createSession(userId: string, expiresAt?: Date): Promise<{ id: string }>` — `expiresAt` defaults to 60 days out; tests pass a past date to exercise expiry
  - `readSession(id: string): Promise<{ userId: string } | null>`
  - `class TokenError extends Error { code: string }`

- [ ] **Step 1: Write the failing tests**

`tests/session.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { authTokens } from '@/db/schema/auth'
import { newToken } from '@/auth/tokens'
import { consumeToken, createSession, readSession } from '@/auth/session'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

async function issue(overrides: Partial<{ igsid: string; expiresAt: Date }> = {}) {
  const { raw, hash } = newToken()
  await db.insert(authTokens).values({
    tokenHash: hash,
    igsid: overrides.igsid ?? 'IG_X',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60_000),
  })
  return raw
}

describe('consumeToken', () => {
  test('consumes a valid token once', async () => {
    const raw = await issue()
    const t = await consumeToken(raw)
    expect(t.igsid).toBe('IG_X')
    expect(t.usedAt).not.toBeNull()
  })

  test('rejects a second use', async () => {
    const raw = await issue()
    await consumeToken(raw)
    await expect(consumeToken(raw)).rejects.toMatchObject({ code: 'already_used' })
  })

  test('rejects an expired token', async () => {
    const raw = await issue({ expiresAt: new Date(Date.now() - 1000) })
    await expect(consumeToken(raw)).rejects.toMatchObject({ code: 'expired' })
  })

  test('rejects an unknown token', async () => {
    await expect(consumeToken('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  test('the raw token is never stored', async () => {
    const raw = await issue()
    const rows = await db.select().from(authTokens)
    expect(rows[0].tokenHash).not.toBe(raw)
  })
})

describe('sessions', () => {
  test('a session round-trips to its user', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_S' }).returning()
    const s = await createSession(u.id)
    expect(await readSession(s.id)).toEqual({ userId: u.id })
  })

  test('an expired session reads as null', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_S2' }).returning()
    const s = await createSession(u.id, new Date(Date.now() - 1000))
    expect(await readSession(s.id)).toBeNull()
  })

  test('an unknown session reads as null', async () => {
    expect(await readSession('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/session.test.ts
```

Expected: FAIL — cannot resolve `@/db/schema/auth`.

- [ ] **Step 3: Write the schema**

`src/db/schema/auth.ts`:

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  igsid: text('igsid'),
  groupId: uuid('group_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

Add to `src/db/schema/index.ts`:

```ts
export * from './auth'
```

- [ ] **Step 4: Implement session and token consumption**

`src/auth/session.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { authTokens, sessions } from '@/db/schema/auth'
import { hashToken } from './tokens'

export class TokenError extends Error {
  constructor(public code: 'not_found' | 'expired' | 'already_used') {
    super(`token ${code}`)
    this.name = 'TokenError'
  }
}

const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

export async function consumeToken(raw: string) {
  const hash = hashToken(raw)

  // Single-statement claim: only an unused row is updated, so two concurrent
  // requests cannot both win. Checking then updating would race.
  const [claimed] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.tokenHash, hash), isNull(authTokens.usedAt)))
    .returning()

  if (claimed) {
    if (claimed.expiresAt.getTime() < Date.now()) throw new TokenError('expired')
    return claimed
  }

  const [existing] = await db.select().from(authTokens).where(eq(authTokens.tokenHash, hash))
  if (!existing) throw new TokenError('not_found')
  throw new TokenError('already_used')
}

export async function createSession(userId: string, expiresAt?: Date) {
  const [s] = await db
    .insert(sessions)
    .values({ userId, expiresAt: expiresAt ?? new Date(Date.now() + SESSION_TTL_MS) })
    .returning()
  return { id: s.id }
}

export async function readSession(id: string) {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, id))
  if (!s) return null
  if (s.expiresAt.getTime() < Date.now()) return null
  return { userId: s.userId }
}
```

Note the expiry check happens *after* the claim. An expired token is still burned on contact, so a leaked link cannot be probed repeatedly.

- [ ] **Step 5: Push the schema and run the tests**

```bash
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja npx drizzle-kit push --force
npx vitest run tests/session.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: auth_tokens and sessions with race-free single-use consumption

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The magic link's dual semantics

The heart of the slice. One token does two different jobs depending on whether the caller already has a session. Spec D3: *"Its first job was sign-in. Its second is linking."*

**Files:**
- Create: `src/auth/magic-link.ts`
- Test: `tests/magic-link.test.ts`

**Interfaces:**
- Consumes: `db`, `users`, `authTokens`, `newToken`, `consumeToken`, `createSession`, `TokenError`
- Produces:
  - `issueMagicLink(opts: { igsid?: string; groupId?: string; ttlMinutes?: number }): Promise<string>` — returns the **raw** token, the only time it exists
  - `resolveMagicLink(raw: string, currentUserId?: string): Promise<{ userId: string; sessionId: string; action: 'signed_in' | 'created' | 'linked' }>`
  - `class LinkConflictError extends Error` — thrown when the token's `igsid` already belongs to a different user

- [ ] **Step 1: Write the failing tests**

`tests/magic-link.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { issueMagicLink, LinkConflictError, resolveMagicLink } from '@/auth/magic-link'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

describe('resolveMagicLink — no current session', () => {
  test('an unknown igsid creates an account', async () => {
    const raw = await issueMagicLink({ igsid: 'IG_NEW' })
    const r = await resolveMagicLink(raw)
    expect(r.action).toBe('created')
    const [u] = await db.select().from(users).where(eq(users.id, r.userId))
    expect(u.igsid).toBe('IG_NEW')
  })

  test('a known igsid signs the existing account in', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_KNOWN' }).returning()
    const raw = await issueMagicLink({ igsid: 'IG_KNOWN' })
    const r = await resolveMagicLink(raw)
    expect(r.action).toBe('signed_in')
    expect(r.userId).toBe(u.id)
  })
})

describe('resolveMagicLink — with a current session', () => {
  test('an unclaimed igsid links to the current account', async () => {
    const [joiner] = await db.insert(users).values({ email: 'j@b.com' }).returning()
    const raw = await issueMagicLink({ igsid: 'IG_LINK' })
    const r = await resolveMagicLink(raw, joiner.id)
    expect(r.action).toBe('linked')
    expect(r.userId).toBe(joiner.id)
    const [u] = await db.select().from(users).where(eq(users.id, joiner.id))
    expect(u.igsid).toBe('IG_LINK')
  })

  test('an igsid already on another account is a conflict', async () => {
    await db.insert(users).values({ igsid: 'IG_TAKEN' })
    const [other] = await db.insert(users).values({ email: 'o@b.com' }).returning()
    const raw = await issueMagicLink({ igsid: 'IG_TAKEN' })
    await expect(resolveMagicLink(raw, other.id)).rejects.toBeInstanceOf(LinkConflictError)
  })

  test('re-linking the same igsid to the same account is a no-op sign-in', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_SAME' }).returning()
    const raw = await issueMagicLink({ igsid: 'IG_SAME' })
    const r = await resolveMagicLink(raw, u.id)
    expect(r.action).toBe('signed_in')
    expect(r.userId).toBe(u.id)
  })
})

describe('resolveMagicLink — token hygiene', () => {
  test('a token cannot be resolved twice', async () => {
    const raw = await issueMagicLink({ igsid: 'IG_ONCE' })
    await resolveMagicLink(raw)
    await expect(resolveMagicLink(raw)).rejects.toMatchObject({ code: 'already_used' })
  })

  test('every resolution returns a usable session', async () => {
    const raw = await issueMagicLink({ igsid: 'IG_SESS' })
    const r = await resolveMagicLink(raw)
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/magic-link.test.ts
```

Expected: FAIL — cannot resolve `@/auth/magic-link`.

- [ ] **Step 3: Implement**

`src/auth/magic-link.ts`:

```ts
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { authTokens } from '@/db/schema/auth'
import { users } from '@/db/schema/users'
import { newToken } from './tokens'
import { consumeToken, createSession } from './session'

export class LinkConflictError extends Error {
  constructor(igsid: string) {
    super(`igsid ${igsid} already belongs to another account`)
    this.name = 'LinkConflictError'
  }
}

const DEFAULT_TTL_MINUTES = 15

export async function issueMagicLink(opts: {
  igsid?: string
  groupId?: string
  ttlMinutes?: number
}): Promise<string> {
  const { raw, hash } = newToken()
  await db.insert(authTokens).values({
    tokenHash: hash,
    igsid: opts.igsid ?? null,
    groupId: opts.groupId ?? null,
    expiresAt: new Date(Date.now() + (opts.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000),
  })
  return raw
}

export async function resolveMagicLink(
  raw: string,
  currentUserId?: string,
): Promise<{ userId: string; sessionId: string; action: 'signed_in' | 'created' | 'linked' }> {
  const token = await consumeToken(raw)
  if (!token.igsid) throw new Error('magic link carries no igsid')

  const [owner] = await db.select().from(users).where(eq(users.igsid, token.igsid))

  let userId: string
  let action: 'signed_in' | 'created' | 'linked'

  if (currentUserId) {
    if (owner && owner.id !== currentUserId) throw new LinkConflictError(token.igsid)
    if (owner) {
      userId = owner.id
      action = 'signed_in'
    } else {
      await db.update(users).set({ igsid: token.igsid }).where(eq(users.id, currentUserId))
      userId = currentUserId
      action = 'linked'
    }
  } else if (owner) {
    userId = owner.id
    action = 'signed_in'
  } else {
    const [created] = await db.insert(users).values({ igsid: token.igsid }).returning()
    userId = created.id
    action = 'created'
  }

  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId))
  const session = await createSession(userId)
  return { userId, sessionId: session.id, action }
}
```

- [ ] **Step 4: Run and watch it pass**

```bash
npx vitest run tests/magic-link.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: magic link with dual sign-in and igsid-link semantics (D3)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Groups, invites, and the joiner's recovery channel

**Files:**
- Create: `src/db/schema/groups.ts`, `src/groups/service.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/groups.test.ts`

**Interfaces:**
- Consumes: `db`, `users`, `authTokens`, `issueMagicLink`, `consumeToken`, `createSession`
- Produces:
  - `groups` table: `id` uuid pk, `name` text not null, `createdBy` uuid not null → users, `createdAt`
  - `groupMembers` table: `groupId` uuid → groups, `userId` uuid → users, `role` text not null, `joinedAt`, `unique(groupId, userId)`
  - `createGroup(ownerId: string, name: string): Promise<{ id: string }>`
  - `createInvite(groupId: string, createdBy: string, ttlMinutes?: number): Promise<string>` — returns the raw token
  - `acceptInvite(raw: string, opts: { currentUserId?: string; email?: string; displayName?: string }): Promise<{ userId: string; sessionId: string; groupId: string }>`
  - `class RecoveryChannelRequiredError extends Error`

`group_invites` from the spec is **not** a separate table: invites are `auth_tokens` rows carrying a `groupId`. One token table, one consumption path, one place for expiry and single-use to be correct. Spec §5.2 should be updated to match.

- [ ] **Step 1: Write the failing tests**

`tests/groups.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { groupMembers, groups } from '@/db/schema/groups'
import {
  acceptInvite,
  createGroup,
  createInvite,
  RecoveryChannelRequiredError,
} from '@/groups/service'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

async function owner() {
  const [u] = await db.insert(users).values({ igsid: 'IG_OWNER' }).returning()
  return u
}

describe('createGroup', () => {
  test('the creator becomes the owner member', async () => {
    const u = await owner()
    const g = await createGroup(u.id, '우리')
    const [m] = await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, u.id)))
    expect(m.role).toBe('owner')
  })
})

describe('acceptInvite', () => {
  test('a joiner with an email joins and gets a session', async () => {
    const u = await owner()
    const g = await createGroup(u.id, '우리')
    const raw = await createInvite(g.id, u.id)
    const r = await acceptInvite(raw, { email: 'j@b.com', displayName: '준호' })
    expect(r.groupId).toBe(g.id)
    const [m] = await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, r.userId)))
    expect(m.role).toBe('member')
  })

  test('a joiner with NO recovery channel is REJECTED', async () => {
    const u = await owner()
    const g = await createGroup(u.id, '우리')
    const raw = await createInvite(g.id, u.id)
    await expect(acceptInvite(raw, { displayName: '준호' })).rejects.toBeInstanceOf(
      RecoveryChannelRequiredError,
    )
  })

  test('an existing signed-in user joins without needing an email', async () => {
    const u = await owner()
    const [existing] = await db.insert(users).values({ igsid: 'IG_EXIST' }).returning()
    const g = await createGroup(u.id, '우리')
    const raw = await createInvite(g.id, u.id)
    const r = await acceptInvite(raw, { currentUserId: existing.id })
    expect(r.userId).toBe(existing.id)
  })

  test('joining twice does not duplicate membership', async () => {
    const u = await owner()
    const [existing] = await db.insert(users).values({ igsid: 'IG_TWICE' }).returning()
    const g = await createGroup(u.id, '우리')
    await acceptInvite(await createInvite(g.id, u.id), { currentUserId: existing.id })
    await acceptInvite(await createInvite(g.id, u.id), { currentUserId: existing.id })
    const rows = await db
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, existing.id)))
    expect(rows).toHaveLength(1)
  })

  test('an invite cannot be reused', async () => {
    const u = await owner()
    const g = await createGroup(u.id, '우리')
    const raw = await createInvite(g.id, u.id)
    await acceptInvite(raw, { email: 'a@b.com' })
    await expect(acceptInvite(raw, { email: 'c@b.com' })).rejects.toMatchObject({
      code: 'already_used',
    })
  })

  test('an expired invite is rejected', async () => {
    const u = await owner()
    const g = await createGroup(u.id, '우리')
    const raw = await createInvite(g.id, u.id, -1)
    await expect(acceptInvite(raw, { email: 'd@b.com' })).rejects.toMatchObject({
      code: 'expired',
    })
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/groups.test.ts
```

Expected: FAIL — cannot resolve `@/db/schema/groups`.

- [ ] **Step 3: Write the schema**

`src/db/schema/groups.ts`:

```ts
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('group_members_unique').on(t.groupId, t.userId)],
)
```

Add to `src/db/schema/index.ts`:

```ts
export * from './groups'
```

- [ ] **Step 4: Implement the service**

`src/groups/service.ts`:

```ts
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { groupMembers, groups } from '@/db/schema/groups'
import { users } from '@/db/schema/users'
import { consumeToken, createSession } from '@/auth/session'
import { issueMagicLink } from '@/auth/magic-link'

export class RecoveryChannelRequiredError extends Error {
  constructor() {
    super('a joiner with no Instagram account must supply an email (spec D3)')
    this.name = 'RecoveryChannelRequiredError'
  }
}

export async function createGroup(ownerId: string, name: string) {
  const [g] = await db.insert(groups).values({ name, createdBy: ownerId }).returning()
  await db.insert(groupMembers).values({ groupId: g.id, userId: ownerId, role: 'owner' })
  return { id: g.id }
}

export function createInvite(groupId: string, createdBy: string, ttlMinutes = 60 * 24 * 7) {
  void createdBy
  return issueMagicLink({ groupId, ttlMinutes })
}

export async function acceptInvite(
  raw: string,
  opts: { currentUserId?: string; email?: string; displayName?: string },
) {
  const token = await consumeToken(raw)
  if (!token.groupId) throw new Error('token is not a group invite')

  let userId = opts.currentUserId
  if (!userId) {
    // D3: this account will have no igsid, so an email is the only recovery
    // channel it can have. The CHECK constraint would reject it anyway; we
    // fail here so the message names the actual problem.
    if (!opts.email) throw new RecoveryChannelRequiredError()
    const [created] = await db
      .insert(users)
      .values({ email: opts.email, displayName: opts.displayName ?? null })
      .returning()
    userId = created.id
  }

  await db
    .insert(groupMembers)
    .values({ groupId: token.groupId, userId, role: 'member' })
    .onConflictDoNothing()

  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId))
  const session = await createSession(userId)
  return { userId, sessionId: session.id, groupId: token.groupId }
}
```

- [ ] **Step 5: Push the schema and run the tests**

```bash
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja npx drizzle-kit push --force
npx vitest run tests/groups.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: groups, invites, and the joiner recovery-channel rule

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Places and place refs

Spec §5.1: the same real-world café has up to four source identities, and they must collapse to one `places` row.

**Files:**
- Create: `src/db/schema/places.ts`, `src/places/service.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/places.test.ts`

**Interfaces:**
- Consumes: `db`
- Produces:
  - `places` table: `id` uuid pk, `name` text not null, `nameAlt` text[] not null default `[]`, `category` text not null, `lat` double, `lng` double, `address` text, `area` text, `createdAt`
  - `placeRefs` table: `placeId` uuid → places, `source` text, `sourceId` text, `url` text, `unique(source, sourceId)`
  - `createPlace(input: { name: string; category: string; lat?: number; lng?: number; address?: string; area?: string; nameAlt?: string[] }): Promise<{ id: string }>`
  - `addPlaceRef(placeId: string, source: 'naver' | 'kakao' | 'google', sourceId: string, url?: string): Promise<void>`
  - `findPlaceByRef(source: string, sourceId: string): Promise<{ id: string; name: string } | null>`

- [ ] **Step 1: Write the failing tests**

`tests/places.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { addPlaceRef, createPlace, findPlaceByRef } from '@/places/service'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

describe('places', () => {
  test('a place can be created with Korean names and alternates', async () => {
    const p = await createPlace({
      name: '어니언 성수',
      nameAlt: ['Onion Seongsu'],
      category: 'cafe',
      area: '성수',
      lat: 37.5445,
      lng: 127.0559,
    })
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('one place carries refs from several sources', async () => {
    const p = await createPlace({ name: '어니언 성수', category: 'cafe' })
    await addPlaceRef(p.id, 'kakao', 'K1')
    await addPlaceRef(p.id, 'naver', 'N1')
    await addPlaceRef(p.id, 'google', 'G1')
    expect(await findPlaceByRef('naver', 'N1')).toMatchObject({ id: p.id })
    expect(await findPlaceByRef('kakao', 'K1')).toMatchObject({ id: p.id })
  })

  test('the same source id cannot point at two places', async () => {
    const a = await createPlace({ name: 'A', category: 'cafe' })
    const b = await createPlace({ name: 'B', category: 'cafe' })
    await addPlaceRef(a.id, 'kakao', 'SAME')
    await expect(addPlaceRef(b.id, 'kakao', 'SAME')).rejects.toThrow()
  })

  test('the same source id in two different sources is fine', async () => {
    const p = await createPlace({ name: 'A', category: 'cafe' })
    await addPlaceRef(p.id, 'kakao', 'X')
    await addPlaceRef(p.id, 'naver', 'X')
    expect(await findPlaceByRef('naver', 'X')).toMatchObject({ id: p.id })
  })

  test('an unknown ref returns null', async () => {
    expect(await findPlaceByRef('kakao', 'MISSING')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/places.test.ts
```

Expected: FAIL — cannot resolve `@/db/schema/places`.

- [ ] **Step 3: Write the schema**

`src/db/schema/places.ts`:

```ts
import { doublePrecision, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

export const places = pgTable('places', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  nameAlt: text('name_alt').array().notNull().default([]),
  category: text('category').notNull(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  address: text('address'),
  area: text('area'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const placeRefs = pgTable(
  'place_refs',
  {
    placeId: uuid('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url'),
  },
  (t) => [unique('place_refs_source_unique').on(t.source, t.sourceId)],
)
```

Add to `src/db/schema/index.ts`:

```ts
export * from './places'
```

- [ ] **Step 4: Implement the service**

`src/places/service.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { placeRefs, places } from '@/db/schema/places'

export async function createPlace(input: {
  name: string
  category: string
  nameAlt?: string[]
  lat?: number
  lng?: number
  address?: string
  area?: string
}) {
  const [p] = await db
    .insert(places)
    .values({
      name: input.name,
      category: input.category,
      nameAlt: input.nameAlt ?? [],
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      address: input.address ?? null,
      area: input.area ?? null,
    })
    .returning()
  return { id: p.id }
}

export async function addPlaceRef(
  placeId: string,
  source: 'naver' | 'kakao' | 'google',
  sourceId: string,
  url?: string,
) {
  await db.insert(placeRefs).values({ placeId, source, sourceId, url: url ?? null })
}

export async function findPlaceByRef(source: string, sourceId: string) {
  const [row] = await db
    .select({ id: places.id, name: places.name })
    .from(placeRefs)
    .innerJoin(places, eq(places.id, placeRefs.placeId))
    .where(and(eq(placeRefs.source, source), eq(placeRefs.sourceId, sourceId)))
  return row ?? null
}
```

- [ ] **Step 5: Push the schema and run the tests**

```bash
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja npx drizzle-kit push --force
npx vitest run tests/places.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: places and multi-source place refs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Saved places and manual entry

Global constraint: `unique (user_id, reel_video_id)` with manual entries carrying `reel_video_id = NULL`. Postgres treats NULLs as distinct in a unique index, so a user may hand-enter many places without collision while a re-shared reel still deduplicates. **The test proving both halves is the point of this task.**

**Files:**
- Create: `src/db/schema/saved.ts`, `src/saved/service.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/saved.test.ts`

**Interfaces:**
- Consumes: `db`, `users`, `groups`, `places`, `createPlace`
- Produces:
  - `savedPlaces` table: `id` uuid pk, `userId` uuid not null → users, `groupId` uuid nullable → groups, `placeId` uuid nullable → places, `reelVideoId` text nullable, `sourceUrl` text, `rawCaption` text, `extracted` jsonb, `hook` text, `status` text not null, `confirmed` boolean not null default true, `savedAt` timestamptz not null default now, `unique(userId, reelVideoId)`
  - `savePlaceManually(input: { userId: string; placeId: string; groupId?: string; hook?: string }): Promise<{ id: string }>`
  - `listSavedPlaces(userId: string, groupId?: string): Promise<Array<{ id: string; placeName: string; hook: string | null; status: string; confirmed: boolean }>>`

- [ ] **Step 1: Write the failing tests**

`tests/saved.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { savedPlaces } from '@/db/schema/saved'
import { createPlace } from '@/places/service'
import { createGroup } from '@/groups/service'
import { listSavedPlaces, savePlaceManually } from '@/saved/service'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

async function user(igsid = 'IG_SAVE') {
  const [u] = await db.insert(users).values({ igsid }).returning()
  return u
}

describe('savePlaceManually', () => {
  test('a manual entry is resolved and confirmed', async () => {
    const u = await user()
    const p = await createPlace({ name: '대림창고', category: 'cafe', area: '성수' })
    const s = await savePlaceManually({ userId: u.id, placeId: p.id, hook: '루프탑 뷰' })
    const [row] = await db.select().from(savedPlaces)
    expect(row.id).toBe(s.id)
    expect(row.status).toBe('resolved')
    expect(row.confirmed).toBe(true)
    expect(row.reelVideoId).toBeNull()
    expect(row.hook).toBe('루프탑 뷰')
  })

  test('MANY manual entries by one user do not collide on the null reel id', async () => {
    const u = await user()
    const a = await createPlace({ name: 'A', category: 'cafe' })
    const b = await createPlace({ name: 'B', category: 'cafe' })
    const c = await createPlace({ name: 'C', category: 'shop' })
    await savePlaceManually({ userId: u.id, placeId: a.id })
    await savePlaceManually({ userId: u.id, placeId: b.id })
    await savePlaceManually({ userId: u.id, placeId: c.id })
    expect(await db.select().from(savedPlaces)).toHaveLength(3)
  })

  test('the same reel saved twice by one user IS rejected', async () => {
    const u = await user()
    const p = await createPlace({ name: 'A', category: 'cafe' })
    await db.insert(savedPlaces).values({
      userId: u.id, placeId: p.id, reelVideoId: 'R1', status: 'resolved',
    })
    await expect(
      db.insert(savedPlaces).values({
        userId: u.id, placeId: p.id, reelVideoId: 'R1', status: 'resolved',
      }),
    ).rejects.toThrow()
  })

  test('the same reel saved by two different users is fine', async () => {
    const u1 = await user('IG_A')
    const u2 = await user('IG_B')
    const p = await createPlace({ name: 'A', category: 'cafe' })
    await db.insert(savedPlaces).values({
      userId: u1.id, placeId: p.id, reelVideoId: 'R2', status: 'resolved',
    })
    await db.insert(savedPlaces).values({
      userId: u2.id, placeId: p.id, reelVideoId: 'R2', status: 'resolved',
    })
    expect(await db.select().from(savedPlaces)).toHaveLength(2)
  })
})

describe('listSavedPlaces', () => {
  test('personal saves are listed when no group is given', async () => {
    const u = await user()
    const p = await createPlace({ name: '어니언 성수', category: 'cafe' })
    await savePlaceManually({ userId: u.id, placeId: p.id, hook: '티라미수' })
    const rows = await listSavedPlaces(u.id)
    expect(rows).toEqual([
      expect.objectContaining({ placeName: '어니언 성수', hook: '티라미수' }),
    ])
  })

  test('group saves are separate from personal saves', async () => {
    const u = await user()
    const g = await createGroup(u.id, '우리')
    const p1 = await createPlace({ name: 'Personal', category: 'cafe' })
    const p2 = await createPlace({ name: 'Shared', category: 'cafe' })
    await savePlaceManually({ userId: u.id, placeId: p1.id })
    await savePlaceManually({ userId: u.id, placeId: p2.id, groupId: g.id })
    expect(await listSavedPlaces(u.id)).toHaveLength(1)
    expect(await listSavedPlaces(u.id, g.id)).toEqual([
      expect.objectContaining({ placeName: 'Shared' }),
    ])
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/saved.test.ts
```

Expected: FAIL — cannot resolve `@/db/schema/saved`.

- [ ] **Step 3: Write the schema**

`src/db/schema/saved.ts`:

```ts
import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import { groups } from './groups'
import { places } from './places'

export const savedPlaces = pgTable(
  'saved_places',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
    placeId: uuid('place_id').references(() => places.id, { onDelete: 'set null' }),
    reelVideoId: text('reel_video_id'),
    sourceUrl: text('source_url'),
    rawCaption: text('raw_caption'),
    extracted: jsonb('extracted'),
    hook: text('hook'),
    status: text('status').notNull(),
    confirmed: boolean('confirmed').notNull().default(true),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('saved_places_user_reel_unique').on(t.userId, t.reelVideoId)],
)
```

Add to `src/db/schema/index.ts`:

```ts
export * from './saved'
```

- [ ] **Step 4: Implement the service**

`src/saved/service.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db/client'
import { savedPlaces } from '@/db/schema/saved'
import { places } from '@/db/schema/places'

export async function savePlaceManually(input: {
  userId: string
  placeId: string
  groupId?: string
  hook?: string
}) {
  // Manual entries skip the pending → resolved lifecycle that ingestion uses
  // (spec §5.2): there is nothing to extract, so they are resolved on arrival.
  const [row] = await db
    .insert(savedPlaces)
    .values({
      userId: input.userId,
      placeId: input.placeId,
      groupId: input.groupId ?? null,
      hook: input.hook ?? null,
      reelVideoId: null,
      status: 'resolved',
      confirmed: true,
    })
    .returning()
  return { id: row.id }
}

export async function listSavedPlaces(userId: string, groupId?: string) {
  return db
    .select({
      id: savedPlaces.id,
      placeName: places.name,
      hook: savedPlaces.hook,
      status: savedPlaces.status,
      confirmed: savedPlaces.confirmed,
    })
    .from(savedPlaces)
    .innerJoin(places, eq(places.id, savedPlaces.placeId))
    .where(
      and(
        eq(savedPlaces.userId, userId),
        groupId ? eq(savedPlaces.groupId, groupId) : isNull(savedPlaces.groupId),
      ),
    )
}
```

- [ ] **Step 5: Push the schema and run the tests**

```bash
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja npx drizzle-kit push --force
npx vitest run tests/saved.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: saved_places with manual entry and reel dedup semantics

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The metering seam

Spec §13: built now, returns `true` unconditionally, inserted at exactly two call sites. Slice 1 has only one of them; `start_planning_run` arrives in slice 2.

**Files:**
- Create: `src/db/schema/usage.ts`, `src/quota/assert.ts`
- Modify: `src/db/schema/index.ts`
- Test: `tests/quota.test.ts`

**Interfaces:**
- Consumes: `db`, `users`
- Produces:
  - `usageCounters` table: `userId` uuid → users, `period` text, `unit` text, `count` integer not null default 0, `unique(userId, period, unit)`
  - `assertQuota(userId: string, unit: 'extraction' | 'planning_run'): Promise<boolean>` — always returns `true`, always increments
  - `currentPeriod(now?: Date): string` — `YYYY-MM` in UTC

- [ ] **Step 1: Write the failing tests**

`tests/quota.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { usageCounters } from '@/db/schema/usage'
import { assertQuota, currentPeriod } from '@/quota/assert'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

describe('assertQuota', () => {
  test('always allows, for now', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_Q' }).returning()
    expect(await assertQuota(u.id, 'extraction')).toBe(true)
  })

  test('increments the counter for the period and unit', async () => {
    const [u] = await db.insert(users).values({ igsid: 'IG_Q2' }).returning()
    await assertQuota(u.id, 'extraction')
    await assertQuota(u.id, 'extraction')
    await assertQuota(u.id, 'planning_run')
    const [ext] = await db
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.userId, u.id),
          eq(usageCounters.unit, 'extraction'),
          eq(usageCounters.period, currentPeriod()),
        ),
      )
    expect(ext.count).toBe(2)
    expect(await db.select().from(usageCounters)).toHaveLength(2)
  })

  test('currentPeriod is a UTC YYYY-MM string', () => {
    expect(currentPeriod(new Date('2026-09-18T23:00:00Z'))).toBe('2026-09')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/quota.test.ts
```

Expected: FAIL — cannot resolve `@/db/schema/usage`.

- [ ] **Step 3: Write the schema**

`src/db/schema/usage.ts`:

```ts
import { integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

export const usageCounters = pgTable(
  'usage_counters',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    unit: text('unit').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [unique('usage_counters_unique').on(t.userId, t.period, t.unit)],
)
```

Add to `src/db/schema/index.ts`:

```ts
export * from './usage'
```

- [ ] **Step 4: Implement**

`src/quota/assert.ts`:

```ts
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { usageCounters } from '@/db/schema/usage'

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

/**
 * The metering seam (spec §13). Returns true unconditionally today; when
 * plans exist, this is the ONLY function that changes. Call sites:
 * enqueue_extraction (slice 3) and start_planning_run (slice 2).
 */
export async function assertQuota(
  userId: string,
  unit: 'extraction' | 'planning_run',
): Promise<boolean> {
  await db
    .insert(usageCounters)
    .values({ userId, period: currentPeriod(), unit, count: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.period, usageCounters.unit],
      set: { count: sql`${usageCounters.count} + 1` },
    })
  return true
}
```

- [ ] **Step 5: Push the schema and run the tests**

```bash
DATABASE_URL=postgres://gaja:gaja@localhost:55432/gaja npx drizzle-kit push --force
npx vitest run tests/quota.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: usage counters and the assertQuota metering seam

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Web shell, token route, and manual entry UI

The first task with no new schema. It wires the services behind a session cookie and gives the slice something a human can use.

**Files:**
- Create: `src/auth/cookies.ts`, `src/app/auth/[token]/route.ts`, `src/app/actions.ts`, `src/app/page.tsx`, `src/app/groups/page.tsx`
- Modify: `src/app/layout.tsx`
- Test: `tests/auth-route.test.ts`

**Interfaces:**
- Consumes: `resolveMagicLink`, `acceptInvite`, `consumeToken`, `readSession`, `listSavedPlaces`, `createPlace`, `savePlaceManually`, `createGroup`, `createInvite`
- Produces:
  - `SESSION_COOKIE = 'gaja_session'`
  - `currentUserId(): Promise<string | null>` — reads the cookie, validates the session
  - `GET /auth/:token` — consumes a token and redirects to `/`, setting the session cookie
  - server actions `addPlaceAction(formData)`, `newGroupAction(formData)`

- [ ] **Step 1: Write the failing test**

`tests/auth-route.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { db } from '@/db/client'
import { users } from '@/db/schema/users'
import { issueMagicLink } from '@/auth/magic-link'
import { GET } from '@/app/auth/[token]/route'
import { resetDb } from './helpers/db'

beforeEach(resetDb)

function req(token: string) {
  return new Request(`http://localhost:3000/auth/${token}`)
}

describe('GET /auth/:token', () => {
  test('a valid token redirects home and sets a session cookie', async () => {
    const raw = await issueMagicLink({ igsid: 'IG_ROUTE' })
    const res = await GET(req(raw), { params: Promise.resolve({ token: raw }) })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('gaja_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
  })

  test('the account is created on first contact', async () => {
    const raw = await issueMagicLink({ igsid: 'IG_FIRST' })
    await GET(req(raw), { params: Promise.resolve({ token: raw }) })
    const rows = await db.select().from(users)
    expect(rows).toHaveLength(1)
    expect(rows[0].igsid).toBe('IG_FIRST')
  })

  test('a used token redirects to an error, and sets no cookie', async () => {
    const raw = await issueMagicLink({ igsid: 'IG_USED' })
    await GET(req(raw), { params: Promise.resolve({ token: raw }) })
    const res = await GET(req(raw), { params: Promise.resolve({ token: raw }) })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?error=link_invalid')
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('a garbage token redirects to an error', async () => {
    const res = await GET(req('garbage'), { params: Promise.resolve({ token: 'garbage' }) })
    expect(res.headers.get('location')).toBe('/?error=link_invalid')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/auth-route.test.ts
```

Expected: FAIL — cannot resolve `@/app/auth/[token]/route`.

- [ ] **Step 3: Implement the cookie helper**

`src/auth/cookies.ts`:

```ts
import { cookies } from 'next/headers'
import { readSession } from './session'

export const SESSION_COOKIE = 'gaja_session'
const MAX_AGE = 60 * 60 * 24 * 60 // 60 days

export function sessionCookieHeader(sessionId: string): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE}`,
  ]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export async function currentUserId(): Promise<string | null> {
  const store = await cookies()
  const id = store.get(SESSION_COOKIE)?.value
  if (!id) return null
  const s = await readSession(id)
  return s?.userId ?? null
}
```

- [ ] **Step 4: Implement the token route**

`src/app/auth/[token]/route.ts`:

```ts
import { cookies } from 'next/headers'
import { db } from '@/db/client'
import { authTokens } from '@/db/schema/auth'
import { eq } from 'drizzle-orm'
import { hashToken } from '@/auth/tokens'
import { resolveMagicLink } from '@/auth/magic-link'
import { acceptInvite } from '@/groups/service'
import { SESSION_COOKIE, sessionCookieHeader } from '@/auth/cookies'

function redirect(to: string, cookie?: string) {
  const headers = new Headers({ location: to })
  if (cookie) headers.set('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  // Peek at the token's shape before consuming it, so we know which handler
  // owns it. Peeking does not burn the token; consumeToken does.
  const [row] = await db
    .select({ groupId: authTokens.groupId })
    .from(authTokens)
    .where(eq(authTokens.tokenHash, hashToken(token)))

  let current: string | null = null
  try {
    const store = await cookies()
    const sid = store.get(SESSION_COOKIE)?.value
    if (sid) {
      const { readSession } = await import('@/auth/session')
      current = (await readSession(sid))?.userId ?? null
    }
  } catch {
    current = null
  }

  try {
    if (row?.groupId) {
      const r = await acceptInvite(token, { currentUserId: current ?? undefined })
      return redirect('/groups', sessionCookieHeader(r.sessionId))
    }
    const r = await resolveMagicLink(token, current ?? undefined)
    return redirect('/', sessionCookieHeader(r.sessionId))
  } catch (err) {
    // D10: degrade loudly. The user gets a named error, and the cause is logged.
    console.error('[auth] token resolution failed', err)
    const code =
      (err as { name?: string }).name === 'LinkConflictError'
        ? 'link_conflict'
        : (err as { name?: string }).name === 'RecoveryChannelRequiredError'
          ? 'email_required'
          : 'link_invalid'
    return redirect(`/?error=${code}`)
  }
}
```

An invite accepted by a brand-new visitor with no session throws `RecoveryChannelRequiredError` and redirects to `?error=email_required`. Collecting that email is a UI flow; it is **out of scope for slice 1** and is listed under Follow-ups.

- [ ] **Step 5: Run the route tests**

```bash
npx vitest run tests/auth-route.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Implement the server actions**

`src/app/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { currentUserId } from '@/auth/cookies'
import { createPlace } from '@/places/service'
import { savePlaceManually } from '@/saved/service'
import { createGroup } from '@/groups/service'

export async function addPlaceAction(formData: FormData) {
  const userId = await currentUserId()
  if (!userId) throw new Error('not signed in')

  const name = String(formData.get('name') ?? '').trim()
  const category = String(formData.get('category') ?? '').trim()
  const area = String(formData.get('area') ?? '').trim()
  const hook = String(formData.get('hook') ?? '').trim()
  if (!name || !category) throw new Error('name and category are required')

  const place = await createPlace({ name, category, area: area || undefined })
  await savePlaceManually({ userId, placeId: place.id, hook: hook || undefined })
  revalidatePath('/')
}

export async function newGroupAction(formData: FormData) {
  const userId = await currentUserId()
  if (!userId) throw new Error('not signed in')
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('name is required')
  await createGroup(userId, name)
  revalidatePath('/groups')
}
```

- [ ] **Step 7: Implement the pages**

`src/app/page.tsx`:

```tsx
import { currentUserId } from '@/auth/cookies'
import { listSavedPlaces } from '@/saved/service'
import { addPlaceAction } from './actions'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const userId = await currentUserId()

  if (!userId) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl">Gaja</h1>
        {error && <p className="mt-4 text-red-600">링크가 유효하지 않아요 ({error})</p>}
        <p className="mt-4 text-neutral-600">
          인스타그램에서 릴스를 보내면 시작됩니다.
        </p>
      </main>
    )
  }

  const saved = await listSavedPlaces(userId)

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl">저장한 장소</h1>

      <ul className="mt-6 space-y-2">
        {saved.length === 0 && <li className="text-neutral-500">아직 없어요.</li>}
        {saved.map((s) => (
          <li key={s.id} className="border-b py-2">
            <span>{s.placeName}</span>
            {s.hook && <span className="ml-2 text-neutral-500">— {s.hook}</span>}
            {!s.confirmed && <span className="ml-2 text-amber-600">확인 필요</span>}
          </li>
        ))}
      </ul>

      <form action={addPlaceAction} className="mt-10 space-y-2">
        <h2 className="text-lg">직접 추가</h2>
        <input name="name" placeholder="장소 이름" required className="block w-full border p-2" />
        <input name="category" placeholder="cafe / restaurant / exhibition" required className="block w-full border p-2" />
        <input name="area" placeholder="성수" className="block w-full border p-2" />
        <input name="hook" placeholder="왜 저장했나요?" className="block w-full border p-2" />
        <button type="submit" className="border px-4 py-2">추가</button>
      </form>
    </main>
  )
}
```

`src/app/groups/page.tsx`:

```tsx
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { groupMembers, groups } from '@/db/schema/groups'
import { currentUserId } from '@/auth/cookies'
import { newGroupAction } from '../actions'

export default async function Groups() {
  const userId = await currentUserId()
  if (!userId) return <main className="p-8">로그인이 필요해요.</main>

  const mine = await db
    .select({ id: groups.id, name: groups.name, role: groupMembers.role })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.userId, userId))

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl">그룹</h1>
      <ul className="mt-6 space-y-2">
        {mine.length === 0 && <li className="text-neutral-500">아직 없어요.</li>}
        {mine.map((g) => (
          <li key={g.id} className="border-b py-2">
            {g.name} <span className="text-neutral-500">({g.role})</span>
          </li>
        ))}
      </ul>
      <form action={newGroupAction} className="mt-10 space-y-2">
        <input name="name" placeholder="그룹 이름" required className="block w-full border p-2" />
        <button type="submit" className="border px-4 py-2">만들기</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 8: Run the whole suite and the build**

```bash
npm test
npm run build
```

Expected: all tests PASS (49 total), build succeeds.

- [ ] **Step 9: Verify by hand**

```bash
npm run dev
```

Then mint a link and open it:

```bash
node --experimental-strip-types -e "
import('./src/auth/magic-link.ts').then(async (m) => {
  console.log('http://localhost:3000/auth/' + await m.issueMagicLink({ igsid: 'IG_MANUAL' }))
  process.exit(0)
})"
```

Open the printed URL. Expected: redirected to `/`, an empty saved list, and the add-place form. Add a place; it appears. Visit `/groups`; create one; it appears with role `owner`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: web shell, magic-link route and manual place entry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Follow-ups (deliberately not in this slice)

- **Email collection UI for invite-joiners.** `?error=email_required` currently dead-ends. The service layer enforces the rule (Task 6) and the constraint backs it (Task 2); only the form is missing.
- **Real migrations.** Tasks use `drizzle-kit push`, which is right for a schema still moving. Switch to `drizzle-kit generate` + versioned migrations before the first deploy.
- **Rate limiting on `/auth/:token`.** The endpoint is an unauthenticated token oracle. Burning tokens on contact limits probing, but a limiter belongs here before real users. `security-engineer`, per spec §13.
- **`place_facts`, the pipeline, ingestion, personalization** — slices 2, 3 and 4.
