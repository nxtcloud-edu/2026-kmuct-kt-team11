'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Chip } from '@/components/surface';
import { Icon, type IconName } from '@/components/icons';
import { reelThumb } from '@/lib/reel-thumb';
import type { SavedPlaceDetail, SiblingPlace } from '@/lib/saved-places';

/**
 * The place-detail view — what opens when you tap a saved place.
 *
 * A CLIENT COMPONENT ON PURPOSE, although it fetches nothing and holds almost no
 * state. This has to be mountable inside the map screen's bottom sheet, and a
 * sheet that can be dragged is a client component; a server component can only
 * reach one as `children`, which forces the whole selection flow through the
 * server. Props are plain serialisable values (`getSavedPlaceDetailForUser`
 * produces them), so either caller works.
 *
 * ── What this shows that the reference screen does not ──────────────────────
 * The reference is a category chip, a name, an address, three buttons and a
 * comments section. Everything below the actions is data Gaja already holds and
 * has never put on a screen: the creator's opening hours, the menu with real
 * prices, the VENUE's own Instagram account (a different link from the reel it
 * came from), and the other places the same reel named. `우이그` is venue 2 of 10
 * in one caption — "the other nine" is the fact that makes this product different
 * from a bookmark folder, and it is the last block for that reason (serial
 * position: first and last are what gets remembered, so identity opens and the
 * reel's siblings close).
 *
 * ── Chunking ────────────────────────────────────────────────────────────────
 * Twelve facts presented flat is a wall. They are grouped into four blocks that
 * answer four different questions, in the order a person asks them:
 *   1. identity  — what and where is this?
 *   2. actions   — take me there / show me the post / give me the address
 *   3. claim     — what did the creator say about it?   (unverified, see below)
 *   4. source    — where did this come from?
 *   5. related   — what else was in that reel?
 *
 * ── THE HONESTY CONSTRAINT, and how block 3 answers it ──────────────────────
 * `hours_raw` and `menu_raw` are A CREATOR'S CLAIM IN AN INSTAGRAM CAPTION, not
 * verified facts. `docs/gaja/reel-extraction-findings.md`: "Caption hours are a
 * claim by a creator, not ground truth, so treat them as a prior to verify rather
 * than a fact; but 'unverified hours' beats 'no hours'."
 *
 * Three decisions follow, and each is a decision not to do the obvious thing:
 *
 *   * THE STRINGS STAY RAW. `매일 11:00-22:30 금,토 11:00-23:00` is not parsed into
 *     a weekday table, and the menu is not split into rows with a price column.
 *     A weekly table is the visual grammar of a verified opening-hours record —
 *     rendering a guess in it launders the guess into a fact. The column is
 *     stored raw for exactly this reason (lib/extract/types.ts) and displaying it
 *     raw is the same decision carried one layer further.
 *   * THE BLOCK IS A QUOTATION, not a facts panel. `<blockquote cite>` pointing at
 *     the source post is what this literally is, and it is the only element here
 *     whose semantics say "someone else said this". The heading names the source
 *     ("릴스 캡션에 적힌 정보") rather than the subject ("영업시간"), so provenance
 *     arrives before the content does, not as a footnote after it.
 *   * IT IS NOT STYLED DOWN. The words are `--ink` at body size, because a user
 *     who cannot read the hours is not being protected, they are being denied the
 *     most useful thing on the screen. Honesty is carried by the frame — heading,
 *     quote semantics, the 미확인 chip and the closing note — not by making the
 *     text hard to read.
 *
 * ── THE ABSENT VERIFIED LAYER, designed rather than left out ────────────────
 * `place_facts` — Gaja's own researched hours, wait estimates and vibe tags — has
 * ZERO ROWS: the Kakao/Naver/Google adapters have not landed and the review
 * digest has not run. That is a stated state in
 * `supabase/migrations/20260920000007_place_facts.sql`, not a defect.
 *
 * So there is NO empty "대기시간" or "분위기" heading anywhere below, per the
 * record's rule that a section with no data behind it is deleted outright. The
 * absence is instead made visible where it actually matters: the closing note of
 * block 3 says in as many words that Gaja has not checked these hours. That is
 * the honest rendering of an empty research table — not a spinner, not a
 * placeholder, and not silence. When an adapter lands, the verified hours become
 * their own block above this one and this block keeps its quote framing unchanged.
 */

/**
 * `places.category` is an English enum in the database and every word a user
 * reads is Korean. This is the THIRD copy of this map (home/nearby-map.tsx
 * exports one, home/deck.tsx keeps its own) — worth consolidating, but not from
 * inside this file: nearby-map is a client module that pulls the whole Naver
 * bundle, so importing it here to save five lines would be a bad trade.
 *
 * EXPORTED so the 주변 장소 찾기 screen can be the third consumer rather than the
 * fourth definition. It imports from here and not from home/ for the reason
 * above: this module pulls next/image and the icon set, nearby-map pulls Naver.
 */
export const CATEGORY_KO: Record<string, string> = {
  cafe: '카페',
  restaurant: '음식점',
  exhibition: '전시',
  shop: '가게',
  activity: '체험',
};

const CATEGORY_ICON: Record<string, IconName> = {
  cafe: 'cafe',
  restaurant: 'restaurant',
  exhibition: 'exhibition',
  shop: 'shop',
  activity: 'activity',
};

/**
 * Naver, not Google, for the same reason `home/nearby-map.tsx` argues at length:
 * every place here is addressed by a Korean road address and named in Korean, and
 * Google's Korean basemap frequently has no venue label at all. Jakob's Law cuts
 * the same way — a Korean user tapping "장소보기" expects Naver Map.
 *
 * Searched by address AND name rather than by coordinate, because a coordinate
 * drops you on a pin with no business attached to it, while the search lands on
 * the venue's own Naver Place page with its hours, photos and reviews — which is
 * the verified counterpart to the caption claim above, one tap away.
 */
export function naverSearchUrl(name: string, address: string | null): string {
  const q = address ? `${address} ${name}` : name;
  return `https://map.naver.com/p/search/${encodeURIComponent(q)}`;
}

/* ── Controls ─────────────────────────────────────────────────────────────── */

/**
 * The action row's buttons, defined here rather than by reusing `Button` from
 * components/surface.tsx for two reasons: two of the three are links and `Button`
 * renders a `<button>`, and three 56px buttons across a 430px canvas is a wall of
 * chrome where the reference has a light row. `--tap-min` (44px) is the token for
 * exactly this — the smallest height that is still a reliable touch target.
 *
 * Same tone vocabulary as `Button`: hierarchy by fill only, because there is no
 * accent colour. Motion is opacity; no transform, no hover.
 */
const ACTION_BASE =
  'inline-flex h-[var(--tap-min)] flex-1 items-center justify-center gap-1.5 ' +
  'rounded-[var(--radius-lg)] px-3 transition-opacity duration-200 ' +
  'active:opacity-[var(--press-opacity)]';

const ACTION_TONE = {
  primary: 'bg-ink text-on-ink',
  secondary: 'bg-surface-2 text-ink',
} as const;

function ActionLink({
  href,
  tone = 'secondary',
  external = false,
  children,
}: {
  href: string;
  tone?: keyof typeof ACTION_TONE;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      // `noopener` denies the opened tab a handle on ours; `noreferrer` keeps the
      // saved-place id out of Instagram's and Naver's referrer logs.
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : null)}
      className={`${ACTION_BASE} ${ACTION_TONE[tone]}`}
      style={{ font: 'var(--type-button)' }}
    >
      {children}
    </a>
  );
}

/**
 * Copy-the-address, which is what replaces the reference's third action.
 *
 * The reference's third button is `다른방에 공유`. Gaja has groups, but this
 * account is in NONE (measured, not assumed), and `PATCH /api/saved-places/:id`
 * needs a group picker that does not exist — so that button would open an empty
 * sheet. A control that dead-ends is worse than an absent one, and the record is
 * explicit that a line with no data behind it is deleted rather than filled.
 *
 * Copying the address is the affordance both Google Maps and Naver Map put in
 * this slot, and it is the one a Korean user actually needs: the address gets
 * pasted into KakaoTalk, or into a taxi app, far more often than into a map.
 */
function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  // Held so an unmount mid-timeout cannot set state on a dead component, and so a
  // second tap restarts the window instead of stacking two timers.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // in-app browsers. Failing silently is wrong, but so is an alert: the
      // label simply never changes, so nothing false is claimed.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [address]);

  return (
    <button
      type="button"
      onClick={copy}
      className={`${ACTION_BASE} ${ACTION_TONE.secondary}`}
      style={{ font: 'var(--type-button)' }}
    >
      {/* Polite, not assertive: a confirmation is not an interruption. */}
      <span aria-live="polite">{copied ? '복사됨' : '주소복사'}</span>
    </button>
  );
}

/* ── Blocks ───────────────────────────────────────────────────────────────── */

function SectionHeading({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>{children}</h2>
      {aside}
    </div>
  );
}

/** One `라벨 / 값` pair inside the quoted block. Label secondary, value ink. */
function ClaimRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-secondary" style={{ font: 'var(--type-meta)' }}>
        {label}
      </p>
      {/* `keep-all` is set once on body and must not be re-declared here. Raw
          caption text can be long, so it wraps; it is never truncated, because a
          half-shown opening hour is a wrong opening hour. */}
      <p className="mt-0.5" style={{ font: 'var(--type-body)' }}>
        {value}
      </p>
    </div>
  );
}

function SiblingRow({ sibling }: { sibling: SiblingPlace }) {
  const category = sibling.category ? CATEGORY_KO[sibling.category] ?? sibling.category : null;
  return (
    <li>
      <Link
        href={`/saved-places/${sibling.id}`}
        className="flex items-center gap-3 px-4 py-3 transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
      >
        {/* The creator's own numbering, kept. It is how a reader matches this row
            back to the caption they are scrolling past in Instagram. Tabular
            figures so 1 and 10 sit in the same column. */}
        <span
          aria-hidden
          className="w-5 shrink-0 text-secondary tabular-nums"
          style={{ font: 'var(--type-meta)' }}
        >
          {sibling.ordinal}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate" style={{ font: 'var(--type-card-title)' }}>
            {sibling.name ?? '장소를 확인하는 중이에요'}
          </span>
          {sibling.area || category ? (
            <span className="mt-0.5 block text-secondary" style={{ font: 'var(--type-caption)' }}>
              {[sibling.area, category].filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/* ── The view ─────────────────────────────────────────────────────────────── */

export function PlaceDetail({ detail }: { detail: SavedPlaceDetail }) {
  const { saved, caption, reel, siblings } = detail;
  const place = saved.place;

  const name = place?.name ?? '장소를 확인하는 중이에요';
  const category = place?.category ? CATEGORY_KO[place.category] ?? place.category : null;
  const icon = place?.category ? CATEGORY_ICON[place.category] : undefined;

  // `places.name_alt` is Gaja's own array; the caption's single alias is the
  // creator's. Prefer ours, fall back to theirs — both are the same fact, and
  // showing two romanisations of one name on one screen reads as two venues.
  const alias = place?.name_alt?.[0] ?? caption?.name_alt ?? null;

  // The block is present only if there is something in it. A "릴스 캡션에 적힌
  // 정보" heading over nothing is the placeholder the record forbids.
  const hasClaim = Boolean(caption?.hours_raw || caption?.menu_raw);

  return (
    <article className="flex flex-col gap-[var(--section-gap)]">
      {/* ── 1. Identity ──────────────────────────────────────────────────── */}
      <header>
        <div className="flex flex-wrap items-center gap-1.5">
          {category ? (
            <Chip>
              {icon ? <Icon name={icon} size={14} /> : null}
              {category}
            </Chip>
          ) : null}
          {place?.area ? <Chip>{place.area}</Chip> : null}
          {saved.status === 'needs_review' ? <Chip tone="danger">확인 필요</Chip> : null}
        </div>

        <h1
          className="mt-3"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          {name}
        </h1>

        {/* The romanised name. Useful precisely when Korean is not: searching
            Google Maps, or typing the venue into a non-Korean keyboard. */}
        {alias ? (
          <p className="mt-1 text-secondary" style={{ font: 'var(--type-meta)' }}>
            {alias}
          </p>
        ) : null}

        {place?.address ? (
          <p className="mt-2" style={{ font: 'var(--type-body)' }}>
            {place.address}
          </p>
        ) : null}

        {/* THE VENUE'S OWN ACCOUNT, and it is NOT the reel. `원문보기` below goes
            to the creator's post; this goes to the shop. Labelling either as the
            other sends a user to the wrong place, so the label is on the link and
            the two never share a row. */}
        {caption?.handle ? (
          <a
            href={`https://www.instagram.com/${encodeURIComponent(caption.handle)}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex flex-col transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
          >
            <span className="text-secondary" style={{ font: 'var(--type-caption)' }}>
              가게 인스타그램
            </span>
            <span className="underline underline-offset-2" style={{ font: 'var(--type-body)' }}>
              @{caption.handle}
            </span>
          </a>
        ) : null}
      </header>

      {/* ── 2. Actions ───────────────────────────────────────────────────── */}
      {place || saved.source_url ? (
        <div className="flex gap-2">
          {place ? (
            <ActionLink href={naverSearchUrl(place.name, place.address)} tone="primary" external>
              장소보기
            </ActionLink>
          ) : null}
          {saved.source_url ? (
            <ActionLink href={saved.source_url} external>
              원문보기
            </ActionLink>
          ) : null}
          {place?.address ? <CopyAddressButton address={place.address} /> : null}
        </div>
      ) : null}

      {/* ── 2b. 주변 장소 찾기 ────────────────────────────────────────────── */}
      {/* ITS OWN ROW, not a fourth button in the one above. Four controls across
          a 430px canvas leaves ~92px each and `주변 장소 찾기` does not fit in
          that; more importantly it is not a peer of the three above it. Those
          three act on THIS place and resolve instantly. This one opens a
          different screen, asks a different question, and spends real money
          when the button on that screen is pressed — so it gets its own line
          and a label that says where it goes rather than what it does.

          Hidden without an `area`. The search is built around the 동
          (lib/research/nearby.ts) and a pending row has none; the route 404s in
          the same state, so this is the same decision rendered rather than a
          second one. The record's rule: a line with no data behind it is
          deleted, not disabled. */}
      {place?.area ? (
        <Link
          href={`/saved-places/${saved.id}/nearby`}
          className={`${ACTION_BASE} ${ACTION_TONE.secondary} w-full`}
          style={{ font: 'var(--type-button)' }}
        >
          주변 장소 찾기
        </Link>
      ) : null}

      {/* ── 3. The creator's claim ───────────────────────────────────────── */}
      {hasClaim ? (
        <section>
          <SectionHeading aside={<Chip>미확인</Chip>}>릴스 캡션에 적힌 정보</SectionHeading>

          <Card className="p-4">
            {/* `cite` is the post the text was lifted from. It is the correct
                attribute for this and it is also the honest one: the claim and
                its source are one element, not two. */}
            <blockquote
              cite={saved.source_url ?? undefined}
              className="m-0 flex flex-col gap-3"
            >
              {caption?.hours_raw ? <ClaimRow label="영업시간" value={caption.hours_raw} /> : null}
              {/* Menu and prices arrive in one string — `티그레 (4,200) 아메리카노
                  (4,800)` — and stay in one string. Splitting them into a price
                  list would be the same laundering the hours block refuses, and
                  `docs/gaja/reel-extraction-findings.md` notes prices are captured
                  and unmodelled precisely because nothing has validated them. */}
              {caption?.menu_raw ? <ClaimRow label="메뉴" value={caption.menu_raw} /> : null}
            </blockquote>
          </Card>

          {/* The closing note is where the empty `place_facts` table becomes
              visible. It says what we know and what we have not checked, in one
              sentence, instead of an empty 대기시간 section saying neither. */}
          <p className="mt-2 text-secondary" style={{ font: 'var(--type-caption)' }}>
            릴스를 만든 사람이 캡션에 적어 둔 내용을 그대로 옮겼어요. 가자가 확인한 정보는
            아니니 가기 전에 한 번 더 확인해 주세요.
          </p>
        </section>
      ) : null}

      {/* ── 4. Source ────────────────────────────────────────────────────── */}
      {saved.source_url ? (
        <section>
          <SectionHeading>이 장소를 알게 된 릴스</SectionHeading>

          <a
            href={saved.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="block transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
          >
            <Card className="flex items-center gap-3 p-3">
              {/* 9:16, because a reel is. `--radius-photo` is 2px: photography is
                  nearly square-cornered so it reads as a photograph rather than as
                  another piece of chrome. Falls back to a sample frame exactly as
                  the deck does — a hole where a picture belongs is worse than a
                  picture that is not this reel's. */}
              <span className="relative block h-[84px] w-[48px] shrink-0 overflow-hidden rounded-[var(--radius-photo)] bg-surface-2">
                <Image
                  src={saved.thumb_url ?? reelThumb(saved.id)}
                  alt=""
                  fill
                  sizes="48px"
                  className="object-cover"
                />
              </span>

              <span className="min-w-0 flex-1">
                {/* The caption's lead-in, verbatim — emoji and all. It is quoted
                    source text, and the record's no-emoji rule governs Gaja's own
                    copy, not a creator's words. */}
                {reel?.title ? (
                  <span className="block line-clamp-2" style={{ font: 'var(--type-card-title)' }}>
                    {reel.title}
                  </span>
                ) : null}
                <span
                  className="mt-1 block text-secondary"
                  style={{ font: 'var(--type-caption)' }}
                >
                  {caption && reel && reel.place_count > 1
                    ? `릴스가 소개한 ${reel.place_count}곳 중 ${caption.ordinal}번째 · 인스타그램에서 보기`
                    : '인스타그램에서 보기'}
                </span>
              </span>
            </Card>
          </a>
        </section>
      ) : null}

      {/* ── 5. The rest of the reel ──────────────────────────────────────── */}
      {siblings.length > 0 ? (
        <section>
          <SectionHeading>같은 릴스의 다른 {siblings.length}곳</SectionHeading>
          {/* Grouped rows on one tinted surface, split by hairlines — the record's
              alternative to giving each row its own card. `divide-y` draws the
              rule between rows only, never above the first or below the last. */}
          <Card>
            <ul className="m-0 flex list-none flex-col divide-y divide-[var(--hairline)] p-0">
              {siblings.map((s) => (
                <SiblingRow key={s.id} sibling={s} />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </article>
  );
}
