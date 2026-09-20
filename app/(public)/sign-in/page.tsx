import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInForm } from './form';
import { SocialSignIn } from './social';

export const metadata: Metadata = { title: '로그인' };

/**
 * `next` carries the destination the visitor was bounced from, so sign-in
 * returns them where they were going instead of dumping everyone on the default
 * screen. The form reads it client-side via useSearchParams, which is why it
 * needs a Suspense boundary; the social links are plain hrefs, so this reads it
 * on the server and builds them directly.
 */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const { next } = await searchParams;
  const dest = typeof next === 'string' ? next : null;

  return (
    <>
      <header className="mb-8">
        <p className="text-base font-medium">Gaja</p>
        <h2 className="mt-4">로그인</h2>
        <p className="mt-2 text-sm text-ink-muted">
          이메일로 로그인 링크를 보내드려요. 비밀번호는 없습니다.
        </p>
      </header>

      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>

      <SocialSignIn next={dest} />
    </>
  );
}
