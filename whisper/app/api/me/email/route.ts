import { queryOne } from '@/lib/db';
import { withRoute } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { requireUser } from '@/lib/session';

/**
 * D3's CHECK constraint surfaced as a product rule. The user gets a sentence telling
 * them what to do, not a constraint-violation page.
 *
 * Checked in application code for the clear message; the constraint is still there as
 * the guarantee, and route.ts maps 23514 to the same problem type if a race beats this.
 */
export const DELETE = withRoute(async () => {
  const user = await requireUser();
  if (!user.igsid) throw new ProblemError('recovery-channel-required');

  await queryOne(
    `update users set email = null, email_verified_at = null where id = $1 returning id`,
    [user.id],
  );
  return new Response(null, { status: 204 }) as never;
});
