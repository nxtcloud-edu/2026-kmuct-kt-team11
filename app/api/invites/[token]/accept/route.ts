import { queryOne, tx } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { currentUser } from '@/lib/session';
import { hashToken } from '@/lib/tokens';

type Ctx = { params: Promise<{ token: string }> };

/**
 * Walk through the door.
 *
 * REPAIRED FOR 20260920000010. This handler still guarded on `used_at is null`
 * and still wrote `used_by`/`used_at` — two columns that migration DROPPED. Every
 * call therefore failed with an undefined-column error that `withRoute` turned
 * into a 500, which is why the invite flow had no working ending: the API has
 * been handing out `/invite/{token}` URLs the whole time and the only route that
 * could redeem one could not run. The fix is the model the migration describes:
 * an accept never mutates the invite row, it inserts a use.
 *
 * The three failure states are separated here exactly as they are in the preview
 * (`../route.ts`), because the landing page shows one screen per state and cannot
 * tell them apart from a single `invite-invalid`. Crucially `revoked` and
 * `expired` are checked on their own columns rather than folded into the lookup
 * predicate — a `where revoked_at is null` would answer "not recognised" for a
 * link that was recognised perfectly well and simply turned off, and the remedy
 * differs ("ask for a new one" vs "check the address").
 *
 * Idempotent by construction. `group_invite_uses` has a composite primary key
 * and `group_members` is keyed on (group_id, user_id), so a double-tap or a
 * retried POST inserts nothing the second time. The explicit already-member
 * check above it is not the enforcement — it exists so the caller gets a 409
 * with a remedy ("you are already in, here is the group") instead of a silent
 * success that looks like a fresh join.
 */
export const POST = withRoute(async (_req: Request, ctx: Ctx) => {
  const { token } = await ctx.params;
  const user = await currentUser();
  const hash = hashToken(token);

  const invite = await queryOne<{
    group_id: string;
    name: string;
    member_count: number;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `select gi.group_id, g.name, gi.expires_at, gi.revoked_at,
            (select count(*)::int from group_members m where m.group_id = gi.group_id) as member_count
       from group_invites gi join groups g on g.id = gi.group_id
      where gi.token_hash = $1`,
    [hash],
  );
  if (!invite) throw new ProblemError('invite-invalid');
  if (invite.revoked_at) throw new ProblemError('invite-revoked');
  if (invite.expires_at.getTime() <= Date.now()) throw new ProblemError('invite-expired');

  if (!user) {
    // The group's name only. Enough to decide whether to hand over an email address,
    // and nothing more — nothing has been joined.
    return json({
      requires: 'recovery_channel',
      group: { id: invite.group_id, name: invite.name, member_count: invite.member_count },
    });
  }

  const already = await queryOne(
    `select user_id from group_members where group_id = $1 and user_id = $2`,
    [invite.group_id, user.id],
  );
  if (already) throw new ProblemError('invite-already-member');

  await tx(async (c) => {
    // Membership and the audit row are one fact. A crash between them would
    // either admit someone with no record of which link let them in, or record a
    // walk-through that never happened.
    await c.query(
      `insert into group_members (group_id, user_id, role) values ($1, $2, 'member')
       on conflict do nothing`,
      [invite.group_id, user.id],
    );
    await c.query(
      `insert into group_invite_uses (token_hash, user_id) values ($1, $2)
       on conflict do nothing`,
      [hash, user.id],
    );
  });

  return json({
    group: { id: invite.group_id, name: invite.name, member_count: invite.member_count + 1 },
    role: 'member',
  });
});
