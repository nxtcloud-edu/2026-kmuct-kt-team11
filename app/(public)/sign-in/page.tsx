import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignInForm } from './form';

export const metadata: Metadata = { title: '로그인' };

/**
 * `next` carries the destination the visitor was bounced from, so sign-in
 * returns them where they were going instead of dumping everyone on the
 * default screen. Read in the client component via `useSearchParams`, which
 * requires the Suspense boundary.
 */
export default function SignInPage() {
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
    </>
  );
}
