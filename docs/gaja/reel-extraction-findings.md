# Reel extraction — what one real DM actually contained

**Date** 2026-09-20 · **Status** observed, not inferred
**Method** a reel shared to a logged-in Instagram account, read back through
`GET /api/v1/direct_v2/inbox/` with the session's own cookies.

This contradicts an assumption the extraction work was about to be built on. It is
one sample, which is the main thing to hold against it — but it is a real one, and
it points the opposite way from the design.

## The headline

**The places are in the caption, not the video.** The caption of a single shared
reel carried ten venues, each with a name, a full street address, opening hours, a
menu with prices, and the venue's own Instagram handle.

Nobody had to look at a frame.

## What arrived

Shared by a user, authored by `@koh_min_`, shortcode `DZrAQQMPiAt`.

| Field | Value |
|---|---|
| `item_type` | `clip` |
| `product_type` | `clips` |
| `video_duration` | 20.4s |
| `caption.text` length | **1,226 characters** |
| `location` | **null** |
| `video_versions` | present |

The on-screen text — *여름 날에 다녀오기 좋은 싱그러운 카페 10곳* — is the **title only**.
Reading it would tell you the reel is about ten cafés and nothing about which ten.

## The caption grammar

Counted across the sample: **10 numbered entries, 10 📍, 10 🕰️, 10 📓.** The format
does not drift between the first entry and the tenth.

```
2.📍우이그 (UIG) @uig.official
  서울 마포구 망원로3길 7
🕰️매일 11:00-22:30 금,토 11:00-23:00
📓티그레 (4,200) 아메리카노 (4,800)
```

Read as a grammar:

| Marker | Carries | Maps to |
|---|---|---|
| `N.` | ordinal within the reel | ordering, and the count to expect |
| `📍` | venue name, sometimes with a romanised alias | `places.name`, `places.name_alt` |
| `@handle` | the venue's own account | a second identity anchor |
| *(unmarked line)* | full street address | `places.address` → geocode → `lat`/`lng`/`area` |
| `🕰️` | opening hours, with weekday/weekend variants | the `영업 종료` check |
| `📓` | menu items and prices | not modelled today |

The tail is creator self-promotion plus hashtags, and contains a stray `@handle`
and address-shaped text — so an 11th handle and 13 address matches came back from a
naive regex against ten venues. **Parse to the numbered entries, not to the markers.**

## What this changes

**The ladder inverts.** The design treats caption text as thin and expects to work
for the answer. Here the caption *is* the answer, and everything else is fallback:

1. **Caption parse** — cheap, and on this sample complete
2. Video frames / OCR — for reels whose caption is just a vibe
3. Place-source lookup — to verify and enrich, not to discover

**Address beats name matching.** Spec §7 plans a fusion step to reconcile fuzzy
venue names across Kakao, Naver and Google. `서울 광진구 아차산로78길 110` geocodes
directly. Where an address is present, most of that problem does not arise.

**Hours arrive before any scraper does.** `매일 11:30-01:00` is in the caption. The
planner's central promise — that a stop is actually open — has a source that does
not depend on the Naver scrape, which §12 flags as the project's most fragile
surface. Caption hours are a claim by a creator, not ground truth, so treat them as
a prior to verify rather than a fact; but "unverified hours" beats "no hours".

**One reel is ten saved places.** This is the schema problem. `saved_places` holds
one `place_id` per row and has a partial unique index on `(user_id, reel_video_id)`
— a listicle produces N rows from one reel and that index forbids it. Either the
index widens to include `place_id`, or a reel gets a parent row with children.
**Decide before the extractor writes anything.**

## What it does not solve

- **One sample.** A listicle from an account that formats carefully. Single-venue
  reels, and creators who write a paragraph instead of a list, are unmeasured.
- **No geotag.** `location` was null, so the address string is the only location
  source. Do not build on `media.location`.
- **Address formats differ.** The same venue appeared in an earlier reference as
  `서울 용산구 후암동 2-1` (jibun) and here as `서울 용산구 후암로40길 3` (도로명).
  Geocoding has to accept both.
- **Emoji are the delimiters.** Robust in this sample, absent the moment a creator
  uses a dash. The parser needs a fallback that reads the numbering alone.
- **Menu prices are captured and unmodelled.** No column wants them today.

## Pipeline facts worth keeping

- A share from someone who does not follow the account lands in **Message requests**,
  not the inbox. It is visible in the UI but the thread **500s over the API** until
  accepted. Any browser-based ingestion needs an accept stage; the Messaging API does
  not, because a business account receiving a share has no request gate.
- `/api/v1/direct_v2/inbox/` returns the thread items including the full caption.
  `/api/v1/direct_v2/pending_inbox/` 404s on the web host, and
  `/api/v1/direct_v2/threads/{id}/` 500s.
- None of the above is a supported interface. It is what a logged-in browser can
  reach, which makes it fine for learning what the data looks like and a poor
  foundation to ship on. The Messaging API delivers the same `attachments` payload
  by webhook, without the polling or the ban risk.

## What to do next

1. **Settle the one-reel-many-places schema question.** It blocks the extractor.
2. **Gather ten more captions** across single-venue reels, paragraph captions and
   other creators, before hard-coding this grammar. One sample is a hypothesis.
3. **Write the caption parser as rung one** of the ladder, with OCR demoted to the
   fallback it now looks like.
4. **Point ingestion at the Messaging API**, using this payload shape as the fixture.
