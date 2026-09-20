'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { Button } from '@/components/surface';

/**
 * State ownership: `email` and `status` are local — nothing outside this form
 * reads them and neither survives a reload. The destination lives in the URL
 * (`?next=`), because it must survive the round trip through the inbox.
 */
/** Redirect reasons from the OAuth routes, mapped to something a person can act on. */
const OAUTH_ERRORS: Record<string, string> = {
  oauth_denied: '로그인이 취소되었어요.',
  oauth_failed: '로그인을 마치지 못했어요. 다시 시도해 주세요.',
  oauth_start_failed: '지금은 소셜 로그인을 시작할 수 없어요. 이메일로 로그인해 주세요.',
  oauth_unavailable: '소셜 로그인이 아직 설정되지 않았어요. 이메일로 로그인해 주세요.',
  unsupported_provider: '지원하지 않는 로그인 방식이에요.',
  email_required: '계정을 만들려면 이메일 제공에 동의해 주세요. 나중에 다시 로그인할 때 필요해요.',
};

type Status =
  | { k: 'idle' }
  | { k: 'sending' }
  | { k: 'error'; message: string; retryAfter?: number };

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  // An OAuth attempt that failed comes back as ?error=. Derived during render
  // rather than pushed into state by an effect.
  const oauthError = OAUTH_ERRORS[params.get('error') ?? ''] ?? null;

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ k: 'idle' });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.k === 'sending') return;
    setStatus({ k: 'sending' });

    try {
      await apiFetch('/auth/magic-link', {
        method: 'POST',
        body: { email, intent: 'sign_in' },
      });
      // The API answers 202 for unknown addresses too — never branch on whether
      // the account exists, or this screen becomes an enumeration oracle.
      const q = new URLSearchParams({ email });
      if (next) q.set('next', next);
      router.push(`/sign-in/sent?${q}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setStatus({
          k: 'error',
          message: err.is('magic-link-rate-limited')
            ? '링크를 너무 자주 요청했어요. 몇 분 뒤에 다시 시도해 주세요.'
            : err.problem.detail,
        });
      } else if (err instanceof NetworkError) {
        setStatus({ k: 'error', message: err.message });
      } else {
        setStatus({ k: 'error', message: '알 수 없는 오류가 생겼어요.' });
      }
    }
  }

  const message = status.k === 'error' ? status.message : oauthError;
  const invalid = message !== null;

  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor="email" className="block text-sm text-ink-muted">
        이메일
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        autoFocus
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (status.k === 'error') setStatus({ k: 'idle' });
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'email-error' : undefined}
        placeholder="you@example.com"
        className={
          'mt-2 w-full rounded-card bg-surface-1 px-4 py-3 text-base shadow-control ' +
          'transition-shadow duration-300 ease-standard placeholder:text-ink-subtle ' +
          (invalid ? 'border-l-2 border-danger' : '')
        }
      />

      {/* aria-live so the message is announced without moving focus off the field. */}
      <p id="email-error" role="status" aria-live="polite" className="mt-2 min-h-5 text-sm text-ink-muted">
        {message ?? ''}
      </p>

      <Button
        type="submit"
        variant="primary"
        className="mt-4 w-full"
        disabled={status.k === 'sending' || email.trim() === ''}
      >
        {status.k === 'sending' ? '보내는 중…' : '로그인 링크 받기'}
      </Button>
    </form>
  );
}
