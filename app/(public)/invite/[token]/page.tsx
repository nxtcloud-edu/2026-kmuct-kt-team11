import type { Metadata } from 'next';
import { InviteAccept } from './invite-accept';

export const metadata: Metadata = { title: '그룹 초대' };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="flex flex-1 flex-col justify-center py-[var(--space-19)]">
      <header>
        <p style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>Gaja</p>
        <h1
          className="mt-[var(--space-9)]"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          그룹 초대가 왔어요
        </h1>
        <p className="mt-[var(--space-8)] text-secondary">
          참여하면 함께 저장한 장소로 모두의 취향을 반영한 코스를 만들 수 있어요.
        </p>
      </header>
      <InviteAccept token={token} />
    </main>
  );
}
