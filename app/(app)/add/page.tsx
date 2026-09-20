import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, Content } from '@/components/surface';
import { requireSession } from '@/lib/require-session';
import { PasteForm } from './paste-form';

export const metadata: Metadata = { title: '릴스 저장' };

/**
 * 릴스 저장 — the two ways a reel gets into Gaja, and the honest state of each.
 *
 * ── WHY ITS OWN ROUTE, AND NOT A CARD ON HOME ───────────────────────────────
 * Home answers "오늘 어디 가볼까요" with places the user already kept. This screen
 * is the opposite motion — putting something IN — and it is the only screen in
 * the app that is. Parking a text field on home would push the deck down the
 * page for a task nobody performs on most visits, and the 안내 below is four
 * paragraphs that would be furniture there. It is reached from home in one tap;
 * the link is one line and is documented in the handover note.
 *
 * ── WHY NOT THE TAB BAR ─────────────────────────────────────────────────────
 * components/tab-bar.tsx says five is the ceiling and says why: at 430px minus
 * two gutters a sixth pill drops below the label width that fits 저장한 곳 on one
 * line. That constraint is not negotiable for a screen used occasionally.
 *
 * ── WHY THE 안내 IS HERE AND NOT IN 계정 ────────────────────────────────────
 * It was the obvious alternative — 계정 already holds `InstagramCard`, where the
 * handle is typed. It is the wrong home for this, because the honest version of
 * the 안내 is a COMPARISON: "the paste field works now; the DM does not work for
 * you yet". That sentence only makes sense beside the field it is comparing
 * against. Splitting them would put the explanation of the broken path in
 * settings and the working path somewhere else, which is how a user concludes
 * the DM must work and wonders why their reel never arrived. The handle FIELD
 * stays in 계정, where it belongs, and this screen links to it.
 *
 * ── THE 안내 IS NOT ALLOWED TO PROMISE THE DM PATH ──────────────────────────
 * Read docs/gaja/instagram-binding.md before touching a word of the copy below.
 * DM routing matches on `users.igsid` — the Instagram-scoped id Meta puts on a
 * signed webhook payload — and NOT on `instagram_handle`, which is a string
 * somebody typed. Onboarding collects the handle and deliberately does not write
 * `igsid`; no route in this app writes it either. So for almost every account
 * `igsid` is null, and a reel DM'd to the Gaja account would be dropped by
 * `resolveSenderToUser` as an unrecognised sender — counted, and lost.
 *
 * The copy therefore branches on `user.igsid`, which is the same value
 * `instagram_linked` is derived from and the only thing in this schema that can
 * answer the question truthfully. An unbound account is told, in so many words,
 * that a DM will not arrive and that someone at Gaja has to link it first. The
 * tempting version — "인스타그램으로 릴스를 보내보세요!" for everyone — would be a
 * feature announcement for something that silently does nothing.
 */
export default async function AddReelPage() {
  const user = await requireSession();

  // `igsid`, not `instagram_handle`. The handle is a claim and routes nothing;
  // this is the binding. Same derivation `toMe()` uses for `instagram_linked`.
  const linked = user.igsid !== null;

  return (
    <Content>
      <header className="mb-[var(--space-13)]">
        <span
          className="inline-flex items-center rounded-[var(--radius-sm)] bg-surface-1 px-[var(--space-7)] py-[var(--space-3)] text-secondary"
          style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
        >
          릴스 저장
        </span>

        <h1
          className="mt-[var(--space-11)]"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          릴스 주소를 붙여넣어 주세요
        </h1>
        <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-body)' }}>
          릴스 캡션에 적힌 가게를 찾아서 저장한 곳에 담아둘게요.
        </p>
      </header>

      <PasteForm />

      <Guide linked={linked} />
    </Content>
  );
}

/**
 * 인스타그램에서 바로 보내기 — the DM path, described as it actually behaves today.
 *
 * Every claim here is checkable against the repo:
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
function Guide({ linked }: { linked: boolean }) {
  return (
    <section className="mt-[var(--section-gap)]">
      <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
        인스타그램에서 바로 보내기
      </h2>

      <Card className="mt-[var(--space-9)] flex flex-col gap-[var(--space-13)] p-[var(--space-13)]">
        <Item term="보내는 곳">
          <p style={{ font: 'var(--type-body)' }}>@dategaja.official</p>
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
              지금 메시지로 릴스를 보내면 누가 보낸 건지 알 수 없어서 저장되지 않아요. 연결은 가자에서
              직접 해드려야 해서, 그때까지는 위에 주소를 붙여넣는 방법만 쓸 수 있어요.
            </p>
            {/* The handle is worth typing anyway — it is what a future linking
                step looks the account up by. The copy says exactly what
                instagram-card.tsx says so the two screens cannot promise
                different things about the same field. */}
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
 * A labelled block. The label is `meta` on `secondary` (5.11:1 on surface-1) and
 * the value is `body` in `ink` — hierarchy from size and the text tier, which is
 * all this system has: there is no accent colour to spend on a heading.
 */
function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        {term}
      </p>
      <div className="mt-[var(--space-5)]">{children}</div>
    </div>
  );
}
