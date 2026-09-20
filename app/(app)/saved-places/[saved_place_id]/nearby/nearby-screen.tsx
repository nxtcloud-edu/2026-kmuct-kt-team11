'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Chip } from '@/components/surface';
import { Icon, type IconName } from '@/components/icons';
import { CATEGORY_KO, naverSearchUrl } from '@/components/place-detail';
import type { NearbyCandidate, NearbyResult, NearbySourceReport } from '@/lib/research/nearby';

/**
 * 주변 장소 찾기 — the results surface.
 *
 * ── NOTHING RUNS UNTIL SOMETHING IS PRESSED ────────────────────────────────
 * There is no fetch on mount and no `useEffect` that starts one. A visit to this
 * URL costs nothing; the button costs two Apify runs and up to fourteen Gemini
 * calls. That is the whole reason the screen opens on an idle state that
 * explains what the button will do rather than on a spinner — a cost the user
 * did not choose is a cost they will be surprised by.
 *
 * ── THE HONESTY FRAME, LIFTED FROM components/place-detail.tsx ─────────────
 * Everything on this screen is A STRANGER'S CLAIM IN A POST. It is exactly the
 * class of thing block 3 of the place-detail screen frames as 릴스 캡션에 적힌
 * 정보 with a 미확인 chip, and it gets the same treatment, for the same reason
 * (`docs/gaja/reel-extraction-findings.md`: a creator's words are a prior to
 * verify, not ground truth). Three rules carried over verbatim:
 *
 *   * PROVENANCE ARRIVES BEFORE CONTENT. The 미확인 chip and the sentence saying
 *     whose words these are sit ABOVE the list, not under it as a footnote.
 *   * EVERY CARD LINKS BACK. `sourceUrl` is non-optional all the way down the
 *     pipeline, so there is no card here without a receipt. A scraped venue name
 *     with no link is an unattributable claim and must not be renderable.
 *   * IT IS NOT STYLED DOWN. Names and addresses are `--ink` at readable sizes.
 *     A user who cannot read the result is not being protected. Honesty is
 *     carried by the frame, never by making the text faint.
 *
 * ── FOUR SILENCES, FOUR SENTENCES ──────────────────────────────────────────
 * `APIFY_TOKEN` unset, the actor erroring, the actor returning nothing, and the
 * actor returning posts that named no venue are four different facts about the
 * world and get four different lines (discovery spec §8). The one they must
 * never collapse into is "근처에 아무것도 없어요", which would be Gaja asserting
 * something about a neighbourhood on the strength of a broken scraper.
 *
 * ── VISUAL LANGUAGE ────────────────────────────────────────────────────────
 * `.agents/visual-language.md`: cards are tinted surfaces, no border and no
 * shadow; the three-shadow depth budget is spent, so grouping is the surface
 * step. No accent colour exists. Motion is opacity only.
 */

/* ── Thumbnails ───────────────────────────────────────────────────────────── */

/**
 * A PLAIN `<img>`, DELIBERATELY, AND NOT `next/image`.
 *
 * Three reasons, in order of how much they cost when ignored:
 *
 *   1. These URLs are signed and short-lived. An Instagram CDN link expires in
 *      hours. Putting it through the image optimizer means caching a URL that
 *      will 403 before the cache entry does, so the failure gets FROZEN rather
 *      than degrading — and a stale optimizer entry is not invalidated by the
 *      row changing.
 *   2. `next/image` refuses any host absent from `images.remotePatterns`, and
 *      the pattern this would need is `**.cdninstagram.com` plus `*.pstatic.net`
 *      — wildcards across two CDNs that host far more than these thumbnails.
 *      `next.config.ts` narrows its one existing entry to a single bucket path
 *      for exactly that reason; widening it to a whole CDN turns our optimizer
 *      into a proxy for it. That is not a narrow addition, so it was not made.
 *   3. This repo has already been bitten twice by the optimizer — PNGs turning
 *      black on gAMA/sRGB chunks, and Next 16 refusing private-IP hosts. Neither
 *      bug can reach a path that does not use it.
 *
 * `referrerPolicy="no-referrer"` keeps the saved-place id out of Meta's and
 * Naver's referrer logs, the same rule the `rel="noreferrer"` links follow. A
 * broken or expired image leaves the `--surface-2` tint behind it, which is a
 * designed empty thumbnail rather than a hole. No media is stored; only URLs.
 */
function Thumb({ src }: { src: string | null }) {
  return (
    <span className="relative block h-[64px] w-[64px] shrink-0 overflow-hidden rounded-[var(--radius-md)] bg-surface-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- see the block above
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}

/* ── Source labels ────────────────────────────────────────────────────────── */

const SOURCE_KO: Record<NearbyCandidate['source'], string> = {
  naver_blog: '네이버 블로그',
  instagram: '인스타그램',
};

/**
 * One line per source, and the words are the point.
 *
 * `no-rows` and `no-posts` are two different silences and say so. "글이 하나도
 * 없었어요" is the actor-rot signature — a busy 동 does not stop being written
 * about — while "글은 있었는데 장소 이름이 없었어요" is an ordinary bad batch. A
 * user who reports the first tells us something a user who reports the second
 * does not, and collapsing them would cost us that.
 */
function sourceLine(r: NearbySourceReport): string | null {
  switch (r.status) {
    case 'ok':
      return null;
    case 'not-configured':
      return `${SOURCE_KO[r.source]}은 이 환경에 설정되어 있지 않아 찾아보지 못했어요.`;
    case 'failed':
      return `${SOURCE_KO[r.source]}을 읽는 데 실패했어요. 근처에 없다는 뜻은 아니에요.`;
    case 'no-rows':
      return `${SOURCE_KO[r.source]}에서 글이 하나도 오지 않았어요. 수집기 쪽 문제일 수 있어요.`;
    case 'no-posts':
      return `${SOURCE_KO[r.source]} 글은 있었는데 장소 이름을 읽어내지 못했어요.`;
  }
}

/* ── One result ───────────────────────────────────────────────────────────── */

const CATEGORY_ICON: Record<string, IconName> = {
  cafe: 'cafe',
  restaurant: 'restaurant',
  exhibition: 'exhibition',
  shop: 'shop',
  activity: 'activity',
};

/** `2026-03-04T…` → `2026. 3. 4.` — the form Naver and Instagram both show dates in. */
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function ResultCard({ candidate, area }: { candidate: NearbyCandidate; area: string }) {
  const category = candidate.category ? CATEGORY_KO[candidate.category] ?? candidate.category : null;
  const icon = candidate.category ? CATEGORY_ICON[candidate.category] : undefined;
  const date = shortDate(candidate.postedAt);

  return (
    <Card as="li" className="flex flex-col gap-[var(--space-9)] p-[var(--space-10)]">
      <div className="flex items-start gap-[var(--space-9)]">
        <Thumb src={candidate.thumbUrl} />

        <div className="min-w-0 flex-1">
          <p style={{ font: 'var(--type-card-title)' }}>{candidate.name}</p>

          {candidate.nameAlt ? (
            <p className="mt-0.5 text-secondary" style={{ font: 'var(--type-caption)' }}>
              {candidate.nameAlt}
            </p>
          ) : null}

          {/* THE ADDRESS DIFFERENCE, and it is the difference between a card you
              can act on and a card you can only read. An address that was in the
              post is shown verbatim in ink — it is the most useful line here. A
              card without one says so in as many words rather than leaving a gap
              the reader has to interpret, because "no address" is a fact about
              the post, not a rendering failure. */}
          {candidate.address ? (
            <p className="mt-[var(--space-5)]" style={{ font: 'var(--type-meta)' }}>
              {candidate.address}
            </p>
          ) : (
            <p className="mt-[var(--space-5)] text-secondary" style={{ font: 'var(--type-meta)' }}>
              글에 주소가 적혀 있지 않아요
            </p>
          )}

          {category ? (
            <span className="mt-[var(--space-7)] flex flex-wrap items-center gap-[var(--space-4)]">
              <Chip>
                {icon ? <Icon name={icon} size={14} /> : null}
                {category}
              </Chip>
              {/* The extractor's own hedge, shown rather than hidden. A category
                  it flagged `low` is a guess from the venue name alone
                  (lib/extract/caption.ts), and `lib/research/resolve-place.ts`
                  already refuses to write one into `places` for that reason. If
                  it is not good enough for the database it is not good enough to
                  show unqualified. */}
              {candidate.categoryConfidence === 'low' ? <Chip>분류는 추측</Chip> : null}
            </span>
          ) : null}
        </div>
      </div>

      {/* ── The receipt ──────────────────────────────────────────────────── */}
      <div className="flex gap-[var(--space-7)]">
        <a
          href={candidate.sourceUrl}
          target="_blank"
          // `noopener` denies the opened tab a handle on ours; `noreferrer` keeps
          // the saved-place id out of Naver's and Meta's referrer logs.
          rel="noopener noreferrer"
          className="flex h-[var(--tap-min)] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-lg)] bg-surface-2 px-[var(--space-9)] text-ink transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-button)' }}
        >
          <span className="truncate">{SOURCE_KO[candidate.source]}</span>
        </a>

        {/* The verification path, and the only reason this screen is not a dead
            end. Naver Place has the venue's own hours, photos and reviews — the
            checked counterpart to the sentence a stranger wrote. Searched by
            address when the post gave one and by 동 + name when it did not, which
            is weaker and is why the address line above is not decoration. */}
        <a
          href={naverSearchUrl(candidate.name, candidate.address ?? area)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-[var(--tap-min)] flex-1 items-center justify-center rounded-[var(--radius-lg)] bg-ink px-[var(--space-9)] text-on-ink transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-button)' }}
        >
          장소보기
        </a>
      </div>

      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        {[candidate.sourceHandle ? `@${candidate.sourceHandle}` : null, date, candidate.sourceTitle]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </Card>
  );
}

/* ── The screen ───────────────────────────────────────────────────────────── */

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: NearbyResult }
  | { kind: 'error'; message: string };

/** Pulled from `components/agent-sheet.tsx`, which is the precedent for a status line in this app. */
function Pulse() {
  return (
    <span
      aria-hidden
      className="h-[6px] w-[6px] shrink-0 rounded-[var(--radius-circle)] bg-ink"
      style={{ animation: 'fade 900ms var(--ease-fade) infinite alternate' }}
    />
  );
}

export function NearbyScreen({
  savedPlaceId,
  name,
  area,
}: {
  savedPlaceId: string;
  name: string;
  area: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * DOHERTY. The wait here is tens of seconds — two scrapers and a model — and a
   * button that goes quiet for forty seconds has failed as far as the user is
   * concerned. A ticking second count is the cheapest honest proof the request is
   * still alive, and the message it drives is DERIVED during render from
   * `elapsed` rather than written into a second state by an effect.
   */
  useEffect(() => {
    if (phase.kind !== 'running') return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase.kind]);

  const run = useCallback(async () => {
    setElapsed(0);
    setPhase({ kind: 'running' });
    try {
      const res = await fetch(`/api/saved-places/${savedPlaceId}/nearby`, {
        method: 'POST',
        // No body. The route reads the anchor off the saved place; there is
        // nothing for a caller to widen.
        headers: { accept: 'application/json' },
      });

      if (!res.ok) {
        // RFC 9457. `detail` is the user-facing sentence and every code this
        // route can produce carries a Korean one.
        const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof body?.detail === 'string' ? body.detail : null;
        if (alive.current) {
          setPhase({
            kind: 'error',
            message: detail ?? '주변 장소를 찾는 중에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
          });
        }
        return;
      }

      const result = (await res.json()) as NearbyResult;
      if (alive.current) setPhase({ kind: 'done', result });
    } catch {
      if (alive.current) {
        setPhase({ kind: 'error', message: '연결이 끊겼어요. 다시 시도해 주세요.' });
      }
    }
  }, [savedPlaceId]);

  return (
    <section className="flex flex-col gap-[var(--section-gap)]">
      {/* ── 1. What this is, and what pressing it costs ──────────────────── */}
      <div>
        <h1 style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}>
          {area} 주변
        </h1>
        <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          {name} 근처를 다룬 네이버 블로그 글과 인스타그램 글에서 장소 이름을 뽑아 와요. 찾는 데
          30초쯤 걸려요.
        </p>
      </div>

      {/* ── 2. The trigger ───────────────────────────────────────────────── */}
      {phase.kind !== 'done' ? (
        <div>
          <Button
            variant="primary"
            className="w-full"
            onClick={() => void run()}
            disabled={phase.kind === 'running'}
          >
            {phase.kind === 'running' ? '찾는 중' : '주변 장소 찾기'}
          </Button>

          {/* Announced, not just drawn, and `polite` so it never interrupts —
              the same treatment the assistant sheet's status line gets. */}
          {phase.kind === 'running' ? (
            <p
              aria-live="polite"
              className="mt-[var(--space-9)] flex items-center gap-[var(--space-7)] text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              <Pulse />
              {elapsed < 25
                ? `${area} 글을 읽고 있어요 · ${elapsed}초`
                : `아직 읽고 있어요. 조금만 더 기다려 주세요 · ${elapsed}초`}
            </p>
          ) : null}

          {phase.kind === 'error' ? (
            <p
              role="alert"
              className="mt-[var(--space-9)] text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              {phase.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'done' ? <Results result={phase.result} onRetry={() => void run()} /> : null}
    </section>
  );
}

/* ── Results ──────────────────────────────────────────────────────────────── */

function Results({ result, onRetry }: { result: NearbyResult; onRetry: () => void }) {
  const notices = result.sources.map(sourceLine).filter((l): l is string => l !== null);

  /**
   * Cards with an address first, and that is a completeness ordering rather than
   * a quality claim. Gaja has not judged any of these venues and must not look
   * as though it has — but a card carrying a street address can be opened in a
   * map and a card without one can only be read, so the actionable ones going
   * first is about what the reader can DO, which is a thing we do know.
   *
   * Derived here during render. There is no state holding a sorted copy and no
   * effect writing one, because both would be a second version of a list the
   * server already sent.
   */
  const ordered = [...result.candidates].sort(
    (a, b) => Number(Boolean(b.address)) - Number(Boolean(a.address)),
  );

  return (
    <div className="flex flex-col gap-[var(--section-gap)]">
      {/* ── The count, and the frame it arrives in ───────────────────────── */}
      <div>
        <div className="flex flex-wrap items-center gap-[var(--space-5)]">
          <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
            {/* Shown even at zero: it says the search RAN, which is the one thing
                a blank screen cannot say (Search Results checklist, item 2). */}
            {result.candidates.length}곳
          </h2>
          <Chip>미확인</Chip>
        </div>

        {/* PROVENANCE BEFORE CONTENT. Same placement and same argument as block 3
            of the place-detail screen: the heading names the source before the
            reader meets a single venue name, rather than apologising underneath
            one they have already believed. */}
        <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          다른 사람이 쓴 글에서 뽑아낸 이름이에요. 가자가 가 보거나 확인한 곳이 아니고, 문 닫았을
          수도 있어요. 카드마다 원문 링크가 있으니 직접 확인해 주세요.
        </p>

        <p className="mt-[var(--space-5)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          {/* The query, shown. A user who gets odd results deserves to see the
              question we asked rather than guessing at it. */}
          검색어 · {result.keyword}
          {result.deduped > 0 ? ` · 중복 ${result.deduped}개 제외` : ''}
        </p>
      </div>

      {/* ── What each source did, when it was not simply fine ────────────── */}
      {notices.length > 0 ? (
        <Card className="flex flex-col gap-[var(--space-5)] p-[var(--space-10)]">
          {notices.map((line) => (
            <p key={line} style={{ font: 'var(--type-meta)' }}>
              {line}
            </p>
          ))}
        </Card>
      ) : null}

      {/* ── The list, or the honest empty ────────────────────────────────── */}
      {ordered.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-[var(--space-9)] p-0">
          {ordered.map((c) => (
            <ResultCard key={c.key} candidate={c} area={result.area} />
          ))}
        </ul>
      ) : (
        <div>
          {/* NOT "근처에 아무것도 없어요". Gaja did not look at the neighbourhood,
              it looked at what people wrote about it in the last year, and those
              are different claims. The notice card above already says which
              source came back how; this says what the reader can do next. */}
          <p style={{ font: 'var(--type-body)' }}>
            이번엔 장소를 찾지 못했어요.
          </p>
          <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-meta)' }}>
            글은 매일 올라오니 나중에 다시 해 보면 결과가 달라질 수 있어요.
          </p>
        </div>
      )}

      {/* Last, because it is the least urgent thing here and because a second
          run is a second bill — a retry sitting under the button would get
          pressed by reflex. */}
      <Button variant="secondary" className="w-full" onClick={onRetry}>
        다시 찾기
      </Button>
    </div>
  );
}
