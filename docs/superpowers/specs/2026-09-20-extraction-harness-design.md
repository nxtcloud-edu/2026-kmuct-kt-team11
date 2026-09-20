# Gaja — extraction harness design

**Status:** design · 2026-09-20
**Scope:** a development-only harness that turns an Instagram reel URL into a labelled
extraction eval row. Feeds run-order step 3 (`ai-engineer`) and de-risks build slice 3.
**Parent spec:** `docs/superpowers/specs/2026-09-18-gaja-design.md` — §6 (ingestion),
§11 (testing), §12 (external assumptions). Decisions there are inherited, not re-litigated.

## 1. Problem

Slice 3 builds the extraction ladder (§6.2): caption → vision → ASR → human. Two things
block it, and neither needs Instagram's webhook to be solved.

First, the ladder's confidence-band boundaries are explicitly **not** fixed in the parent
spec — §6.2 says they are "tuned against the extraction eval set," and that eval set does
not exist. Second, §12 flags §6.1's central claim as unverified: that a shared reel carries
no location tag or caption, so the place name exists only as text burned into the video,
making extraction a vision problem. The entire ladder order rests on that claim.

Both are measurement problems. This harness is the measuring instrument: given a reel URL,
run every rung independently and record what each produced, what it cost, and how long it
took — one JSON row per reel, with a slot for hand-entered ground truth.

**In one line:** the tool that tells us whether the ladder in §6.2 is in the right order.

## 2. What this is not

**Not a user-facing ingest path.** Production ingest is a DM `ig_reel` attachment carrying a
Meta CDN URL (§6.1). This harness resolves a pasted URL with `yt-dlp`, which is a developer
convenience with ToS exposure and datacenter-IP fragility. It is never deployed. D3 — IG
identity, no signup form — is untouched.

**Not a transcription product.** The transcript is one rung's output among three, recorded
so it can be compared against the other two. A transcript alone cannot answer whether ASR
was needed, because it never shows what caption or vision would have produced.

**Not place resolution.** The harness stops at `PlaceCandidate`. Resolving a candidate to a
canonical `place` + `place_ref` needs the Kakao/Naver adapters, which are slice-2 work.

## 3. Settled decisions

| # | Decision | Why |
|---|---|---|
| H1 | **Library + thin CLI**, not a script and not a route | The ladder survives into slice 3; the entry point does not. Writing the logic once means the corpus stays valid, because production runs the same code that produced it. |
| H2 | **`MediaSource` is the only code that knows `yt-dlp` exists** | Mirrors `PlaceSource` in §4. Production swaps `YtDlpSource` for `IgAttachmentSource` and the ladder does not change. Quarantines the ToS-exposed, rot-prone part behind one interface. |
| H3 | **Two modes: `--all-rungs` and `--ladder`** | The first says where the boundaries should sit; the second tests the policy derived from it. With only the first, we tune boundaries we never exercise. |
| H4 | **Confidence boundaries live in a table, not in code** | Same reasoning as dwell defaults in §8.1. They are tuning data and will change often; a code change per tuning round is friction that stops tuning happening. |
| H5 | **Every row is written, including total failures** | If blocked, private or deleted reels vanish from the corpus, boundaries get tuned on survivors only. That selection bias makes production look better than it is — the silent degradation D10 exists to prevent. |
| H6 | **Never deployed; enforced by a test** | A guard asserts nothing under `app/` imports `media/yt-dlp`. Convention is not enough when the failure mode is shipping a ToS liability. |
| H7 | **Scraped reel media is never committed** | It is third-party copyrighted video. Media lives in a gitignored local cache keyed by reel id; only expected outputs are committed. Unit-test fixtures use a clip we own. |
| H8 | **Model vendors are swappable via AI Gateway** | Korean ASR and Korean burned-in-text vision quality are bets, not knowns. Vendor choice must be an eval variable, not a hardcoded commitment. |

## 4. Architecture

```
lib/extraction/
  types.ts          Media · RungResult · PlaceCandidate · Confidence · EvalRow
  media/
    index.ts        MediaSource interface
    yt-dlp.ts       YtDlpSource         ← dev only, never imported by app/
  rungs/
    caption.ts      rung 1 · title/caption text → keywords
    frames.ts       8 frames evenly sampled, dHash-deduped
    vision.ts       rung 2 · frames → PlaceCandidate
    asr.ts          rung 3 · audio → transcript
  confidence.ts     band boundaries (data)
  ladder.ts         sequencing + short-circuit policy
scripts/
  extract-eval.ts   CLI — the only caller
docs/gaja/evals/extraction/
  <reel_id>.json    one row per reel
```

**Boundaries**

- **Each rung is a pure function over a local file.** No rung imports another. A rung takes
  bytes plus config and returns a typed result; it does not decide whether it should have run.
- **`ladder.ts` owns sequencing alone.** Short-circuit policy lives here and nowhere else,
  so changing the policy is a one-file change.
- **`confidence.ts` owns boundaries as exported data.** Tuning is editing a table.
- **`MediaSource` returns a local path, not a stream or a URL.** Rungs never perform network
  I/O for media. This is what makes them testable offline and what makes the dev/production
  media difference invisible above the interface.

```ts
interface MediaSource {
  resolve(ref: string): Promise<Media>;   // ref = URL (dev) | CDN URL (slice 3)
}

interface Media {
  reelId: string;
  videoPath: string;        // local, in the cache
  captionText: string | null;
  durationS: number | null;
  width: number; height: number;
  hasAudio: boolean;
}
```

## 5. Modes

| mode | behaviour | purpose |
|---|---|---|
| `--all-rungs` (default) | every rung runs unconditionally; all outputs recorded | build the corpus |
| `--ladder` | short-circuits at the first rung clearing its band, exactly as production will | verify the derived policy |

`--ladder` records which rung decided (`decided_by`) and which were skipped, so a corpus run
and a policy run are directly comparable on the same reel.

## 6. Data flow

In `--all-rungs` the three rungs have no data dependency on one another, so they run in
parallel. This is both faster and necessary for a clean per-rung comparison: sequential
execution would let an early rung's result bias how a later one is invoked.

```
url → YtDlpSource → Media { videoPath, captionText, meta }
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
    caption            frames→vision        audio→ASR
        └───────────────────┼───────────────────┘
                            ▼
                  derive candidate + band
                            ▼
              docs/gaja/evals/extraction/<reel_id>.json
```

`frames.ts` samples 8 frames evenly across the duration and drops near-duplicates by
difference hash (dHash, implemented inline — a 20-line function does not justify a
dependency). Reels frequently hold a static title card for seconds; deduping keeps the
vision call from paying for eight copies of the same frame.

## 7. The eval row

```jsonc
{
  "reel_id": "DdRyQxKteC1",
  "source_url": "https://www.instagram.com/…",
  "fetched_at": "2026-09-20T11:42:00Z",
  "harness_version": "1",
  "media": { "duration_s": 58, "res": "892x1584", "has_audio": true },

  "rungs": {
    "caption": { "ok": true, "text": "…", "keywords": [],  "ms": 2,    "cost_usd": 0      },
    "vision":  { "ok": true, "frames_used": 6, "candidate": {}, "ms": 4120, "cost_usd": 0.0031 },
    "asr":     { "ok": true, "transcript": "…", "language": "ko", "ms": 8300, "cost_usd": 0.0006 }
  },

  "derived": { "candidate": {}, "confidence": "medium", "decided_by": "vision" },

  "ground_truth": null
  // once labelled:
  // { "place_name": "…", "place_id": null, "note": "…" }
  //   place_id stays null until slice 2 can resolve; see §7.1
}
```

Three fields carry the weight:

- **`ground_truth: null`** — filled by hand. This is what makes the file an eval row rather
  than a log line. Nothing automated writes it.
- **`decided_by`** — which rung produced the surviving candidate. Aggregated across the
  corpus, this is the answer to "is the ladder in the right order."
- **per-rung `cost_usd` and `ms`** — the answer to whether rung 3's `+cost` earns its place.
  If vision already resolves Korean reels at high confidence, ASR may belong lower or be cut.

Confidence bands are inherited unchanged from §6.4 — `high` / `medium` / `low` / `none`.
The harness assigns them; it does not redefine them.

### 7.1 Relationship to §11's extraction metric

§11 defines the extraction eval set as "~30 real reels, known answers," scored by **exact
match on resolved `place_id`**. This harness cannot compute that metric, because resolution
needs the Kakao/Naver adapters and those are slice 2.

That is a sequencing gap, not a conflict. The harness produces the **corpus**; §11's metric
is computed **over** the corpus once resolution exists. To keep the two compatible:

- `ground_truth` records the place a human identifies, by name, with `place_id` left null.
- When slice 2 lands, a separate scoring pass resolves both `derived.candidate` and
  `ground_truth.place_name`, fills the ids, and computes exact match. No re-collection is
  needed — the reels, frames, transcripts and candidates are already recorded.
- Target corpus size is therefore **~30 reels**, matching §11, not an arbitrary number.

Until then the harness answers the questions in §12 of this document, which are about ladder
order and cost. Those are answerable from `decided_by`, per-rung cost and hand-read
candidates alone, and they are the questions blocking slice 3.

## 8. Error handling

Following §6.3's "every branch ends in a usable outcome" and D10's degrade-loudly rule.

- **A failed rung is not a failed run.** Each rung is independently caught. A vision timeout
  still leaves `caption` and `asr` recorded, with `vision: { ok: false, error: "timeout" }`.
- **No audio track** → `asr: { ok: true, skipped: "no_audio" }`. A result, not an error.
- **Media resolution failure** (blocked, private, deleted, extractor broken) → a row is still
  written, carrying `media: null` and the failure reason. Per H5 these rows are the most
  important ones in the corpus: they are the production failure distribution.
- **Distinguish blocked from broken.** A 401/429 from a datacenter IP and a changed extractor
  shape are different problems with different fixes; the row records which. This mirrors
  §7.5's contract-test reasoning — a circuit breaker catches blocking but not a changed shape.
- **Cost ceiling.** The CLI takes `--max-cost-usd` and stops before exceeding it. A typo in a
  loop over a URL file should not become a surprise bill.

## 9. Testing

- **Rungs unit-test offline** against a committed fixture clip we own, with `MediaSource`
  mocked. No network, no Instagram.
- **Ladder sequencing tests** use stubbed rung results to assert short-circuit behaviour and
  band assignment across the boundary table — no models invoked.
- **`cost_usd` and `ms` are never asserted.** They are observations, not contracts.
- **Guard test (H6):** a test walks `app/` and fails if anything imports `media/yt-dlp`.
- Per H7, no scraped reel media enters the repository.

## 10. Prerequisites

| kind | item | note |
|---|---|---|
| system | `yt-dlp` | documented, not an npm dep; breaks often, must be updatable independently |
| system | `ffmpeg` | frame sampling and audio extraction |
| env | `AI_GATEWAY_API_KEY` | added to `.env.example`; vision + ASR both route through it |
| npm | none new | dHash inline; `zod` already present for row validation |

`yt-dlp` and `ffmpeg` are deliberately system prerequisites. Pinning a scraper as a build
dependency guarantees a stale extractor at the moment one is needed.

## 11. Out of scope

- **Database writes.** The harness reads nothing from and writes nothing to Postgres.
- **Place resolution.** Stops at `PlaceCandidate`; Kakao/Naver adapters are slice 2.
- **The queue, worker and DM replies.** Slice 3 proper.
- **Proxies and IP rotation.** The harness runs from a developer machine. If it is ever
  pointed at a datacenter IP the failure will be loud and the row will record it (§8).
- **Production deployment of any kind.**

## 12. What this is expected to settle

Listed as open questions, to be answered by the first corpus run rather than assumed here.

1. **Is §6.1 true?** Does a shared reel really arrive with no usable caption, leaving the
   place name only as burned-in video text? The first reels of the ~30 should be chosen to test
   this specifically, before any boundary tuning. If it is false, rung 1 is far cheaper than
   the ladder assumes and the order changes.
2. **Where do the band boundaries sit** for `high` / `medium` / `low` / `none`?
3. **Does rung 3 earn its cost** on Korean reels, given rung 2's result on the same input?
4. **Which vendors** for Korean vision and Korean ASR, measured rather than assumed (H8).

A result that contradicts §6.2's ladder order is a success for this harness, not a failure.

## 13. Build decomposition

Three steps, each independently useful.

**Step 1 — media + caption.** `types.ts`, `MediaSource`, `YtDlpSource`, `caption.ts`, the
cache, the row writer, and the CLI skeleton. Ends with: a URL produces a row containing real
media metadata and rung 1. No models, no cost. Verifies the riskiest external dependency
first.

**Step 2 — vision.** `frames.ts` with dHash, `vision.ts` through AI Gateway, `confidence.ts`,
`ladder.ts` in `--all-rungs` mode. Ends with: rows carrying a real `PlaceCandidate`. This is
the step that answers open question 1.

**Step 3 — ASR and `--ladder` mode.** `asr.ts`, short-circuit policy, the guard test, the
cost ceiling. Ends with: both modes working and the corpus comparable across all three rungs.

