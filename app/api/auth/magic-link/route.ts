import { z } from 'zod';
import { query, queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { currentUser } from '@/lib/session';
import { newToken, MAGIC_LINK_TTL_MIN } from '@/lib/tokens';
import { sendMagicLink } from '@/lib/mail';

const Body = z.object({
  email: z.string().email('Must be a valid email address.'),
  intent: z.enum(['sign_in', 'link']),
});

const MAX_PER_EMAIL_PER_HOUR = 5;

export const POST = withRoute(async (req: Request) => {
  const body = Body.parse(await req.json());
  const email = body.email.toLowerCase().trim();

  // `link` attaches a channel to an existing account, so it needs one.
  const user = await currentUser();
  if (body.intent === 'link' && !user) throw new ProblemError('unauthenticated');

  const [{ count }] = await query<{ count: string }>(
    `select count(*)::text as count from magic_links
      where email = $1 and created_at > now() - interval '1 hour'`,
    [email],
  );
  if (Number(count) >= MAX_PER_EMAIL_PER_HOUR) {
    throw new ProblemError('magic-link-rate-limited', { headers: { 'Retry-After': '900' } });
  }

  const existing = await queryOne<{ id: string }>(`select id from users where email = $1`, [email]);

  const { token, hash } = newToken('mlt');
  await queryOne(
    `insert into magic_links (token_hash, email, intent, user_id, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) returning id`,
    [hash, email, body.intent, body.intent === 'link' ? user!.id : existing?.id ?? null,
     String(MAGIC_LINK_TTL_MIN)],
  );

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  await sendMagicLink(email, `${base}/auth/callback?token=${token}`);

  // Always 202, even for an unknown address. A 404 here is an account-enumeration
  // oracle — see api-contract.md §6.1.
  return json({ status: 'sent' }, { status: 202 });
});
