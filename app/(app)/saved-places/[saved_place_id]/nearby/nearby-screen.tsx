'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Chip } from '@/components/surface';
import { Icon, type IconName } from '@/components/icons';
import { CATEGORY_KO, naverSearchUrl } from '@/components/place-detail';
import type {
  NearbyCandidate,
  NearbyEvent,
  NearbyResult,
  NearbySourceStatus,
} from '@/lib/research/nearby';

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
 *     pipeline, so there is no venue here without a receipt. A scraped venue name
 *     with no link is an unattributable claim and must not be renderable.
 *   * IT IS NOT STYLED DOWN. Names and addresses are `--ink` at readable sizes.
 *     A user who cannot read the result is not being protected. Honesty is
 *     carried by the frame, never by making the text faint.
 *
 * ── THE CARD IS THE POST, NOT THE VENUE ────────────────────────────────────
 * One 맛집 roundup names six places, and rendering that as six full cards with
 * the same thumbnail, the same title and the same link said six things when the
 * truth was one: six names, one opinion. So the card is now the POST, and the
 * venues it named are rows inside it. That is not a layout preference —
 * `@soon.mag` contributed four of nine results in a live run, and a reader who
 * cannot see that is being shown a consensus that does not exist.
 *
 * ── FOUR SILENCES, FOUR SENTENCES ──────────────────────────────────────────
 * `APIFY_TOKEN` unset, the actor erroring, the actor returning nothing, and the
 * actor returning posts that named no venue are four different facts about the
 * world and get four different lines (discovery spec §8). The one they must
 * never collapse into is "근처에 아무것도 없어요", which would be Gaja asserting
 * something about a neighbourhood on the strength of a broken scraper. They are
 * now said twice: as the step's own outcome while the search runs, and in the
 * summary afterwards.
 *
 * ── NO PARTICLE EVER FOLLOWS A VARIABLE ────────────────────────────────────
 * This screen shipped `네이버 블로그을 읽는 데 실패했어요`. 블로그 ends in a vowel
 * and takes 를; 인스타그램 ends in ㅁ and takes 을 — so one interpolated name
 * cannot be followed by one hard-coded particle, and picking the particle at
 * runtime is a rule every future line would have to remember. The structure
 * instead puts the source name on its own line as a heading and starts every
 * sentence about it with a word of ours, so there is no site left where the two
 * meet. Every remaining particle in this file follows a literal.
 *
 * ── VISUAL LANGUAGE ────────────────────────────────────────────────────────
 * `.agents/visual-language.md`: cards are tinted surfaces, no border and no
 * shadow; the three-shadow depth budget is spent, so grouping is the surface
 * step (`--canvas` → `--surface-1` → `--surface-2`). No accent colour exists.
 * Motion is opacity only, and the one animation here is `motion-safe:`.
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
 *
 * It is the POST's cover, not the venue's photo, so it is drawn once per post —
 * which is also how six identical thumbnails stopped being drawn down one list.
 */
function Thumb({ src }: { src: string | null }) {
  return (
    <span className="relative block h-[48px] w-[48px] shrink-0 overflow-hidden rounded-[var(--radius-md)] bg-surface-2">
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

/* ── Glyphs ───────────────────────────────────────────────────────────────── */

/**
 * Drawn here rather than added to `components/icons.tsx`, on the precedent
 * `components/agent-sheet.tsx` sets: that set is a normalised export from one
 * Iconsax directory and two hand-drawn paths do not belong in it. Same 1.5px
 * linear weight so they sit beside it without reading as a second family.
 */
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
};

function Check() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden>
      <path d="M5 13l4.5 4.5L19 7" {...stroke} />
    </svg>
  );
}

function Chevron() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path d="M9 5l7 7-7 7" {...stroke} />
    </svg>
  );
}

/* ── Source labels ────────────────────────────────────────────────────────── */

const SOURCE_KO: Record<NearbyCandidate['source'], string> = {
  naver_blog: '네이버 블로그',
  instagram: '인스타그램',
};

/* ── Steps ────────────────────────────────────────────────────────────────── */

/**
 * `stopped` is not `done` and is not an error.
 *
 * A source that was never configured, or died, or came back empty, is FINISHED —
 * but it did not succeed, and a tick beside it would say it had. It is also not
 * a failure of the run: the other source is still going, and the search will
 * produce results without this one. So it gets its own mark, a rule rather than
 * a tick, in the neutral tiers. Nothing here turns red: `--error` is semantic in
 * this system and spending it on "Instagram gave nothing" would make a partial
 * result look like a crash.
 */
type StepState = 'pending' | 'running' | 'done' | 'stopped';

type Step = {
  key: string;
  /** The thing being worked, named plainly. Never followed by a particle — see the header. */
  label: string;
  /** What happened to it. Null only while a step is waiting its turn with nothing true to say. */
  detail: string | null;
  /** The read counter, and the only number on this screen that moves. `6/14`, never `43%`. */
  count: string | null;
  state: StepState;
};

function StepMark({ state }: { state: StepState }) {
  return (
    <span className="flex h-[18px] w-4 shrink-0 items-center justify-center" aria-hidden>
      {state === 'done' ? (
        <Check />
      ) : state === 'stopped' ? (
        <span className="h-[1.5px] w-[10px] rounded-[var(--radius-photo)] bg-inactive" />
      ) : state === 'running' ? (
        // Opacity only, and `motion-safe:` so a reader who asked for stillness
        // gets a plain dot. `--dur-fade` and the transforms budget are untouched:
        // nothing here moves, it only fades.
        <span className="h-[6px] w-[6px] rounded-[var(--radius-circle)] bg-ink motion-safe:animate-[fade_900ms_var(--ease-fade)_infinite_alternate]" />
      ) : (
        <span className="h-[6px] w-[6px] rounded-[var(--radius-circle)] bg-inactive" />
      )}
    </span>
  );
}

/**
 * One step, one card, and finished ones stay.
 *
 * GOAL-GRADIENT: the argument for cards rather than the single line this
 * replaced is that a visible pile of finished work is what makes a thirty-second
 * wait feel like progress instead of a hang. The pile has to be real, so every
 * card below is written by an event the server sent when the thing happened.
 */
function StepCard({ step }: { step: Step }) {
  return (
    <Card as="li" className="flex items-start gap-[var(--space-8)] p-[var(--space-10)]">
      <StepMark state={step.state} />

      <span className="min-w-0 flex-1">
        <span
          className={`block ${step.state === 'pending' ? 'text-secondary' : ''}`}
          style={{ font: 'var(--type-card-title)' }}
        >
          {step.label}
        </span>
        {step.detail ? (
          <span
            className="mt-[var(--space-2)] block text-secondary"
            style={{ font: 'var(--type-meta)' }}
          >
            {step.detail}
          </span>
        ) : null}
      </span>

      {step.count ? (
        <span className="shrink-0 text-secondary tabular-nums" style={{ font: 'var(--type-meta)' }}>
          {step.count}
        </span>
      ) : null}
    </Card>
  );
}

/**
 * The same steps, one card, one line each.
 *
 * The running state wants presence — it is the only thing on screen and the pile
 * of finished cards IS the feedback. The finished state wants to get out of the
 * way: three step cards above the results is a quarter of a 430px screen spent
 * on accounting before the reader reaches a single place. Same marks, same
 * sentences, a sixth of the height.
 */
function StepSummary({ steps }: { steps: Step[] }) {
  return (
    <Card>
      <ul className="m-0 flex list-none flex-col gap-[var(--space-5)] p-[var(--space-10)]">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-[var(--space-8)]">
            <StepMark state={s.state} />
            <span className="min-w-0 flex-1" style={{ font: 'var(--type-meta)' }}>
              {s.label}
              {s.detail ? <span className="text-secondary"> · {s.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-[var(--space-5)] p-0">
      {steps.map((s) => (
        <StepCard key={s.key} step={s} />
      ))}
    </ul>
  );
}

/**
 * What a source has to say for itself once it has landed, and the words are the
 * point.
 *
 * `no-rows` and `no-posts` are two different silences and say so. "글이 하나도
 * 오지 않았어요" is the actor-rot signature — a busy 동 does not stop being
 * written about — while "장소 이름이 없었어요" is an ordinary bad batch. A user who
 * reports the first tells us something a user who reports the second does not,
 * and collapsing them would cost us that.
 *
 * The `ok` sentence is the one available the moment the source settles: the
 * venue count does not exist yet, because nothing has been read. `finishedSteps`
 * replaces it once that number is a fact. Inventing it earlier would be the
 * exact dishonesty this whole screen is built against.
 */
function settledLine(status: NearbySourceStatus, posts: number): string {
  switch (status) {
    case 'ok':
      return `최근 글 ${posts}개를 찾았어요`;
    case 'not-configured':
      return '이 환경에 설정되어 있지 않아 찾아보지 못했어요';
    case 'failed':
      return '읽는 데 실패했어요. 근처에 없다는 뜻은 아니에요';
    case 'no-rows':
      return '글이 하나도 오지 않았어요. 수집기 쪽 문제일 수 있어요';
    case 'no-posts':
      return `글 ${posts}개를 읽었지만 장소 이름이 없었어요`;
  }
}

function settledState(status: NearbySourceStatus): StepState {
  return status === 'ok' ? 'done' : 'stopped';
}

/* ── The running state, derived from the stream ───────────────────────────── */

/**
 * Everything the client has been TOLD, and nothing it has guessed.
 *
 * `sources` is who was started, `settled` is who has come back, `reading` is the
 * extraction counter. The step list is derived from this during render — there
 * is no second state holding rendered steps and no effect writing one, because
 * that would be a copy of this that could disagree with it.
 */
type Progress = {
  sources: NearbyCandidate['source'][];
  settled: { source: NearbyCandidate['source']; status: NearbySourceStatus; posts: number }[];
  reading: { done: number; total: number } | null;
};

const EMPTY_PROGRESS: Progress = { sources: [], settled: [], reading: null };

function runningSteps(progress: Progress): Step[] {
  const steps: Step[] = progress.sources.map((source) => {
    const settled = progress.settled.find((s) => s.source === source);
    return {
      key: source,
      label: SOURCE_KO[source],
      detail: settled ? settledLine(settled.status, settled.posts) : '글을 찾고 있어요',
      count: null,
      state: settled ? settledState(settled.status) : 'running',
    };
  });

  // Named before it starts, so the wait has a visible end rather than an
  // unknown number of things left. It reads as pending until the server says
  // otherwise — a step nobody has confirmed must never be drawn as finished.
  const reading = progress.reading;
  steps.push({
    key: 'reading',
    label: '장소 이름 읽기',
    detail: !reading
      ? '글을 다 모으면 시작해요'
      : reading.total === 0
        ? '읽을 글이 없었어요'
        : '글에서 장소 이름을 읽고 있어요',
    count: reading && reading.total > 0 ? `${reading.done}/${reading.total}` : null,
    state: !reading
      ? 'pending'
      : reading.total === 0
        ? 'stopped'
        : reading.done < reading.total
          ? 'running'
          : 'done',
  });

  return steps;
}

/** The same list, finished, from the result the server sent. Continuity is the point: the cards do not change shape when the answer lands. */
function finishedSteps(result: NearbyResult, read: Progress['reading']): Step[] {
  const steps: Step[] = result.sources.map((r) => ({
    key: r.source,
    label: SOURCE_KO[r.source],
    detail:
      r.status === 'ok'
        ? `글 ${r.posts}개에서 이름 ${r.candidates}개를 읽었어요`
        : settledLine(r.status, r.posts),
    count: null,
    state: settledState(r.status),
  }));

  if (read && read.total > 0) {
    steps.push({
      key: 'reading',
      label: '장소 이름 읽기',
      detail: `글 ${read.total}개를 읽었어요`,
      count: null,
      state: 'done',
    });
  }

  return steps;
}

/** The running state in one sentence: how many steps are behind us, and what is happening now. */
function liveLine(steps: Step[]): string {
  const finished = steps.filter((s) => s.state === 'done' || s.state === 'stopped').length;
  const current = steps.find((s) => s.state === 'running');
  const head = `${steps.length}개 중 ${finished}개 끝났어요`;
  return current ? `${head} · ${current.label} ${current.detail ?? ''}`.trim() : head;
}

/* ── Grouping ─────────────────────────────────────────────────────────────── */

/**
 * The venues one post named.
 *
 * Grouped by `sourceUrl` because that is what a post IS here — the pipeline
 * carries the post's title, date, cover and handle onto every venue it named, so
 * six venues from one roundup arrive as six copies of the same receipt. Folding
 * them back is not a tidy-up: it is the difference between "six places near you"
 * and "one blogger's six favourites", and only one of those is true.
 */
type PostGroup = {
  url: string;
  source: NearbyCandidate['source'];
  title: string;
  postedAt: string | null;
  thumbUrl: string | null;
  /**
   * The handle, only when every venue in the post agrees on it.
   *
   * `sourceHandle` is the VENUE's own handle when the caption named one and the
   * poster's otherwise (see `toCandidate`), so a roundup tagging six shops
   * carries six different handles and none of them is the author. Shown on the
   * post line only when they are unanimous — otherwise it belongs on the row it
   * describes, and attributing a shop's handle to the writer would be a made-up
   * byline.
   */
  handle: string | null;
  venues: NearbyCandidate[];
};

function groupByPost(candidates: NearbyCandidate[]): PostGroup[] {
  const groups = new Map<string, PostGroup>();

  for (const c of candidates) {
    const existing = groups.get(c.sourceUrl);
    if (existing) {
      existing.venues.push(c);
      if (existing.handle !== c.sourceHandle) existing.handle = null;
      continue;
    }
    groups.set(c.sourceUrl, {
      url: c.sourceUrl,
      source: c.source,
      title: c.sourceTitle,
      postedAt: c.postedAt,
      thumbUrl: c.thumbUrl,
      handle: c.sourceHandle,
      venues: [c],
    });
  }

  return [...groups.values()];
}

/** Addressed first. A completeness ordering, not a quality claim — see `Results`. */
function addressedFirst(a: NearbyCandidate, b: NearbyCandidate): number {
  return Number(Boolean(b.address)) - Number(Boolean(a.address));
}

/* ── One venue ────────────────────────────────────────────────────────────── */

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

/**
 * A venue, as a row that IS the link.
 *
 * Nine results used to carry eighteen full-width buttons, which was most of the
 * screen and two decisions per card where there is really one: the thing a
 * person does with a name they cannot verify is look it up. So the row itself is
 * the lookup, the post's receipt is one quiet link per card, and the chrome
 * collapses from eighteen buttons to nine rows and four links.
 *
 * WEIGHT FOLLOWS THE ADDRESS. A row with a street address can be opened on a map
 * and gets the `--surface-2` fill that says so; a row without one can only be
 * searched by 동 + name, which is weaker, and it sits flat on the card. The name
 * is `--ink` in both cases — the frame carries the hedge, never faint text.
 */
function VenueRow({ venue, area, showHandle }: { venue: NearbyCandidate; area: string; showHandle: boolean }) {
  const category = venue.category ? CATEGORY_KO[venue.category] ?? venue.category : null;
  const icon = venue.category ? CATEGORY_ICON[venue.category] : undefined;

  return (
    <li>
      <a
        href={naverSearchUrl(venue.name, venue.address ?? area)}
        target="_blank"
        // `noopener` denies the opened tab a handle on ours; `noreferrer` keeps
        // the saved-place id out of Naver's and Meta's referrer logs.
        rel="noopener noreferrer"
        className={`flex min-h-[var(--tap-min)] items-center gap-[var(--space-7)] rounded-[var(--radius-lg)] px-[var(--space-8)] py-[var(--space-6)] transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
          venue.address ? 'bg-surface-2' : ''
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-[var(--space-4)]">
            <span style={{ font: 'var(--type-card-title)' }}>{venue.name}</span>
            {category ? (
              <Chip>
                {icon ? <Icon name={icon} size={14} /> : null}
                {category}
              </Chip>
            ) : null}
            {/* The extractor's own hedge, shown rather than hidden. A category
                it flagged `low` is a guess from the venue name alone
                (lib/extract/caption.ts), and `lib/research/resolve-place.ts`
                already refuses to write one into `places` for that reason. If it
                is not good enough for the database it is not good enough to show
                unqualified. */}
            {venue.categoryConfidence === 'low' ? <Chip>분류는 추측</Chip> : null}
          </span>

          {venue.nameAlt ? (
            <span className="mt-[var(--space-2)] block text-secondary" style={{ font: 'var(--type-caption)' }}>
              {venue.nameAlt}
            </span>
          ) : null}

          {/* THE ADDRESS DIFFERENCE, and it is the difference between a row you
              can act on and a row you can only read. An address that was in the
              post is shown verbatim in ink — it is the most useful line here. A
              row without one says so in as many words rather than leaving a gap
              the reader has to interpret, because "no address" is a fact about
              the post, not a rendering failure. */}
          {venue.address ? (
            <span className="mt-[var(--space-3)] block" style={{ font: 'var(--type-meta)' }}>
              {venue.address}
            </span>
          ) : (
            <span
              className="mt-[var(--space-3)] block text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              글에 주소가 적혀 있지 않아 이름으로만 찾아요
            </span>
          )}

          {showHandle && venue.sourceHandle ? (
            <span className="mt-[var(--space-2)] block text-secondary" style={{ font: 'var(--type-caption)' }}>
              @{venue.sourceHandle}
            </span>
          ) : null}

          {/* The link's own purpose, for a reader who hears the row rather than
              seeing the chevron. */}
          <span className="sr-only">네이버 지도에서 찾아보기</span>
        </span>

        <Chevron />
      </a>
    </li>
  );
}

/* ── One post ─────────────────────────────────────────────────────────────── */

function PostCard({ group, area }: { group: PostGroup; area: string }) {
  const date = shortDate(group.postedAt);
  const many = group.venues.length > 1;
  const venues = [...group.venues].sort(addressedFirst);

  return (
    <Card as="li" className="flex flex-col gap-[var(--space-9)] p-[var(--space-10)]">
      {/* ── Whose words these are ─────────────────────────────────────────── */}
      <div className="flex items-start gap-[var(--space-8)]">
        <Thumb src={group.thumbUrl} />

        <div className="min-w-0 flex-1">
          <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
            {[
              SOURCE_KO[group.source],
              date,
              group.handle ? `@${group.handle}` : null,
              // THE LISTICLE TELL. Six names from one post is one opinion, and a
              // reader comparing recommendations needs to know that before they
              // read the six.
              many ? `한 글에 ${group.venues.length}곳` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {group.title ? (
            <p className="mt-[var(--space-3)] line-clamp-2" style={{ font: 'var(--type-meta)' }}>
              {group.title}
            </p>
          ) : null}
        </div>
      </div>

      {/* ── What it named ─────────────────────────────────────────────────── */}
      <ul className="m-0 flex list-none flex-col gap-[var(--space-4)] p-0">
        {venues.map((v) => (
          <VenueRow key={v.key} venue={v} area={area} showHandle={group.handle === null} />
        ))}
      </ul>

      {/* ── The receipt ───────────────────────────────────────────────────── */}
      {/* Once per post rather than once per venue, and last, because the reader
          should meet the content before the decision (Card checklist §5). Every
          venue above is covered by it — there is still no name on this screen
          without a link to the sentence it came from. */}
      <a
        href={group.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-[var(--tap-min)] items-center gap-[var(--space-2)] self-start text-secondary transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
        style={{ font: 'var(--type-meta)' }}
      >
        원문 보기
        <Chevron />
      </a>
    </Card>
  );
}

/* ── The screen ───────────────────────────────────────────────────────────── */

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: Progress }
  | { kind: 'done'; result: NearbyResult; read: Progress['reading'] }
  | { kind: 'error'; message: string };

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
  const abort = useRef<AbortController | null>(null);

  // Leaving the screen mid-search cancels the read, which closes the generator
  // on the server rather than leaving it yielding into nothing. It also means no
  // state is set after unmount, without a second `alive` flag to keep in sync.
  useEffect(() => () => abort.current?.abort(), []);

  /**
   * DOHERTY. The wait here is tens of seconds — two scrapers and a model — and
   * the step cards say WHAT is happening while the second count says the request
   * is still alive. The message it drives is DERIVED during render from
   * `elapsed`, never written into a second state by an effect.
   */
  useEffect(() => {
    if (phase.kind !== 'running') return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase.kind]);

  const run = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setElapsed(0);
    setPhase({ kind: 'running', progress: EMPTY_PROGRESS });

    // Local, not state: it only has to survive this call, and reading state back
    // to decide whether the stream ended cleanly would be reading a value React
    // has not necessarily committed yet.
    let closed = false;

    try {
      const res = await fetch(`/api/saved-places/${savedPlaceId}/nearby`, {
        method: 'POST',
        // No body. The route reads the anchor off the saved place; there is
        // nothing for a caller to widen.
        headers: { accept: 'application/x-ndjson' },
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        // RFC 9457, and it is still the contract right up to the first byte —
        // the route pulls the first event before it answers so that a missing
        // credential is a problem document rather than an in-band surprise.
        const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
        const detail = typeof body?.detail === 'string' ? body.detail : null;
        setPhase({
          kind: 'error',
          message: detail ?? '주변 장소를 찾는 중에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
        });
        return;
      }

      for await (const event of readNdjson(res.body, controller.signal)) {
        if (event.type === 'result' || event.type === 'error') closed = true;
        setPhase((p) => apply(p, event));
      }

      // The connection ended without a verdict — a function killed at its
      // timeout looks exactly like this. Saying so beats a screen that sits on
      // half a step list forever.
      if (!closed && !controller.signal.aborted) {
        setPhase({ kind: 'error', message: '찾는 중에 연결이 끊겼어요. 다시 시도해 주세요.' });
      }
    } catch {
      if (controller.signal.aborted) return;
      setPhase({ kind: 'error', message: '연결이 끊겼어요. 다시 시도해 주세요.' });
    }
  }, [savedPlaceId]);

  const steps =
    phase.kind === 'running'
      ? runningSteps(phase.progress)
      : phase.kind === 'done'
        ? finishedSteps(phase.result, phase.read)
        : [];

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

      {/* Announced, not just drawn, and `polite` so it never interrupts. It sits
          OUTSIDE every branch below on purpose: a live region that mounts with
          its text already in it is not reliably announced, so the element has to
          outlive the phases whose changes it is reporting. Errors are not routed
          here — they get `role="alert"` where they are drawn. */}
      <p className="sr-only" aria-live="polite">
        {announcement(phase, steps)}
      </p>

      {/* ── 2. The trigger, and what it is doing ─────────────────────────── */}
      {phase.kind !== 'done' ? (
        <div className="flex flex-col gap-[var(--space-9)]">
          <Button
            variant="primary"
            className="w-full"
            onClick={() => void run()}
            disabled={phase.kind === 'running'}
          >
            {phase.kind === 'running' ? '찾는 중' : '주변 장소 찾기'}
          </Button>

          {phase.kind === 'running' ? (
            <>
              <StepList steps={steps} />

              <p className="text-secondary tabular-nums" style={{ font: 'var(--type-caption)' }}>
                {elapsed}초 지났어요 · 보통 30초쯤 걸려요
              </p>
            </>
          ) : null}

          {phase.kind === 'error' ? (
            <p role="alert" className="text-secondary" style={{ font: 'var(--type-meta)' }}>
              {phase.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'done' ? (
        <Results result={phase.result} steps={steps} onRetry={() => void run()} />
      ) : null}
    </section>
  );
}

/**
 * What the live region says at each phase.
 *
 * Derived, and deliberately not the same text the screen shows: the elapsed
 * counter and the `6/14` read counter are kept out of it, because a polite
 * region re-announces whenever its text changes and one that said a new number
 * every second would be unusable. This changes a handful of times per run.
 */
function announcement(phase: Phase, steps: Step[]): string {
  switch (phase.kind) {
    case 'running':
      return liveLine(steps);
    case 'done':
      return `${phase.result.candidates.length}곳을 찾았어요`;
    case 'idle':
    case 'error':
      return '';
  }
}

/** Folds one stream event into the phase. Pure — it is a `setState` updater. */
function apply(phase: Phase, event: NearbyEvent): Phase {
  switch (event.type) {
    case 'started':
      return phase.kind === 'running'
        ? { kind: 'running', progress: { ...phase.progress, sources: event.sources } }
        : phase;
    case 'source':
      return phase.kind === 'running'
        ? {
            kind: 'running',
            progress: {
              ...phase.progress,
              settled: [
                ...phase.progress.settled,
                { source: event.source, status: event.status, posts: event.posts },
              ],
            },
          }
        : phase;
    case 'reading':
      return phase.kind === 'running'
        ? {
            kind: 'running',
            progress: { ...phase.progress, reading: { done: event.done, total: event.total } },
          }
        : phase;
    case 'result':
      return {
        kind: 'done',
        result: event.result,
        read: phase.kind === 'running' ? phase.progress.reading : null,
      };
    case 'error':
      return { kind: 'error', message: event.detail };
  }
}

/* ── NDJSON ───────────────────────────────────────────────────────────────── */

/**
 * One JSON object per line. A chunk from the network can split a line anywhere,
 * including inside a multi-byte Hangul character — which is why the decoder is
 * created once with `{ stream: true }` rather than `JSON.parse`ing each chunk.
 *
 * A line that will not parse is skipped rather than thrown: losing one progress
 * update is a worse-than-nothing reason to abandon a search that is still
 * running and will still deliver a result.
 *
 * `components/agent-sheet.tsx` has the same twenty lines and they are not shared.
 * That file is the assistant's, it does not export this, and a `lib/ndjson.ts`
 * pulled out of it would be a refactor of somebody else's screen to save a
 * reader here twenty lines. When a third caller appears, that is the commit that
 * earns it.
 */
async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<NearbyEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as NearbyEvent;
        } catch {
          // Malformed line; the stream is still good.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/* ── Results ──────────────────────────────────────────────────────────────── */

function Results({
  result,
  steps,
  onRetry,
}: {
  result: NearbyResult;
  steps: Step[];
  onRetry: () => void;
}) {
  /**
   * Grouped by post, then posts with something addressable first, then the more
   * recent post first.
   *
   * The first is a completeness ordering rather than a quality claim: Gaja has
   * not judged any of these venues and must not look as though it has — but a
   * row carrying a street address can be opened on a map and a row without one
   * can only be searched by name, so the actionable ones going first is about
   * what the reader can DO, which is a thing we do know. The second is a fact
   * about the post, not about the place: everything here is inside a twelve
   * month window and the older end of that window is where the closed ones are.
   *
   * Derived here during render. There is no state holding a sorted copy and no
   * effect writing one, because both would be a second version of a list the
   * server already sent.
   */
  const groups = groupByPost(result.candidates).sort((a, b) => {
    const addressable = Number(b.venues.some((v) => v.address)) - Number(a.venues.some((v) => v.address));
    if (addressable !== 0) return addressable;
    return (b.postedAt ?? '').localeCompare(a.postedAt ?? '');
  });

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
          {[
            `검색어 · ${result.keyword}`,
            groups.length > 0 ? `글 ${groups.length}개에서` : null,
            result.deduped > 0 ? `중복 ${result.deduped}개 제외` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {/* ── How it went, one line per step ───────────────────────────────── */}
      {/* The same cards that were ticking a moment ago, now final. It is the
          notice block this screen has always needed — the four silences, still
          four — and it is also where the count above gets its provenance: nine
          places out of how many posts, read by which source. */}
      {steps.length > 0 ? (
        <div>
          <h3
            className="mb-[var(--space-7)]"
            style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}
          >
            이렇게 찾았어요
          </h3>
          <StepSummary steps={steps} />
        </div>
      ) : null}

      {/* ── The list, or the honest empty ────────────────────────────────── */}
      {groups.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-[var(--space-9)] p-0">
          {groups.map((g) => (
            <PostCard key={g.url} group={g} area={result.area} />
          ))}
        </ul>
      ) : (
        <div>
          {/* NOT "근처에 아무것도 없어요". Gaja did not look at the neighbourhood,
              it looked at what people wrote about it in the last year, and those
              are different claims. The step list above already says which source
              came back how; this says what the reader can do next. */}
          <p style={{ font: 'var(--type-body)' }}>이번엔 장소를 찾지 못했어요.</p>
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
