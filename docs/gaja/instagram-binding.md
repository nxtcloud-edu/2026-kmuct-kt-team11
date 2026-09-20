# Instagram binding — what a handle is, and what it is not

**Date** 2026-09-20 · **Status** amended the same day it was written. The rule
below was decided first and the mechanism was built second, and building it
changed the rule. Both versions are here, because the reasoning behind the
stricter one is still the reasoning that should win the day a webhook exists.

Two columns on `users` look like they say the same thing. They do not.

| Column | Written by | Means |
|---|---|---|
| `igsid` | **today:** `resolveSenderToUser`, from a DM whose sender's handle matches a unique claim · **when the webhook lands:** a payload Meta signed | this Instagram account's shares belong to this Gaja account. |
| `instagram_handle` | a text field the user typed | **a claim.** Somebody says this is their Instagram account. |
| `instagram_linked_at` | the ceremony below, which is **not built** | when proof was obtained. NULL means the binding is a handle match, not a confirmation. |

`igsid` is the Instagram-Scoped User ID — what the Messaging API puts on the
webhook when a reel is shared to the Gaja account. It is the identity D3 rests
on. `instagram_handle` is `@koh_min_` typed into an onboarding field by a person
who may or may not be `@koh_min_`.

---

## What is actually built, as of 2026-09-20

**A DM from an unknown sender is bound to the Gaja account that claims the
sender's handle, automatically, on the first reel.** `resolveSenderToUser`
(`lib/ingest/route-sender.ts`):

```
reel arrives from pk 47258226293, @amis9n
  → users.igsid = '47258226293'?            → yes: it is that user's reel. Done.
  → lower(users.instagram_handle) = 'amis9n'
      AND that user has no igsid yet
      AND no other user holds this igsid     → set users.igsid, one statement.
  → no match                                 → dropped, counted, and logged by handle.
```

### Why the original rule had to give

The rule below says a handle claim routes nothing and `igsid` comes only from a
signed webhook. That was correct and the system built on it did not work, for a
reason the first draft did not anticipate:

**nothing in this codebase ever wrote `users.igsid`.** There is no Meta webhook
route. Every other reference to the column is a read. So the only `igsid` in the
table was one inserted by hand, exactly one person's reels were ingested, and
every other sender's reel was dropped and counted — behaving exactly as designed
and useless in production.

### What the handle route proves, and what it does not

It is weaker than a signed webhook and stronger than a typed string, and the
difference matters in both directions:

1. **The sender's handle is not typed by the sender.** It is
   `thread.users[].username`, read off an authenticated request to our own inbox.
   It is Instagram's answer to "whose account sent this". To get a handle in
   there you must control that Instagram account.
2. **`users.instagram_handle` is typed**, by a signed-in Gaja user via
   `PATCH /api/me`. That is a claim, and it is the weak link.
3. **`users_instagram_handle_lower_idx` is unique**, so at most one Gaja account
   can be claiming any handle. There is never a choice between two candidates,
   which is the silent resolution this design was written to forbid.

What is missing versus the ceremony: the one-time link, where the owner of the
**Gaja** account confirms the binding at the moment it is made.

### What that costs, plainly

**A squatter who types someone else's handle first will receive that person's
shared reels**, and the victim cannot even claim their own handle — they get
`409 instagram-handle-taken`. Under the original design a squatter won nothing,
because a held handle routed nothing. Here it routes reels.

This is a real, accepted regression in the security posture. It was taken
deliberately, to make ingestion work for somebody other than one hand-bound
account. Three things bound it:

- one claimant per handle, enforced at the index;
- the bind refuses to overwrite an existing `igsid`, so a stronger binding can
  never be downgraded by a later claim;
- **`instagram_linked_at` is left NULL** by this path. A handle-bound row stays
  in the tier that `20260920000006_instagram_handle.sql` calls disposable — the
  one a genuine, webhook-proven binding is allowed to evict.

### The race, and why it is one statement

Two reels from the same new sender can arrive in one pass, and two passes can
overlap. A `select` followed by an `update` lets both callers see `igsid is null`
and both write. So the bind is a single `UPDATE ... WHERE` with every condition
in the `where` clause; the second statement matches nothing, and its caller
re-reads and finds the binding the first one made. `users.igsid` is also
`unique`, so the index is the backstop if the clause is ever weakened.

---

## The rule (the design that still applies to the webhook)

**1. A handle claim routes nothing.** — **AMENDED.** Today it routes exactly one
thing: a DM whose sender Instagram itself identifies by that handle. It still
grants no access, authenticates no session, and is not accepted from any other
source. When the webhook lands, this clause returns in full and the handle route
becomes the fallback it was meant to be, or is removed.

**2. `igsid` is only ever written from a signed webhook payload.** — **AMENDED.**
It is written from a signed webhook payload *or* from the poller's handle match
above. It is still never written from user input: no API route, no form, no admin
action. `PATCH /api/me` accepts `instagram_handle` and deliberately does not touch
`igsid` or `instagram_linked_at`; the database backs that up with
`users_instagram_linked_requires_igsid`, so a timestamp without an igsid cannot
exist in the table at all.

**3. Binding needs both a payload and a session.** — **NOT BUILT, and still the
target.** When the Messaging API arrives, the binding should be:

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
`lib/social-identity.ts`, and the spec amendment of 2026-09-20 records it. The
handle route above is a lesser version of that defect, knowingly taken: the
attacker must still wait for a victim to arrive, and what they receive is reels
rather than an account.

## Duplicate claims

The unique index `users_instagram_handle_lower_idx` **refuses** a second claim on
the same handle. The second claimant gets `409 instagram-handle-taken`.

The cost is real, and it is now larger than when this was written: the first
person to type a handle holds it against the person who actually owns it on
Instagram, **and receives their shared reels**. It is accepted because

- the hold is not permanent by design. A claim with `instagram_linked_at is null`
  has not been through the ceremony — including one the poller bound by handle.
  When the real owner arrives with a webhook-verified igsid, **the unbound row is
  cleared and theirs is written.** A ceremony-bound row is the one that may not
  be taken; and
- the alternative — store duplicates and flag them — leaves two accounts as
  candidates for one sender, and someone downstream then has to pick.

**That eviction is not implemented.** It belongs with the webhook, along with
everything else on this page. The schema is shaped so it stays possible; nothing
today performs it.

## An unrecognised sender: decided

A reel arrives from an igsid bound to nobody, whose handle no Gaja account
claims. It **is not saved to anyone.** Not to the best fuzzy match, not to the
most recent signup, not to anyone.

The choice this page left open — drop it or hold it — **is decided: DROP.**
Holding the payload means storing captions and media from a person with no Gaja
account and no way to ask them about it, which is a retention and privacy
question nobody has answered. `resolveSenderToUser` returns null and there is no
branch in that module that writes anything, so a caller cannot accidentally save
an unrouted reel.

**The drop is loud.** `runIngestPass` logs the handle it could not place and
counts it in `dropped_unknown_sender`; the pass summary carries the count and the
log line carries the `@name`. A counter alone said "somebody was dropped" without
saying who, and "who" is the entire actionable content: that person needs to type
their handle into their account screen, after which their next share binds
itself.

**No DM reply is sent.** The poller reads; it does not write messages. Whether
Gaja should answer an unknown sender, and what it would say, is still open.

## Message requests

A reel from somebody who does **not follow** the Gaja account does not land in
the inbox at all — it lands in **Requests**, which is where every new user's
first share lands by definition. `lib/ingest/inbox/instagram-poll.ts` probes for
that folder on both hosts and accepts the threads that carry reels.

**As measured on 2026-09-20 with the production session, neither host serves it:**
`www.instagram.com` returns a 404 HTML page on every path and header variant
tried, and `i.instagram.com` returns
`{"status":"fail","content":{"status":"Prompt has contribution","error_code":4415001}}`
— the same 400 it returns for `/inbox/`, which works fine on `www`, so that host
is rejecting a web session outright rather than rejecting the endpoint.

This is reported, never swallowed: the pass summary carries
`pending_inbox.read = 'unreachable'` with the reason, and
`pending_inbox.requests_total` — Instagram's own badge count, read off the
ordinary inbox response — says whether anything is actually waiting behind it.
Until a host answers, **a message request must be accepted by hand in the
Instagram app**, after which the thread moves to the inbox and the handle route
above binds the sender on their next share.

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
- **The poller does not write igsids at all, strictly speaking.** It writes the
  sender's raw numeric pk into the same column, and a pk is a different id space
  from an IGSID — see the field note on `InboxClip.igsid`. The day the webhook
  lands, every row bound by the poller holds a value the webhook will not match,
  and those rows re-bind. That is survivable precisely because they are the
  `instagram_linked_at is null` rows the eviction path is allowed to clear.
- `instagram_handle` is *not* app-scoped, which is exactly why it is tempting and
  exactly why it was not allowed to be the binding. It is stable and portable
  because it is public — and a public identifier that anyone can type is not a
  credential. It is now the binding anyway, with the cost written above.

## Where this lives

- `supabase/migrations/20260920000006_instagram_handle.sql` — columns, CHECKs,
  unique index, and the duplicate-claim argument
- `lib/ingest/route-sender.ts` — the handle route, the guarded single-statement
  bind, and the drop
- `lib/ingest/inbox/parse.ts` — where the sender's handle comes from
  (`thread.users[].username`), lowercased
- `lib/ingest/inbox/instagram-poll.ts` — the message-request folder: the probe,
  the approve, and what each host answered
- `app/api/me/route.ts` — `PATCH` accepts the handle, normalises it, touches
  neither `igsid` nor `instagram_linked_at`
- `lib/session.ts` — `toMe()` exposes `instagram_handle` and derives
  `instagram_linked` from `igsid`, never from the handle
- `lib/route.ts` / `lib/problem.ts` — the 409
- `app/(onboarding)/onboarding/steps.tsx` — the optional last step, whose copy
  promises only what this document allows
- `docs/gaja/reel-extraction-findings.md` — what a real shared reel contained
