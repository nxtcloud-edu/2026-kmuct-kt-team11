import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@/components/surface';

/**
 * 릴스를 보내는 두 가지 방법 — the 안내, in two lengths, from one file.
 *
 * ── WHY ONE MODULE AND NOT TWO COMPONENTS ───────────────────────────────────
 * Two screens now tell the user how a reel gets in: `/add`, where the whole
 * screen is about it, and home's cold start, where it is a four-line aside. The
 * facts are the same facts; only the word count differs. Held in two files they
 * would drift the first time one claim changed — and the claim most likely to
 * change is the one that must never be wrong (see below). So both live here,
 * side by side, where an edit to one is impossible to make without reading the
 * other.
 *
 * ── THE ONE CLAIM NEITHER VARIANT MAY GET WRONG ─────────────────────────────
 * Read docs/gaja/instagram-binding.md before touching a word of this copy.
 * DM routing matches on `users.igsid` — the Instagram-scoped id Meta puts on a
 * signed webhook payload — and NOT on `instagram_handle`, which is a string
 * somebody typed. Onboarding collects the handle and deliberately does not write
 * `igsid`; no route in this app writes it either. So for almost every account
 * `igsid` is null, and a reel DM'd to the Gaja account would be dropped by
 * `resolveSenderToUser` as an unrecognised sender — counted, and lost.
 *
 * Both variants therefore take `linked`, which callers derive from `user.igsid`
 * and nothing else, and both say plainly that an unlinked DM does not arrive.
 * The compact variant is allowed to drop anything else on this list; it is not
 * allowed to drop that. A shorter 안내 that omits it does not read as terse, it
 * reads as a promise the pipeline will not keep.
 *
 * Every other claim is checkable against the repo:
 *   the handle          — the account reels are shared to.
 *   the routing rule    — lib/ingest/route-sender.ts, on `users.igsid`.
 *   the linking gap     — docs/gaja/instagram-binding.md; nothing writes igsid.
 *   what gets read      — lib/extract/ladder.ts: caption first, then the video's
 *                         speech and burned-in on-screen text.
 *   how long it takes   — vercel.ts: the poller's cron is `0 3 * * *`, once a
 *                         day, because a sub-daily schedule is a paid feature.
 *                         So "up to a day", not "a few minutes". The 15-minute
 *                         floor in instagram-poll.ts is a FLOOR between polls,
 *                         not a promise about when one happens.
 */

/**
 * WHICH ACCOUNT WE ARE — read from the environment, never typed here.
 *
 * This used to be `const HANDLE = '@dategaja.official'`, and it was wrong: the
 * inbox the poller actually reads belongs to `gaja.sendhere`, whose numeric id
 * is the `IG_DS_USER_ID` cookie in the same `.env`. A hardcoded handle is a
 * SECOND, INDEPENDENT DECLARATION of the account's identity sitting next to the
 * credentials that define it, and the two drifted apart silently — the copy
 * kept telling users to DM an account nobody polls, and every reel sent there
 * was lost with no error anywhere, because there is no error to raise: the
 * message arrived in a different inbox.
 *
 * Reading it from `IG_INBOX_HANDLE`, alongside `IG_SESSION_ID`/`IG_CSRF_TOKEN`/
 * `IG_DS_USER_ID`, puts the handle in the one place the account is already
 * configured, so re-pointing the poller at a different account and re-pointing
 * the 안내 are the same edit. It is deliberately NOT `NEXT_PUBLIC_` — the handle
 * is not a secret, but nothing about the polling account should be inlined into
 * a browser bundle on the strength of being harmless today.
 *
 * `/add` and home are both Server Components and both call this, then pass the
 * result down: the guide itself never reads `process.env`, so it stays safe to
 * render from anywhere.
 */
export function inboxHandle(): string {
  // A FALLBACK, not a default — a fresh clone with no `.env` still renders
  // something true today rather than an empty `@`. If this ever stops being the
  // right account it is a bug here too, which is the point of it being one line
  // next to the variable that overrides it.
  const raw = process.env.IG_INBOX_HANDLE?.trim() || 'gaja.sendhere';

  // The `@` is added at the display site, so the variable holds a bare handle.
  // Stripping a leading one anyway means `gaja.sendhere` and `@gaja.sendhere`
  // are the same configuration and neither can render `@@`.
  return raw.replace(/^@+/, '');
}

/* ── Compact: home's cold start ───────────────────────────────────────────── */

/**
 * The 안내 as a two-row table, for a screen whose subject is something else.
 *
 * ── WHY IT IS A TABLE AND NOT FOUR PARAGRAPHS ───────────────────────────────
 * The full variant below is a document: label → headline → two or three lines of
 * body, four times over, about 700px. That shape is right on `/add`, where the
 * reader arrived asking this exact question and has nothing else to do. It is
 * wrong on home, where the reader arrived asking "오늘 어디 가볼까요" and has never
 * heard of the 안내 — the Paradox of the Active User says they will not read it,
 * they will start using the app, so the guidance has to survive being skimmed at
 * a glance rather than reward being read.
 *
 * So the four blocks collapse to the two things that are actually choices — the
 * two ways in — laid out as one row each, with the answer to "how long?" parked
 * in a right-hand column so both rows answer it in the same place. What is left
 * out: 읽는 것 (what the extractor reads) entirely, and the 계정 link, both of
 * which are a tap away on `/add`. What survives is what a first-time reader
 * cannot act without: the handle, 공유 › 메시지, that a URL works too, and the
 * cost of each.
 *
 * ── DEPTH ───────────────────────────────────────────────────────────────────
 * One `Card` — a tinted surface, no border and no shadow. The record's depth
 * budget is three shadows and all three are spent (canvas, tab bar, agent
 * sheet); the two rows are separated by spacing, not a rule.
 *
 * Runs ~200px on a 430px canvas, so the 지금 하는 이벤트 heading below it stays on
 * the first screen.
 */
export function ReelGuideCompact({ linked, handle }: { linked: boolean; handle: string }) {
  return (
    <section className="mt-[var(--section-gap)]">
      <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
        릴스로 저장하는 법
      </h2>

      <Card className="mt-[var(--space-9)] flex flex-col gap-[var(--space-11)] p-[var(--space-13)]">
        {/* THE WORKING PATH, FIRST, AND IT IS THE ROW ITSELF. On the cold-start
            screen this replaces the standalone `릴스 주소로 저장하기 ›` link — two
            controls to one route, one of them inside the card explaining it, is
            a choice the reader has to make about nothing. Whole row is the tap
            target, so the label does not have to be hunted for. */}
        <Link href="/add" className="flex min-h-[var(--tap-min)] items-center">
          {/* The 44px floor is on the LINK and the baseline alignment is on the
              span inside it. Both on one element would align the row's content
              to the top of a 44px box and leave 19px of dead space under it —
              the tap target has to be able to be taller than the text without
              dragging the text to the top of it. */}
          <span className="flex w-full items-baseline justify-between gap-[var(--space-9)]">
            <span className="text-ink" style={{ font: 'var(--type-body)' }}>
              릴스 주소 붙여넣기 ›
            </span>
            <span className="shrink-0 text-secondary" style={{ font: 'var(--type-meta)' }}>
              10초
            </span>
          </span>
        </Link>

        {/* THE DM PATH, AND ITS HONEST STATE. The right column keeps answering
            the same question in both rows — for an unbound account the honest
            answer to "how long?" is "it does not arrive", so that is what it
            says, and the line under it says why. */}
        <div>
          <div className="flex items-baseline justify-between gap-[var(--space-9)]">
            <span className="text-ink" style={{ font: 'var(--type-body)' }}>
              {`@${handle}`}
            </span>
            <span className="shrink-0 text-secondary" style={{ font: 'var(--type-meta)' }}>
              {linked ? '하루에 한 번' : '아이디 먼저'}
            </span>
          </div>
          <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-meta)' }}>
            {linked
              ? '인스타그램에서 릴스를 열고 공유 › 메시지로 보내면 돼요.'
              : '계정에 인스타그램 아이디를 적어두면, 그 아이디로 보낸 릴스부터 저장돼요.'}
          </p>
        </div>
      </Card>
    </section>
  );
}

/* ── Full: the 릴스 저장 screen ────────────────────────────────────────────── */

/**
 * 인스타그램에서 바로 보내기 — the DM path, described as it actually behaves today.
 *
 * The long form, unchanged: on `/add` there is nothing above it competing for
 * the reader, so the extra two blocks (읽는 것, 걸리는 시간) and the 계정 link are
 * worth their height. This is the variant the compact one is a summary OF — if a
 * fact changes, it changes here first and then above.
 */
export function ReelGuide({ linked, handle }: { linked: boolean; handle: string }) {
  return (
    <section className="mt-[var(--section-gap)]">
      <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
        인스타그램에서 바로 보내기
      </h2>

      <Card className="mt-[var(--space-9)] flex flex-col gap-[var(--space-13)] p-[var(--space-13)]">
        <Item term="보내는 곳">
          <p style={{ font: 'var(--type-body)' }}>{`@${handle}`}</p>
          <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-meta)' }}>
            인스타그램에서 릴스를 열고 공유 › 메시지로 이 계정에 보내면 돼요.
          </p>
        </Item>

        {/* THE HONEST PART, and the reason this section exists at all. */}
        {linked ? (
          <Item term="지금 상태">
            <p style={{ font: 'var(--type-body)' }}>이 계정은 인스타그램과 연결돼 있어요.</p>
            <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-meta)' }}>
              보낸 릴스는 하루에 한 번 모아서 가져와요. 다음 날 보일 수도 있어요. 바로 저장하려면 위에
              주소를 붙여넣어 주세요.
            </p>
          </Item>
        ) : (
          <Item term="지금 상태">
            <p style={{ font: 'var(--type-body)' }}>아직 이 계정은 인스타그램과 연결되지 않았어요.</p>
            <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-meta)' }}>
              지금 메시지로 릴스를 보내면 누가 보낸 건지 알 수 없어서 저장되지 않아요. 계정에
              인스타그램 아이디를 적어두면, 그 아이디로 보낸 릴스부터 자동으로 저장돼요. 아이디를
              적기 전에 보낸 릴스는 다시 보내 주세요.
            </p>
            {/* THIS COPY USED TO SAY 연결은 가자에서 직접 해드려야 해서, and that is
                no longer true: typing the handle IS the connection now. A DM
                from an account whose username matches a claimed
                `instagram_handle` binds `igsid` on arrival. Copy that tells a
                user not to bother is worse than no copy — they read it and stop.

                It still does not promise the reel they ALREADY sent will
                appear. Binding happens when a clip arrives, and a clip that was
                dropped before the claim existed is not replayed, so the last
                sentence asks for a re-send rather than leaving them waiting on
                something that is never coming. */}
            <Link
              href="/account"
              className="mt-[var(--space-8)] inline-flex min-h-[var(--tap-min)] items-center text-ink"
              style={{ font: 'var(--type-meta)' }}
            >
              계정에 인스타그램 아이디 적어두기 ›
            </Link>
          </Item>
        )}

        <Item term="읽는 것">
          <p style={{ font: 'var(--type-body)' }}>캡션을 먼저 읽어요.</p>
          <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-meta)' }}>
            캡션에서 가게를 찾지 못하면 영상 속 말과 화면에 뜬 글자까지 읽어요. 그래도 가게 이름이 어디에도
            나오지 않으면 찾지 못해요. 가게 이름과 주소가 캡션에 적힌 릴스가 가장 잘 돼요.
          </p>
        </Item>

        <Item term="걸리는 시간">
          <p style={{ font: 'var(--type-body)' }}>주소를 붙여넣으면 10초 안팎이에요.</p>
          <p className="mt-[var(--space-3)] text-secondary" style={{ font: 'var(--type-meta)' }}>
            메시지로 보낸 릴스는 하루에 한 번 모아서 가져와요.
          </p>
        </Item>
      </Card>
    </section>
  );
}

/**
 * A labelled block. The label is `caption` on `secondary` (5.11:1 on surface-1)
 * and the value is `body` in `ink` — hierarchy from size and the text tier,
 * which is all this system has: there is no accent colour to spend on a heading.
 */
function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        {term}
      </p>
      <div className="mt-[var(--space-5)]">{children}</div>
    </div>
  );
}
