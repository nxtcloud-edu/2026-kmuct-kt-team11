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
    <Card className="p-6">
      <h3>링크를 보냈어요</h3>
      <p className="mt-2 text-sm text-ink-muted">
        {address ? <span className="text-ink">{address}</span> : '입력하신 주소'}
        {' 로 로그인 링크를 보냈어요. 메일함에서 링크를 눌러 주세요.'}
      </p>
      <p className="mt-4 text-sm text-ink-muted">
        링크는 15분 동안만 쓸 수 있고, 한 번 누르면 만료돼요.
      </p>
      <Link href="/sign-in" className="mt-6 inline-block text-sm underline underline-offset-4">
        다른 주소로 다시 받기
      </Link>
    </Card>
  );
}
