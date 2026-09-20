import type { Metadata } from 'next';
import { inboxHandle, ReelGuide } from '@/components/reel-guide';
import { Content } from '@/components/surface';
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
 * page for a task nobody performs on most visits, and the 안내 below at full
 * length would be furniture there. It is reached from home in one tap.
 *
 * Home DOES now carry the 안내, but only on the cold start and only in the
 * compact form — see `ReelGuideCompact` in components/reel-guide.tsx, which is
 * a two-row summary of the section below and shares this file's source of
 * truth. A reader with a deck has done this before and gets the one-line
 * `릴스 주소로 저장하기 ›` link instead. Both variants live in one module
 * precisely so this screen stays the long form without the two drifting.
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

      <ReelGuide linked={linked} handle={inboxHandle()} />
    </Content>
  );
}
