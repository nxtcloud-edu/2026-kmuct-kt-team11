import { queryOne } from '@/lib/db';
import { withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { assertGroupMember } from '@/lib/saved-places';
import { newToken, INVITE_TTL_DAYS } from '@/lib/tokens';
import { withIdempotency } from '@/lib/idempotency';

type Ctx = { params: Promise<{ group_id: string }> };

export const POST = withRoute(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  await assertGroupMember(group_id, user.id); // any member may invite

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, { group_id }, async () => {
    const { token, hash } = newToken('inv');
    const expires = new Date(Date.now() + INVITE_TTL_DAYS * 864e5);
    await queryOne(
      `insert into group_invites (token_hash, group_id, created_by, expires_at)
       values ($1, $2, $3, $4) returning token_hash`,
      [hash, group_id, user.id, expires],
    );
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    return {
      status: 201,
      body: { token, url: `${base}/invite/${token}`, expires_at: expires.toISOString() },
    };
  });
});
