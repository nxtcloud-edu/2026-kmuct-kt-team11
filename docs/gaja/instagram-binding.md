# Instagram binding — what a handle is, and what it is not

**Date** 2026-09-20 · **Status** the rule, decided. The mechanism it describes is
not built; this document exists so that when it is built, it is built this way.

Two columns on `users` look like they say the same thing. They do not.

| Column | Written by | Means |
|---|---|---|
| `igsid` | a webhook payload Meta signed, and nothing else | **proof.** This Instagram account is this Gaja account. |
| `instagram_handle` | a text field the user typed | **a hint.** Somebody claims this is their Instagram account. |
| `instagram_linked_at` | the binding step below | when proof was obtained. NULL means the handle is still only a claim. |

`igsid` is the Instagram-Scoped User ID — what the Messaging API puts on the
webhook when a reel is shared to the Gaja account. It is the identity D3 rests on.
`instagram_handle` is `@koh_min_` typed into an onboarding field by a person who
may or may not be `@koh_min_`.

## The rule

**1. A handle claim routes nothing.** Not a DM, not a reel, not a notification. It
may narrow a lookup and it may be shown back to its owner so they can check their
own typing. That is the entire list.

**2. `igsid` is only ever written from a signed webhook payload.** No API route,
no form, no admin action writes it from user input. `PATCH /api/me` accepts
`instagram_handle` and deliberately does not touch `igsid` or
`instagram_linked_at`; the database backs that up with
`users_instagram_linked_requires_igsid`, so a timestamp without an igsid cannot
exist in the table at all.

**3. Binding needs both a payload and a session.** When a DM arrives from an igsid
nobody recognises, the sender's handle MAY be used to find a **candidate** account.
Finding one binds nothing. The binding is:

```
DM arrives, unknown igsid
  → (optional) handle on the payload matches users.instagram_handle → candidate
  → Gaja DMs back a one-time link
  → the person opens it WHILE SIGNED IN to Gaja
  → only then: users.igsid = <igsid from the payload>
               users.instagram_linked_at = now()
```

The signed-in session is what closes the loop. Meta's payload proves who sent the
DM; the session proves who owns the Gaja account; the link ties the two together
in one act by one person. A candidate match is a shortcut to *asking*, never a
substitute for the answer.

This is the same shape as `magic_links` with `intent = 'link'`, and it should
reuse that table rather than invent a second single-use-token mechanism.

**Why so careful.** This repo shipped the unverified-claim defect once already.
`users.email` was writable by anyone via `POST /auth/password` with no proof of
ownership, so one request could park a row on a stranger's address and wait for
them to walk into it. The repair is `claimUnverifiedRow()` in
`lib/social-identity.ts`, and the spec amendment of 2026-09-20 records it. A typed
handle that routed DMs would be that defect again with a worse payoff: the attacker
would not be waiting for a victim to arrive, they would be receiving the victim's
shared reels.

## Duplicate claims

The unique index `users_instagram_handle_lower_idx` **refuses** a second claim on
the same handle. The second claimant gets `409 instagram-handle-taken`.

The cost is real: the first person to type a handle holds it against the person who
actually owns it on Instagram. It is accepted because

- a held handle is worth nothing — it routes no DM, receives no reel, grants no
  access, and `igsid` is still unreachable from a text field; and
- the hold is not permanent by design. A claim with `instagram_linked_at is null`
  has proven nothing. When the real owner arrives with a verified igsid, **the
  unbound claim is cleared and theirs is written.** A bound row is the one that
  may not be taken.

**That eviction is not implemented.** It belongs with the webhook, along with
everything else on this page. The schema is shaped so it stays possible; nothing
today performs it.

The alternative — store duplicates and flag them — was rejected because it leaves
two accounts as candidates for one sender, and someone downstream then has to pick.
Silent resolution is precisely what this design forbids.

## An unrecognised sender: open

A reel arrives from an igsid bound to nobody. It **is not saved to anyone.** Not to
the best handle match, not to the most recent signup, not to anyone. That much is
settled by the rule above.

What happens to it instead is **a product decision that has not been made:**

- **Drop it.** Reply asking the sender to sign up and share again. Simple, honest,
  and it loses whatever they sent.
- **Hold it.** Park the payload keyed by igsid, and attach it if that igsid binds
  within some window. Nothing is lost, but Gaja is then storing media and captions
  from a person who has no account, which is a retention and a privacy question
  before it is an engineering one.

Whoever decides should also decide the window and what the DM reply says. Until
then, an ingestion implementation must pick one **explicitly and say so in the
code** — the failure mode is someone picking "hold" by accident because the insert
was easier to write than the delete.

## `igsid` is app-scoped

The "Scoped" in Instagram-Scoped User ID is load-bearing. The same person shares a
reel to two different Meta apps and each app sees a **different** igsid. It
identifies a person *to Gaja*; it is not a portable Instagram user id and cannot be
compared against one from anywhere else.

Consequences:

- Changing or re-creating the Meta app invalidates every stored `igsid`. Every user
  re-binds. Treat the app as part of the identity, not as configuration.
- A development app and a production app produce different igsids for the same
  tester. Do not copy `igsid` values between environments; they are meaningless
  there.
- `instagram_handle` is *not* app-scoped, which is exactly why it is tempting and
  exactly why it is not allowed to be the binding. It is stable and portable
  because it is public — and a public identifier that anyone can type is not a
  credential.

## Where this lives

- `supabase/migrations/20260920000006_instagram_handle.sql` — columns, CHECKs,
  unique index, and the duplicate-claim argument
- `app/api/me/route.ts` — `PATCH` accepts the handle, normalises it, touches
  neither `igsid` nor `instagram_linked_at`
- `lib/session.ts` — `toMe()` exposes `instagram_handle` and derives
  `instagram_linked` from `igsid`, never from the handle
- `lib/route.ts` / `lib/problem.ts` — the 409
- `app/(onboarding)/onboarding/steps.tsx` — the optional last step, whose copy
  promises only what this document allows
- `docs/gaja/reel-extraction-findings.md` — what a real shared reel contained
