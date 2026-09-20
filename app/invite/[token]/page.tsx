import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, buttonClassName } from '@/components/surface';
import { Notice } from '@/components/states';
import { currentUser } from '@/lib/session';
import { previewInvite } from '@/lib/invites';
import { JoinButton } from './join';

export const metadata: Metadata = {
  title: '초대',
  // A link pasted into a 단톡방 should not become a search result, and the token
  // is in the path.
  robots: { index: false, follow: false },
};

/**
 * The joiner's landing page.
 *
 * THIS ROUTE DID NOT EXIST. `POST /api/groups/{id}/invites` has been returning
 * `${NEXT_PUBLIC_APP_URL}/invite/${token}` since the day it was written, so
 * every link the product has ever minted pointed at a 404. Nothing else in the
 * invite feature could work without it.
 *
 * FIVE STATES, and they are five screens rather than one error with five
 * sentences, because the remedies differ:
 *
 *   live, signed in      → the decision: what you get, then one button.
 *   live, signed out     → the same decision, then sign in. THE TOKEN SURVIVES:
 *                          it is in this page's own path, and the sign-in links
 *                          carry `?next=` back to here. Nothing is stored, so
 *                          nothing can be dropped.
 *   already a member     → not an error. A way in, not a request for a new link.
 *   expired / revoked    → distinct, because "ask for a new link" and "ask
 *                          someone in the group" are different asks, and a
 *                          revoked link may never be re-issued to this person.
 *   not recognised       → a typo or a truncated paste, which is a thing the
 *                          reader can actually fix.
 *
 * Signed out, this page names the group. That is the disclosure the sharer made
 * when they sent the link; an expired or revoked token names nothing, because
 * the decision to stop sharing has already been taken.
 */
export default async function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  const { token } = await params;
  const user = await currentUser();
  const preview = await previewInvite(token, user?.id ?? null);

  // `?next=` is the same mechanism `requireSession` uses to bounce a signed-out
  // visitor and return them afterwards, so sign-in and sign-up both land back
  // on this exact token.
  const back = `/invite/${encodeURIComponent(token)}`;
  const qs = `?next=${encodeURIComponent(back)}`;

  if (preview.state !== 'live') {
    const copy = {
      invalid: {
        title: '초대 링크를 찾을 수 없어요',
        body: '주소가 잘리지 않았는지 확인해 주세요. 링크 전체를 다시 받아서 열면 돼요.',
      },
      expired: {
        title: '초대 링크가 만료됐어요',
        body: '초대 링크는 만든 날부터 7일 동안만 쓸 수 있어요. 초대해 준 사람에게 새 링크를 받아 주세요.',
      },
      revoked: {
        title: '더 이상 쓸 수 없는 링크예요',
        body: '이 링크는 그룹에서 사용을 중지했어요. 그룹 멤버에게 새 링크를 요청해 주세요.',
      },
    }[preview.state];

    return (
      <Shell>
        <Notice title={copy.title} body={copy.body} />
        <div className="mt-[var(--space-13)]">
          <Link
            href={user ? '/groups' : '/'}
            className={`${buttonClassName('quiet')} w-full`}
            style={{ font: 'var(--type-button)' }}
          >
            {user ? '내 그룹으로' : 'Gaja 둘러보기'}
          </Link>
        </div>
      </Shell>
    );
  }

  const { group } = preview;

  if (preview.already_member) {
    return (
      <Shell>
        <Notice
          title="이미 이 그룹의 멤버예요"
          body={`${group.name}에는 이미 들어와 있어요. 새로 참여하지 않아도 돼요.`}
        />
        <div className="mt-[var(--space-13)]">
          <Link
            href={`/groups/${group.id}`}
            className={`${buttonClassName('primary')} w-full`}
            style={{ font: 'var(--type-button)' }}
          >
            {group.name} 열기
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="text-secondary" style={{ font: 'var(--type-meta)' }}>
        그룹 초대
      </p>
      <h1
        className="mt-[var(--space-7)] [overflow-wrap:anywhere]"
        style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
      >
        {group.name}
      </h1>
      <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-meta)' }}>
        멤버 <span className="tabular-nums">{group.member_count}</span>명
        {group.place_count > 0 ? (
          <>
            {' · '}저장한 곳 <span className="tabular-nums">{group.place_count}</span>곳
          </>
        ) : null}
      </p>

      {/* Access scope BEFORE the confirm. Law of Common Region: the grant is one
          bounded block, so it reads as the terms of this one decision rather
          than as page furniture. */}
      <Card className="mt-[var(--space-15)] p-[var(--space-13)]">
        <p style={{ font: 'var(--type-card-title)' }}>참여하면 할 수 있는 것</p>
        <ul
          className="mt-[var(--space-7)] flex list-none flex-col gap-[var(--space-4)] p-0 text-secondary"
          style={{ font: 'var(--type-meta)' }}
        >
          <li>이 그룹에 저장한 곳과 멤버 이름을 볼 수 있어요</li>
          <li>이 그룹에 장소를 추가하고, 다른 사람을 초대할 수 있어요</li>
          <li>내가 개인적으로 저장한 곳은 그룹에 공개되지 않아요</li>
        </ul>
        <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          멤버로 참여해요. 언제든 그룹 화면에서 나갈 수 있어요.
        </p>
      </Card>

      <div className="mt-[var(--space-15)]">
        {user ? (
          <JoinButton token={token} groupId={group.id} groupName={group.name} />
        ) : (
          <>
            <Link
              href={`/sign-up${qs}`}
              className={`${buttonClassName('primary')} w-full`}
              style={{ font: 'var(--type-button)' }}
            >
              가입하고 참여하기
            </Link>
            <Link
              href={`/sign-in${qs}`}
              className={`${buttonClassName('secondary')} mt-[var(--space-7)] w-full`}
              style={{ font: 'var(--type-button)' }}
            >
              로그인하고 참여하기
            </Link>
            <p
              className="mt-[var(--space-9)] text-secondary"
              style={{ font: 'var(--type-caption)' }}
            >
              로그인하면 이 화면으로 돌아와 바로 참여할 수 있어요.
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}

/**
 * This route sits outside `(app)` and `(public)` on purpose: it has no tab bar
 * (there may be no session) and no sign-in chrome (there may be one). Only the
 * root layout's phone canvas wraps it, so the gutter is set here.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col justify-center px-[var(--gutter)] py-[var(--space-19)]">
      {children}
    </main>
  );
}
