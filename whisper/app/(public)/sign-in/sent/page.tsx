import type { Metadata } from 'next';
import Link from 'next/link';
import { Card } from '@/components/surface';

export const metadata: Metadata = { title: '링크를 보냈어요' };

/**
 * Terminal screen for the sign-in flow. It deliberately offers no "resend"
 * button: the API allows five requests per address per hour, and a visible
 * resend invites users to burn that budget before the first mail has landed.
 * The way back is to request a new link from the start.
 */
export default async function SentPage({ searchParams }: PageProps<'/sign-in/sent'>) {
  const { email } = await searchParams;
  const address = typeof email === 'string' ? email : null;

  return (
    <main className="flex flex-1 flex-col py-[var(--space-19)]">
      {/* Card is the tinted surface — --surface-1 at --radius-2xl, no shadow.
          Depth here would be a fourth elevation the record does not allow. */}
      <Card className="p-[var(--space-15)]">
        <h1 style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}>
          링크를 보냈어요
        </h1>

        <p className="mt-[var(--space-9)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          {address ? <span className="text-ink">{address}</span> : '입력하신 주소'}
          {' 로 로그인 링크를 보냈어요. 메일함에서 링크를 눌러 주세요.'}
        </p>

        <p className="mt-[var(--space-9)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          링크는 15분 동안만 쓸 수 있고, 한 번 누르면 만료돼요.
        </p>
      </Card>

      <Link
        href="/sign-in"
        className="mt-auto flex h-[var(--tap-min)] items-center justify-center text-secondary"
        style={{ font: 'var(--type-meta)' }}
      >
        다른 주소로 다시 받기
      </Link>
    </main>
  );
}
