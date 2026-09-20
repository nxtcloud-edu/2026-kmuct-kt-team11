import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CallbackExchange } from './exchange';

export const metadata: Metadata = { title: '로그인 중' };

/**
 * Where the magic link in the email lands — `lib/mail.ts` builds
 * `/auth/callback?token=…`, so this path is part of the mail contract.
 *
 * The exchange is a client-side POST rather than something this server
 * component does, and that is load-bearing in two ways:
 *
 *   1. A Server Component cannot set cookies, and the exchange issues the
 *      session cookie. A route handler could, but it would have to duplicate
 *      `POST /api/auth/session`, which is the documented contract.
 *   2. Corporate mail scanners and link previewers GET every URL in an email.
 *      Because consuming the token requires a POST from the loaded page, a
 *      scanner cannot burn a single-use link before the human clicks it.
 */
export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackExchange />
    </Suspense>
  );
}
