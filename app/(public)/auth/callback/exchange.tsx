'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { Card } from '@/components/surface';
import { Notice } from '@/components/states';

type State = { k: 'exchanging' } | { k: 'failed'; message: string };

export function CallbackExchange() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const next = params.get('next');

  const [failure, setFailure] = useState<string | null>(null);

  // A missing token is knowable during render, so it is derived here rather than
  // set from inside the effect — a synchronous setState in an effect body causes
  // cascading renders. Same fix as commit da188a5 in the prototype.
  const state: State = failure
    ? { k: 'failed', message: failure }
    : token
      ? { k: 'exchanging' }
      : { k: 'failed', message: '링크에 토큰이 없어요. 메일의 링크를 다시 눌러 주세요.' };

  // The token is single-use, so a second POST always fails. StrictMode double-
  // invokes effects in development, which would turn every local sign-in into
  // "link no longer valid" — this ref makes the exchange happen exactly once.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;

    apiFetch('/auth/session', { method: 'POST', body: { token } })
      .then(() => {
        // `replace`, not `push`: the callback URL holds a spent token and must
        // not be reachable with the back button.
        // Only same-origin paths are honoured — an absolute URL in `next` would
        // make this an open redirect.
        const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/saved-places';
        router.replace(dest);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError) setFailure(err.problem.detail);
        else if (err instanceof NetworkError) setFailure(err.message);
        else setFailure('알 수 없는 오류가 생겼어요.');
      });
  }, [token, next, router]);

  if (state.k === 'exchanging') {
    return (
      <Card className="p-6">
        <p role="status" aria-live="polite" className="text-sm text-ink-muted">
          로그인 중이에요…
        </p>
      </Card>
    );
  }

  return (
    <Notice
      tone="danger"
      title="로그인하지 못했어요"
      body={state.message}
      action={
        <Link href="/sign-in" className="text-sm underline underline-offset-4">
          새 링크 받기
        </Link>
      }
    />
  );
}
