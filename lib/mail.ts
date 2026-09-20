/**
 * Magic-link delivery.
 *
 * OPEN: no email provider is chosen yet. The marketplace decision covered Postgres
 * (Supabase) but not transactional email, so this is deliberately a single seam with
 * one implementation rather than a fake provider SDK.
 *
 * In development the link is written to the server console, which is a delivery
 * mechanism, not a stubbed provider. Before slice 1 ships to anyone, pick a provider
 * (Resend via `vercel integration add`, or Supabase's own SMTP) and implement `send`.
 *
 * PENDING — this should be a refusal, not a crash. Now that password sign-in exists,
 * an unconfigured mailer is an explainable "this route is not available yet", and the
 * throw below should be `new ProblemError('mail-unavailable')` so withRoute() renders
 * it as a problem document instead of logging an unhandled error and returning a bare
 * 500. That needs one entry added to lib/problem.ts — a file being edited elsewhere
 * when this was written, so the change was left undone rather than merged over:
 *
 *   'mail-unavailable': { status: 503, title: 'Email is not set up yet',
 *     detail: '지금은 로그인 링크를 보낼 수 없어요. 이메일과 비밀번호로 로그인해 주세요.' }
 *
 * Add the code to ProblemCode and CATALOGUE, then swap the Error below for it.
 */
export async function sendMagicLink(email: string, url: string): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n  ✉  magic link for ${email}\n     ${url}\n`);
    return;
  }
  throw new Error(
    'No email provider configured. Slice 1 cannot send magic links in production yet — ' +
      'see lib/mail.ts.',
  );
}
