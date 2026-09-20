import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { SignUpForm } from './form';
import { SocialSignIn } from '../sign-in/social';

export const metadata: Metadata = { title: '회원가입' };

/**
 * The second of two doors onto one endpoint. `next` carries the destination the
 * visitor was bounced from, so it has to survive this screen too — the form
 * reads it client-side via useSearchParams, which is why it needs a Suspense
 * boundary, while the social links and the cross-link to sign-in are plain
 * hrefs and are built here on the server.
 */
export default async function SignUpPage({ searchParams }: PageProps<'/sign-up'>) {
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
          회원가입
        </h1>

        <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          이메일과 비밀번호로 가입해요. 가입 링크를 메일로 받아도 돼요.
        </p>
      </header>

      <div className="mt-[var(--space-17)]">
        <Suspense fallback={null}>
          <SignUpForm />
        </Suspense>

        {/* --text-secondary, not --text-tertiary: tertiary measures 2.81:1 and
            may not carry words a user has to read. */}
        <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          가입하면 이용약관과 개인정보처리방침에 동의하는 것으로 봐요
        </p>

        <SocialSignIn next={dest} />
      </div>

      <Link
        href={`/sign-in${qs}`}
        className="mt-auto flex h-[var(--tap-min)] items-center justify-center text-secondary"
        style={{ font: 'var(--type-meta)' }}
      >
        이미 계정이 있어요
      </Link>
    </main>
  );
}
