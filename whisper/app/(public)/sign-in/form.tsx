'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import type { Me } from '@/lib/api/types';
import { Button } from '@/components/surface';

/**
 * State ownership: `email`, `password`, `reveal` and `status` are local —
 * nothing outside this form reads them and none of them survives a reload. The
 * destination lives in the URL (`?next=`), because it must survive the round
 * trip through the inbox on the magic-link path.
 *
 * Two ways in, one form. The password submit is the primary action; the magic
 * link stays below it as the secondary way in, separated by the same hairline
 * rule social sign-in uses. Password does not replace the link — an address
 * with no password set still needs the inbox.
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

/** Which field the message is about. 'form' tints both — the server told us the
 *  pair is wrong, not which half of it. */
type ErrorField = 'email' | 'password' | 'form';

type Status =
  | { k: 'idle' }
  | { k: 'sending' } // magic link in flight
  | { k: 'signing-in' } // password in flight
  | { k: 'error'; message: string; field: ErrorField; retryAfter?: number };

/**
 * Problem type → Korean the user can act on. Branches on `err.is(code)`, which
 * is the stable half of the contract; `detail` is only ever read as a string to
 * show, never as something to test.
 *
 * `invalid-credentials` stays deliberately vague about which half was wrong:
 * naming the email would turn this screen into an account-enumeration oracle,
 * the same reason the magic-link path answers 202 for unknown addresses.
 */
function toError(err: unknown): Extract<Status, { k: 'error' }> {
  if (err instanceof ApiError) {
    if (err.is('invalid-credentials')) {
      return { k: 'error', message: '이메일 또는 비밀번호가 맞지 않아요', field: 'form' };
    }
    if (err.is('login-rate-limited')) {
      return {
        k: 'error',
        message: '로그인 시도가 너무 많아요. 잠시 후 다시 시도해 주세요',
        field: 'form',
      };
    }
    if (err.is('email-already-linked')) {
      return { k: 'error', message: '이미 가입된 이메일이에요. 로그인해 주세요', field: 'email' };
    }
    if (err.is('validation-error')) {
      // 422 carries per-field messages; show the first one on its own field so
      // the tinted fill points at what to fix.
      const first = err.problem.errors?.[0];
      return {
        k: 'error',
        message: first?.message ?? err.problem.detail,
        field: first?.field === 'password' ? 'password' : 'email',
      };
    }
    if (err.is('magic-link-rate-limited')) {
      return {
        k: 'error',
        message: '링크를 너무 자주 요청했어요. 몇 분 뒤에 다시 시도해 주세요.',
        field: 'email',
      };
    }
    return { k: 'error', message: err.problem.detail, field: 'form' };
  }
  if (err instanceof NetworkError) {
    return { k: 'error', message: err.message, field: 'form' };
  }
  return { k: 'error', message: '알 수 없는 오류가 생겼어요.', field: 'form' };
}

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');

  // An OAuth attempt that failed comes back as ?error=. Derived during render
  // rather than pushed into state by an effect.
  const oauthError = OAUTH_ERRORS[params.get('error') ?? ''] ?? null;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<Status>({ k: 'idle' });

  const busy = status.k === 'sending' || status.k === 'signing-in';

  /** Any keystroke retires the message: it described a request that no longer
   *  matches what is in the fields. */
  function clearError() {
    if (status.k === 'error') setStatus({ k: 'idle' });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setStatus({ k: 'signing-in' });

    try {
      await apiFetch<Me>('/auth/password', {
        method: 'POST',
        body: { email, password, intent: 'sign_in' },
      });
      // Same guard as the magic-link callback (auth/callback/exchange.tsx):
      // only same-origin paths are honoured. An absolute URL in `next` would
      // make this an open redirect that launders an attacker's destination
      // through a trusted domain, and `//evil.com` is the protocol-relative
      // case a naive startsWith('/') check waves through. Do not simplify this
      // to a truthiness test.
      const dest = next && next.startsWith('/') && !next.startsWith('//') ? next : '/home';
      // replace, not push: a back gesture should not land on a form the session
      // has already moved past. The refresh is load-bearing — the (app) gate
      // reads onboarded_at from a fresh server render, and the cached RSC
      // payload from before the cookie existed bounces the user straight back.
      router.replace(dest);
      router.refresh();
    } catch (err) {
      setStatus(toError(err));
    }
  }

  async function onMagicLink() {
    if (busy) return;
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
      setStatus(toError(err));
    }
  }

  // Derived during render, never pushed into state by an effect: a failed OAuth
  // redirect and a failed submit feed one message slot, and only one of them can
  // be in state at a time.
  const error =
    status.k === 'error'
      ? { message: status.message, field: status.field }
      : oauthError
        ? { message: oauthError, field: 'email' as ErrorField }
        : null;

  const emailInvalid = error !== null && (error.field === 'email' || error.field === 'form');
  const passwordInvalid = error !== null && (error.field === 'password' || error.field === 'form');
  const describedBy = error !== null ? 'auth-error' : undefined;

  // No ring, no border, no shadow: the field is a filled surface, and the
  // invalid state swaps that fill rather than drawing a red rule on top.
  const field =
    'h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] ' +
    'px-[var(--space-11)] transition-colors duration-200 ';

  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor="email" className="block text-secondary" style={{ font: 'var(--type-meta)' }}>
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
          clearError();
        }}
        aria-invalid={emailInvalid || undefined}
        aria-describedby={describedBy}
        placeholder="you@example.com"
        style={{ font: 'var(--type-body)' }}
        className={
          'mt-[var(--space-8)] ' + field + (emailInvalid ? 'bg-[var(--status-cancel-bg)]' : 'bg-surface-1')
        }
      />

      <label
        htmlFor="password"
        className="mt-[var(--space-13)] block text-secondary"
        style={{ font: 'var(--type-meta)' }}
      >
        비밀번호
      </label>
      {/* The reveal toggle sits inside the field, so the input reserves room for
          it on the right rather than letting a long value run underneath. */}
      <div className="relative mt-[var(--space-8)]">
        <input
          id="password"
          name="password"
          type={reveal ? 'text' : 'password'}
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            clearError();
          }}
          aria-invalid={passwordInvalid || undefined}
          aria-describedby={describedBy}
          style={{ font: 'var(--type-body)' }}
          className={
            field +
            'pr-[calc(var(--space-19)+var(--space-13))] ' +
            (passwordInvalid ? 'bg-[var(--status-cancel-bg)]' : 'bg-surface-1')
          }
        />
        {/* type="button": inside a form, a bare <button> submits, and revealing
            the value must never post it. */}
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? '비밀번호 숨기기' : '비밀번호 표시'}
          className="absolute right-[var(--space-5)] top-1/2 flex h-[var(--tap-min)]
                     -translate-y-1/2 items-center rounded-[var(--radius-lg)]
                     px-[var(--space-7)] text-secondary transition-opacity duration-200
                     active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-caption)' }}
        >
          {reveal ? '숨기기' : '표시'}
        </button>
      </div>

      {/* aria-live so the message is announced without moving focus off the field. */}
      <p
        id="auth-error"
        role="status"
        aria-live="polite"
        className="mt-[var(--space-7)] min-h-[var(--caption-lh)] text-secondary"
        style={{ font: 'var(--type-caption)' }}
      >
        {error?.message ?? ''}
      </p>

      <Button
        type="submit"
        variant="primary"
        className="mt-[var(--space-9)] w-full"
        disabled={busy || email.trim() === '' || password === ''}
      >
        {status.k === 'signing-in' ? '로그인 중…' : '로그인'}
      </Button>

      {/* Same rule-and-label separator social sign-in uses: the magic link is a
          second way in, not a fallback for a failed password. */}
      <div
        className="mt-[var(--space-15)] flex items-center gap-[var(--space-9)]"
        aria-hidden
      >
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-secondary" style={{ font: 'var(--type-caption)' }}>
          또는
        </span>
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <Button
        type="button"
        variant="secondary"
        onClick={onMagicLink}
        className="mt-[var(--space-11)] w-full"
        disabled={busy || email.trim() === ''}
      >
        {status.k === 'sending' ? '보내는 중…' : '로그인 링크 받기'}
      </Button>
    </form>
  );
}
