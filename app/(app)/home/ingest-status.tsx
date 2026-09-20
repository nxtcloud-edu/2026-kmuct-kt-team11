'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/surface';
import type { IngestStatus } from '@/lib/ingest/status';

/**
 * The one place on the home screen that says a shared reel was received.
 *
 * WHAT IT PROMISES, AND WHAT IT REFUSES TO PROMISE. The reel WAS received —
 * `claimReel` wrote a row before any analysis started — and it IS being
 * analysed. Both of those are facts this component reads out of `reels.status`.
 * What it does not do is show a progress bar, because nothing here knows how
 * long the work will take: rung one of the extraction ladder is a 1 KB text call
 * and rung two is a 4 MB video download plus a model call, and the geocoding
 * afterwards is one sequential HTTPS round trip per venue. A bar that filled at
 * an invented rate would be a lie told smoothly, and the honest version of the
 * Doherty Threshold here is not a fake estimate — it is to acknowledge the work
 * immediately and say truthfully what stage it is at.
 *
 * WHY IT IS FAST ANYWAY. The initial value is rendered on the server, so the
 * card is correct in the first paint of the page rather than appearing a poll
 * later. Polling only covers the transition while somebody is watching.
 *
 * IT RENDERS NOTHING WHEN THERE IS NOTHING. No empty state, no "no reels yet",
 * no permanent widget waiting to be filled — that is the adopted system's
 * content rule ("If there is no data behind a line, delete the line") and it is
 * what keeps this from becoming furniture. The `role="status"` wrapper stays in
 * the document while empty, which is not a visual exception: it has no box, no
 * spacing and no text. It is there because a live region has to exist BEFORE its
 * content changes for a screen reader to announce the change, and announcing the
 * change is the entire point.
 *
 * NO FOURTH SHADOW. `.agents/visual-language.md` spends the depth budget on
 * three — the canvas, the tab bar, the agent sheet — and this is a `Card`, which
 * is a tinted surface with no border and no shadow. Nothing here is elevated and
 * nothing here is saturated: there is no accent colour in this system, so the
 * dot is `--ink` and the hierarchy is size and the secondary text tier.
 */

/** While something is in flight. Short, because a transition is being watched for. */
const ACTIVE_POLL_MS = 3_000;

/**
 * While nothing is. Longer, because this is only waiting for an arrival, and the
 * arrival is not something the user is sitting and waiting on — they shared a
 * reel in another app. A status chip does not get to cost a request a second.
 */
const IDLE_POLL_MS = 8_000;

type View = { title: string; body: string; working: boolean };

/**
 * The status, as a sentence. PURE, and called during render — there is no
 * effect anywhere in this file that writes state in order to repair state it
 * just read.
 *
 * Null is the common answer and the important one: it is what makes this
 * component disappear rather than degrade into an empty box.
 */
function describe(status: IngestStatus): View | null {
  if (status.analysing > 0) {
    return {
      working: true,
      title: `릴스 ${status.analysing}개 분석 중`,
      // Two facts, in the order they happened. "받았어요" is the acknowledgement
      // the user is actually waiting for; "찾고 있어요" is what is happening now.
      body: '인스타그램에서 받았어요. 장소를 찾고 있어요.',
    };
  }

  if (status.landed === 0) return null;

  if (status.places > 0) {
    return {
      working: false,
      title: `릴스에서 ${status.places}곳을 찾았어요`,
      body:
        status.needs_review > 0
          ? '저장한 곳에 담아뒀어요. 일부는 확인이 필요해요.'
          : '저장한 곳에 담아뒀어요.',
    };
  }

  if (status.needs_review > 0) {
    return {
      working: false,
      title: `릴스 ${status.needs_review}개를 확인해 주세요`,
      // Says WHY, because the user can act on this one: the places live in the
      // caption, and a reel whose caption is prose has nothing to extract.
      body: '캡션에서 장소를 찾지 못했어요.',
    };
  }

  if (status.failed > 0) {
    return {
      working: false,
      title: `릴스 ${status.failed}개를 분석하지 못했어요`,
      body: '잠시 뒤에 다시 시도할게요.',
    };
  }

  return null;
}

export function IngestStatusCard({ initial }: { initial: IngestStatus }) {
  const [status, setStatus] = useState<IngestStatus>(initial);
  const router = useRouter();

  // The previous poll's in-flight count, kept in a ref because it drives a side
  // effect (refresh the page's server data) and never the render. Seeded from
  // the server-rendered value so the very first transition is caught too.
  const wasAnalysing = useRef(initial.analysing);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // A hidden tab is a tab nobody is watching. Browsers already throttle
      // timers there, but skipping the request outright is the difference
      // between a background tab costing nothing and costing a trickle forever.
      if (document.visibilityState === 'visible') {
        try {
          const res = await fetch('/api/reels/status', { cache: 'no-store' });
          if (res.ok) {
            const next = (await res.json()) as IngestStatus;
            if (!cancelled) {
              setStatus(next);

              // A reel just finished. The deck and the map below were rendered
              // on the server before it did, so they are now stale by exactly
              // the places this card is announcing — ask the server for the page
              // again. Guarded by the transition rather than by `landed > 0`, so
              // it fires once per batch and not every three seconds for two
              // minutes afterwards.
              if (wasAnalysing.current > 0 && next.analysing === 0) router.refresh();
              wasAnalysing.current = next.analysing;
            }
          }
        } catch {
          // A failed poll is not worth a message. The card keeps showing the
          // last thing it knew, which is very nearly true, and the next tick
          // corrects it. An error banner here would make a dropped request look
          // like a broken pipeline.
        }
      }
      if (!cancelled) {
        timer = setTimeout(tick, wasAnalysing.current > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      }
    };

    timer = setTimeout(tick, initial.analysing > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // Mounted once. `initial` only seeds the first delay; re-running this on a
    // new server render would restart the clock on every `router.refresh()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = describe(status);

  return (
    // `aria-live="polite"` and not `assertive`: a reel landing is worth saying
    // and is never worth cutting someone off mid-sentence to say.
    <div role="status" aria-live="polite">
      {view ? (
        <Card className="mt-[var(--section-gap)] flex items-start gap-[var(--space-8)] p-[var(--space-15)]">
          {/* The only motion in this component, and it is opacity — the budget
              in `.agents/visual-language.md` has no transforms, so there is no
              spinner here and there is not going to be one. `fade` is the
              system's single existing keyframe, run alternating; `motion-safe:`
              is what keeps an infinite animation away from anyone who asked for
              reduced motion, since the global reduce rule shortens durations
              rather than stopping loops. A finished card holds the dot at rest
              so the row does not reflow when the work ends. */}
          <span
            aria-hidden
            className={`mt-[var(--space-6)] h-1.5 w-1.5 shrink-0 rounded-full bg-ink ${
              view.working
                ? 'motion-safe:animate-[fade_1.1s_var(--ease-fade)_infinite_alternate]'
                : 'opacity-25'
            }`}
          />
          <div className="min-w-0">
            <p style={{ font: 'var(--type-card-title)' }}>{view.title}</p>
            <p className="mt-[var(--space-2)] text-secondary" style={{ font: 'var(--type-meta)' }}>
              {view.body}
            </p>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
