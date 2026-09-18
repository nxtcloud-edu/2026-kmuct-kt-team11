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
