import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { SignInForm } from './form';
import { SocialSignIn } from './social';

export const metadata: Metadata = { title: '로그인' };

/**
 * `next` carries the destination the visitor was bounced from, so sign-in
 * returns them where they were going instead of dumping everyone on the default
 * screen. The form reads it client-side via useSearchParams, which is why it
 * needs a Suspense boundary; the social links and the cross-link to sign-up are
 * plain hrefs, so this reads it on the server and builds them directly.
 */
export default async function SignInPage({ searchParams }: PageProps<'/sign-in'>) {
  const { next } = await searchParams;
  const dest = typeof next === 'string' ? next : null;
  const qs = dest ? `?next=${encodeURIComponent(dest)}` : '';

  return (
    <main className="flex flex-1 flex-col py-[var(--space-19)]">
      <header>
        <p
          style={{
            font: 'var(--type-section)',
            letterSpacing: 'var(--section-ls)',
          }}
        >
          Gaja
        </p>

        <h1
          className="mt-[var(--space-9)]"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          로그인
        </h1>

        <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          이메일과 비밀번호로 로그인해요. 로그인 링크를 메일로 받아도 돼요.
        </p>
      </header>

      <div className="mt-[var(--space-17)]">
        <Suspense fallback={null}>
          <SignInForm />
        </Suspense>

        <SocialSignIn next={dest} />
      </div>

      <Link
        href={`/sign-up${qs}`}
        className="mt-auto flex h-[var(--tap-min)] items-center justify-center text-secondary"
        style={{ font: 'var(--type-meta)' }}
      >
        아직 계정이 없어요
      </Link>
    </main>
  );
}
