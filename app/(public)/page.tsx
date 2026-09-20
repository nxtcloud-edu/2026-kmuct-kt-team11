import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';

/**
 * Landing.
 *
 * Type-led on purpose. The source system's login screen rests on a three-panel
 * hero illustration; Gaja has no such asset, and inventing one would break the
 * content rule this design adopts — if there is nothing behind a line, there is
 * no line. So: no screenshots, no illustration, no social proof, no claim the
 * product cannot yet keep.
 */
export default async function Landing() {
  const user = await currentUser();
  if (user) redirect(user.onboarded_at ? '/home' : '/onboarding');

  return (
    <main className="flex flex-1 flex-col justify-between py-[var(--space-19)]">
      <div>
        <p
          style={{
            font: '500 var(--wordmark-size)/1.1 var(--font-display-medium), var(--font-fallback-kr)',
            letterSpacing: 'var(--wordmark-ls)',
          }}
        >
          Gaja
        </p>

        <h1
          className="mt-[var(--space-15)]"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          저장만 해두고
          <br />
          못 가본 곳들
        </h1>

        <p className="mt-[var(--space-9)] text-secondary" style={{ font: 'var(--type-body)' }}>
          인스타에서 저장한 릴스를 하루 코스로 묶어드려요
        </p>

        <ul className="mt-[var(--space-17)] flex list-none flex-col gap-[var(--space-11)] p-0">
          {[
            '릴스를 공유하면 장소를 찾아드려요',
            '영업시간과 웨이팅까지 확인해요',
            '동선에 맞춰 하루를 짜드려요',
          ].map((line) => (
            <li
              key={line}
              className="flex gap-[var(--space-8)] text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              {/* decorative only — --text-tertiary is 2.81:1 and may not carry words */}
              <span aria-hidden className="text-tertiary">
                ·
              </span>
              {line}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-[var(--space-8)]">
        <Link
          href="/sign-up"
          className="flex h-[var(--field-height)] items-center justify-center rounded-[var(--radius-lg)] bg-ink text-on-ink transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-button)' }}
        >
          시작하기
        </Link>
        <Link
          href="/sign-in"
          className="flex h-[var(--tap-min)] items-center justify-center text-secondary"
          style={{ font: 'var(--type-meta)' }}
        >
          이미 계정이 있어요
        </Link>
      </div>
    </main>
  );
}
