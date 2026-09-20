# API contract — Gaja, slice 1 (Spine)

**Written by** `product-engineer` · 2026-09-18 · **Status** draft, unreviewed
**Upstream** `docs/superpowers/specs/2026-09-18-gaja-design.md` §3 (D3), §4, §5.1–5.2, §14
**Scope** Slice 1 only — identity, groups, places, hand-entered saved places.
No Instagram, no scraping, no pipeline.

## 0. Entered at step 7

Steps 1–6 of the `product-engineer` workflow were settled by the design spec and are **not**
re-derived here. The product-sense gate, constraint ledger, architecture options and data model
live in §3–§5 of the spec. This document is the missing HTTP contract and nothing else.

## 1. Consumer and the versioning promise

**Consumer: our own Next.js client, and only that.** Both the user web app and the admin console
are routes in the same deployment (spec §4, "Next.js on Vercel for both surfaces and all routes").
There is no third-party consumer, no SDK, no public surface.

**The promise, stated so it can be relied on:** *no version, no deprecation policy.* Breaking
changes are made by changing the route and its caller in the same commit. There is no `/v1/`
prefix, deliberately — a version segment is a promise to someone, and there is nobody to promise.

**Reversal condition:** the first consumer we do not deploy in the same commit — a mobile client,
a partner, an agent — makes this wrong. At that point freeze the surface, add `/v1/`, and write a
deprecation policy. Do not do it pre-emptively.

## 2. Conventions

| | |
|---|---|
| Base path | `/api` |
| Media type | `application/json`; errors `application/problem+json` |
| IDs | **UUIDv7** — time-sortable, keeps index locality, does not leak row counts. Type 1 decision; changing it later rewrites every foreign key and every URL. |
| Timestamps | RFC 3339, UTC, e.g. `2026-09-18T14:03:00Z` |
| Auth | Session cookie — `__Host-gaja_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, 30-day rolling |
| Unknown fields | Clients MUST tolerate unknown response fields and unknown enum values |
| Casing | `snake_case` in JSON, matching the data model, so no mapping layer is needed |

### Object-level authorization

Route-level auth is not sufficient and is the most-reported API flaw (OWASP API1:2023). **Every**
handler touching `saved_places`, `groups`, `group_members` or `group_invites` MUST verify the
caller's relationship to the specific object, not merely that a session exists:

- a `saved_places` row with `group_id = NULL` is readable and writable only by `user_id`
- a `saved_places` row with `group_id` set is readable by any member of that group, and writable
  only by the row's `user_id` or the group owner
- `groups`, `group_members`, `group_invites` require membership; role changes and deletion
  require `role = 'owner'`

Enforcement lives in `backend-engineer`'s work, not here. This contract states the rule so that
review has something to check against.

## 3. Errors

RFC 9457 (obsoletes RFC 7807). Media type `application/problem+json`.

```json
{
  "type": "https://gaja.app/errors/recovery-channel-required",
  "title": "Recovery channel required",
  "status": 409,
  "detail": "Removing this email would leave the account with no way to sign back in. Link Instagram first, or set a different email.",
  "instance": "/api/me/email",
  "request_id": "01JBQ7X2K9"
}
```

`type` URIs are stable and part of the contract. Clients branch on `type`, never on `detail`.

### Catalogue

| `type` (suffix of `https://gaja.app/errors/`) | Status | Raised when |
|---|---|---|
| `validation-error` | 422 | Body failed schema validation. Carries `errors[]` (see below). |
| `unauthenticated` | 401 | No session, or the session expired. |
| `forbidden` | 403 | Authenticated, but not permitted on this object. |
| `not-found` | 404 | Object does not exist, **or** exists and the caller may not know that. |
| `magic-link-invalid` | 400 | Token malformed, expired, or already used. Single-use (spec §10, auth row). |
| `magic-link-rate-limited` | 429 | Too many link requests for this email or IP. Carries `Retry-After`. |
| `recovery-channel-required` | 409 | The change would violate `CHECK (igsid IS NOT NULL OR email IS NOT NULL)` (D3). |
| `email-already-linked` | 409 | That email belongs to another account. |
| `idempotency-key-reuse` | 409 | Same `Idempotency-Key`, different request body. |
| `invite-invalid` | 400 | Invite token expired or already used. |
| `invite-already-member` | 409 | Caller is already a member of that group. |
| `not-group-member` | 403 | Caller is not a member of the target group. |
| `last-owner` | 409 | Would leave the group with no owner. |
| `duplicate-saved-place` | 409 | Violates `unique (user_id, reel_video_id)`. |
| `internal-error` | 500 | Unexpected. `detail` is generic; correlate via `request_id`. |

`detail` is actionable and never leaks internals — no stack traces, no SQL, no hostnames.
Every response carries `request_id`; that is the correlation handle.

Validation failures extend with a field array:

```json
{ "type": "https://gaja.app/errors/validation-error", "status": 422,
  "title": "Validation Error", "detail": "One or more fields are invalid.",
  "errors": [{ "field": "name", "message": "Must be 1–120 characters." }] }
```

## 4. Idempotency

`Idempotency-Key` is an **IETF draft, not a ratified RFC**. It is used here as a documented
convention, not a standards citation.

- **Header:** `Idempotency-Key: <client-generated UUIDv7>` — optional but recommended on every
  `POST` listed below; the client generates it once per user intent and reuses it across retries.
- **Storage:** key + request fingerprint (method, path, body hash) + the response, scoped to the
  session's `user_id`.
- **Retention:** **24 hours.**
- **Same key + same fingerprint** → replay the original response verbatim, with
  `Idempotency-Replayed: true`.
- **Same key + different fingerprint** → `409 idempotency-key-reuse`.

**Slice-1 routes that honour it:** `POST /api/saved-places`, `POST /api/places`,
`POST /api/groups`, `POST /api/groups/{group_id}/invites`, `POST /api/auth/magic-link`.

> **Scope note — the run order's "two idempotency keys" are not slice-1 routes.** Step 1's
> done-when names `mid` on ingest and the planning key. `mid` belongs to the Instagram webhook
> (slice 3) and the planning key to the orchestrator (slice 2); neither route exists yet.
> What this contract does instead is **establish the mechanism now**, so both later keys are the
> same mechanism rather than two bespoke ones:
> - **Slice 3, ingest:** dedupe is server-derived from Meta's `mid`, not client-supplied. It is
>   the same store, keyed `ig:mid:<mid>`, with a longer retention window than 24h because Meta
>   redelivers on timeout over a longer horizon. Decide the window when that route is designed.
> - **Slice 2, planning:** `POST /api/itineraries` takes a client `Idempotency-Key` exactly as
>   above. A double-submitted plan request must not run the pipeline twice — it is the most
>   expensive operation in the product.

## 5. Pagination

**Cursor, opaque, everywhere.** `saved_places` grows and changes under the reader (slice 3 will
insert rows asynchronously while a user is scrolling), which is precisely the case offset
pagination handles badly.

```
GET /api/saved-places?limit=30&cursor=eyJzIjoiMjAyNi0w...
```

- `limit` — default `30`, **maximum `100`**. Over the cap is clamped, not rejected.
- `cursor` — opaque. Clients MUST NOT parse it. Internally keyset on `(saved_at DESC, id DESC)`.
- Response envelope for every collection:

```json
{ "data": [ … ], "next_cursor": "eyJzIjoi…", "has_more": true }
```

`next_cursor` is `null` when `has_more` is `false`. Every collection endpoint is paginated from
this first version — adding pagination later is a breaking change.

## 6. Routes

### 6.1 Auth — the dual sign-in / link semantics (D3)

D3 makes `igsid` nullable and requires every account to hold at least one recovery channel. One
token type serves two outcomes, and **the outcome is decided by whether a session is present when
the token is exchanged**, not by the token itself:

```
POST /api/auth/session  with token
        │
        ├─ no session cookie  ──▶ SIGN IN   → session for the token's owner
        └─ session cookie     ──▶ LINK      → attach the token's channel to the
                                              signed-in account, then 409 if that
                                              channel already belongs elsewhere
```

---

**`POST /api/auth/magic-link`** — request a link. Never reveals whether the email exists.

```json
→ { "email": "minji@example.com", "intent": "sign_in" }     // sign_in | link
← 202 { "status": "sent" }
```

Always `202`, even for an unknown address — an endpoint that 404s on unknown emails is an account
enumeration oracle. Rate limited per email and per IP; `429 magic-link-rate-limited` with
`Retry-After`. `intent: "link"` requires a session and is rejected `401` without one.

**`POST /api/auth/session`** — exchange a token. Single-use, short expiry (spec §10).

```json
→ { "token": "mlt_01JBQ…" }
← 200 { "user": { … }, "outcome": "signed_in" }   // signed_in | linked
```

Sets `__Host-gaja_session`. Errors: `400 magic-link-invalid` (malformed, expired, or **already
used** — single-use is enforced, not advisory), `409 email-already-linked` when linking a channel
owned by another account.

**`DELETE /api/auth/session`** → `204`. Clears the cookie; the session is revoked server-side, not
merely forgotten by the client.

**`GET /api/me`**

```json
← 200 { "id": "01JBQ…", "display_name": "민지", "avatar_url": null,
        "email": "minji@example.com", "email_verified": true,
        "instagram_linked": true, "locale": "ko", "home_area": "성수",
        "profile_visible_in_groups": true, "plan": "free",
        "recovery_channels": ["instagram", "email"] }
```

`igsid` is **never** returned — it is an opaque third-party identifier and the client has no use
for it. `instagram_linked` is the boolean the UI actually needs. `recovery_channels` exists so the
client can render the D3 rule without inferring it from two nullable fields.

**`PATCH /api/me`** — `display_name`, `locale`, `home_area`, `profile_visible_in_groups` only.
Anything else is ignored, not rejected, so the client can send its whole model back.

**`DELETE /api/me/email`** → `204`, or **`409 recovery-channel-required`** if it is the last
channel. This is the `CHECK` constraint surfaced as a product rule rather than a database error:
the user gets a sentence telling them what to do, not a constraint-violation page.

### 6.2 Groups

| Route | Does | Notes |
|---|---|---|
| `POST /api/groups` | Create | Body `{ name }`. Creator becomes `owner`. Idempotent. |
| `GET /api/groups` | List the caller's groups | Paginated. Each carries `member_count` and `role`. |
| `GET /api/groups/{group_id}` | One group + members | `403 not-group-member` if not a member. |
| `PATCH /api/groups/{group_id}` | Rename | Owner only. |
| `DELETE /api/groups/{group_id}` | Delete | Owner only. Saved places revert to personal — `group_id` is set to `NULL`, rows are **not** deleted. |
| `POST /api/groups/{group_id}/invites` | Create an invite | Member may invite. Returns `{ token, url, expires_at }`. Idempotent. |
| `POST /api/invites/{token}/accept` | Join | See below. |
| `DELETE /api/groups/{group_id}/members/{user_id}` | Leave or remove | Self = leave; others = owner only. `409 last-owner` if it would orphan the group. |

**`POST /api/invites/{token}/accept`** is where D3's recovery rule bites, and it is the one flow
in slice 1 with real branching:

```
no session ──▶ 200 { "requires": "recovery_channel",
                     "group": { "id", "name", "member_count" } }
               The client then collects an email, calls magic-link with
               intent "sign_in", and retries accept with the session.

session    ──▶ 200 { "group": { … }, "role": "member" }
               409 invite-already-member · 400 invite-invalid
```

An invite joiner has no `igsid`, so an email is the only thing that can satisfy the `CHECK`
constraint. Asking for it **here** — at the one moment the user has a reason to care — is what
keeps "no signup form" true for everyone who arrives from Instagram. The group name is returned
in the unauthenticated branch deliberately: the user needs to know what they are joining before
handing over an address. Nothing else about the group is.

### 6.3 Places (hand-entered)

Slice 1 has no extractor, so places are created by hand. The dedupe problem (§5.1 — "the highest
bug-density area of the model") exists from the first hand-entered row, so search comes first.

**`GET /api/places/search?q=&near_lat=&near_lng=&limit=`** — search before create. Returns
existing `places` rows ranked by name similarity and, when coordinates are supplied, distance.

```json
← 200 { "data": [ { "id": "01JBQ…", "name": "어니언 성수",
                    "name_alt": ["Onion Seongsu"], "category": "cafe",
                    "area": "성수", "distance_m": 34 } ], "has_more": false }
```

**`POST /api/places`** — create. Body: `name`, `category`, `lat`, `lng`, `address?`, `area?`.

- `area` is resolved server-side from coordinates when omitted (§5.1 — resolved once, denormalized).
- **A create whose coordinates are within 50 m of an existing row with a similar name returns
  `200` with the existing place and `"matched": true`, not a new row.** This is the geocode-plus-
  fuzzy-name resolution from §5.1 applied at the write boundary. The client shows "이미 저장된
  곳이에요" rather than creating a duplicate.
- No merge action here — §5.1 requires one in the admin console, and it is an admin route, not a
  user one. Out of slice 1.

### 6.4 Saved places

**`GET /api/saved-places`**

| Query | |
|---|---|
| `group_id` | omit → personal only · a group id → that group's · `all` → both |
| `status` | `pending \| resolved \| needs_review \| rejected`, repeatable. Default: all but `rejected`. |
| `confirmed` | `true \| false`. `false` is the 확인 필요 filter. |
| `limit`, `cursor` | §5 |

```json
← 200 { "data": [ {
    "id": "01JBQ…", "place": { "id", "name", "category", "area", "lat", "lng" },
    "group_id": null, "status": "resolved", "confirmed": true,
    "hook": "티라미수가 미쳤다", "source_url": null,
    "saved_at": "2026-09-18T14:03:00Z" } ],
  "next_cursor": null, "has_more": false }
```

`place` is `null` while `status = "pending"` — the row exists before resolution by design (§5.2),
and in slice 1 a hand-entered place resolves immediately, so `pending` will not occur until
slice 3. The client must handle `null` from the start regardless; writing it in now costs nothing
and prevents a slice-3 client rewrite.

`extracted` and `raw_caption` are **not** returned — extractor internals, no client use.

**`POST /api/saved-places`** — save by hand. Idempotent.

```json
→ { "place_id": "01JBQ…", "group_id": null, "hook": "루프탑 뷰" }
← 201 { … the saved place … }
```

`reel_video_id` is `NULL` for hand-entered rows, so `unique (user_id, reel_video_id)` does not
constrain them — **Postgres treats `NULL`s as distinct in a unique index**, so a user may save the
same place by hand twice without a constraint error. That is a product question, not a database
one: this contract returns **`409 duplicate-saved-place`** when `(user_id, place_id, group_id)`
already exists and is not `rejected`, enforced in application code.

> **Open decision, flagged for `backend-engineer`:** if that rule should be a database guarantee
> rather than an application check, it needs a partial unique index
> `(user_id, place_id, coalesce(group_id, '...'))  WHERE status <> 'rejected'`. Application-level
> is enough for slice 1 with one writer; it is not enough once slice 3 writes concurrently.

**`PATCH /api/saved-places/{id}`** — `confirmed` (clears 확인 필요), `group_id` (move between
personal and a group — requires membership in the target), `hook`. Nothing else is mutable.

**`DELETE /api/saved-places/{id}`** → `204`. Hard delete in slice 1. Once `preference_signals`
exists (slice 4) this becomes a `rejected` status transition instead, because a deletion is itself
a preference signal — noted here so the change is expected rather than a surprise.

## 7. Rate limits

Part of the contract, not an implementation detail. `429` carries `Retry-After`.

| Route | Limit | Why |
|---|---|---|
| `POST /api/auth/magic-link` | 5 / hour per email, 20 / hour per IP | Email bombing and enumeration probing. |
| `POST /api/auth/session` | 10 / hour per IP | Token brute-force. |
| `POST /api/invites/{token}/accept` | 10 / hour per IP | Token guessing. |
| Everything else | none in slice 1 | Single trusted first-party client. `[unverified]` — revisit when real traffic exists. |

## 8. What this contract deliberately does not cover

- **The ingest webhook** (slice 3) — `mid` dedupe, signature verification, the <5s ACK.
- **The planning routes** (slice 2) — `POST /api/itineraries`, the streaming event feed, swap and
  re-plan. The streaming surface is an interface-style decision (SSE vs polling) that belongs with
  the pipeline, not here.
- **Admin console routes** — the review queue and the place-merge action. The merge action in
  particular needs the resolution rules from §5.1 designed properly; it is not a CRUD endpoint.
- **`place_facts`, `preference_signals`, `user_profile`** — slices 2 and 4.

## Assumptions

1. **Single first-party consumer.** Load-bearing — it is the entire justification for having no
   versioning. If a second consumer appears, §1 is wrong and must be revisited before shipping.
2. **Session cookie, not bearer tokens.** Both surfaces are same-origin Next.js routes, so a
   `__Host-` cookie is simpler and removes token storage from the client. Reversible (Type 2).
3. **UUIDv7 for all ids.** Type 1 — expensive to reverse. Chosen for time-sortability and index
   locality. The spec says `uuid` without specifying a version; this pins it.
4. **No load, latency or volume figures exist.** `[unverified]`. The `limit` cap of 100 and the
   rate-limit numbers are conventional defaults, not measured. Cheapest way to settle: run slice 1
   with real users for a week and read the p95 and the request mix.
5. **`area` is resolvable server-side from coordinates.** Assumed available from Kakao Local,
   which slice 2 adds. **If that adapter does not exist during slice 1, `area` must be a required
   client-supplied field instead** — a small change, but it changes `POST /api/places` from
   optional to required, so decide it before building.

## Open decisions

| # | Decision | Owner | Blocks |
|---|---|---|---|
| 1 | Duplicate hand-saves: application check or partial unique index? | `backend-engineer` | Not slice 1; blocks slice 3 concurrent writes |
| 2 | `area` server-resolved or client-supplied in slice 1? See assumption 5 | you | `POST /api/places`, now |
| 3 | Magic-link token lifetime — 15 min is the working default, unverified | you / `security-engineer` | Slice 1 auth build |
| 4 | Is `DELETE /api/groups` correct at all, or should groups be archivable? | you | `DELETE /api/groups`, low urgency |
| 5 | Streaming transport for slice 2 (SSE vs poll) | `product-engineer`, with `ai-interaction-designer` | Slice 2, not now |

## Decisions taken (were open #2 and #3)

Both were reversible, so defaults were taken rather than blocking:

- **#2 `area` — client-supplied and required on `POST /api/places`.** Someone hand-entering a
  café in 성수 knows it is 성수, and that route's callers have no address to derive it from.
  A geocoder now exists (`lib/research/geocode.ts`, Naver rather than the Kakao adapter the
  original note anticipated) and the reel path server-resolves `area` from it — but it does so
  by calling `findOrCreatePlace` directly, not through this route, so the request body is
  unchanged. Making the field optional here remains available and **loosening a required field
  is non-breaking**, so this direction is still safe and the reverse would not have been.
- **#3 magic-link lifetime — 15 minutes, single-use.** Conventional for a sign-in link.
  `[unverified]` against real delivery latency; if DM or email delivery proves slower than that,
  raise it rather than making links reusable.

Open decisions 1, 4 and 5 remain open and none of them block slice 1.

## Verification — both checks now pass

| Check | Result |
|---|---|
| **D2** contract lints clean | ✅ `npx @redocly/cli lint openapi.yaml` → **valid, 0 warnings** |
| **D3** mock exercised on the primary flow | ✅ `@stoplight/prism-cli mock` → 7/7 steps answered |

`docs/gaja/openapi.yaml` — 3.1.0, 21 operations, all with `operationId`.

**Four real defects the linter and mock caught**, none of which prose review would have:

1. `group_id`'s `oneOf: [{string, format: uuid}, {string, const: all}]` was **not mutually
   exclusive** — `format` is an annotation in JSON Schema, not a constraint, so both branches
   accept any string. Replaced with one string schema and a pattern.
2. 21 operations had no `operationId`. Client generators derive method names from it; without
   them a generated client has names like `postApiSavedPlaces1`.
3. No `license` on `info`. Set to `UNLICENSED` — internal, not published.
4. Five tags had no description.

**What the mock confirmed:** the security scheme is enforced (`GET /me` without the session
cookie returns the `unauthenticated` problem body, not an empty 401), the pagination envelope
serialises as specified, `POST /places` returns the `matched: true` dedupe branch, and the
RFC 9457 shape round-trips.

**What a mock cannot confirm, and what is therefore still unproven:** every rule in §2's
object-level authorization, the idempotency replay behaviour, the `CHECK`-constraint 409, and the
duplicate-save rule. Prism serves examples — it does not run logic. Those are `backend-engineer`'s
to implement and to test.

## Next

Step 1 of the run order is complete. `docs/gaja/api-contract.md` and `docs/gaja/openapi.yaml`
both exist; slice 1 is ready to build against them.
