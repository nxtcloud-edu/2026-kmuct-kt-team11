import { query, queryOne } from '@/lib/db';
import { withRoute, json } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { assertGroupMember } from '@/lib/saved-places';
import { newToken, INVITE_TTL_DAYS } from '@/lib/tokens';
import { withIdempotency } from '@/lib/idempotency';
import { serialiseInvite, type InviteRow } from '@/lib/invites';

type Ctx = { params: Promise<{ group_id: string }> };

/**
 * The group's issued links, with no link in any of them.
 *
 * Only `token_hash` is stored (20260918000001, and deliberately so), which means
 * this endpoint structurally cannot re-show a URL — the raw token left the
 * building in the POST response below and is not recoverable from anything we
 * kept. That is not a gap to close later: a "show the current link" endpoint
 * would require storing the token in a readable form, and a database read would
 * then hand an attacker working invites for every group.
 *
 * What it can show is everything the sharer needs in order to *manage* what they
 * have already handed out: when each link was made, when it dies, how many people
 * have walked through it, and whether it is still open. That list plus the revoke
 * control below is what makes a reusable link safe to create in the first place.
 */
export const GET = withRoute(async (_req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  await assertGroupMember(group_id, user.id);

  const rows = await query<InviteRow>(
    `select gi.id, gi.created_at, gi.expires_at, gi.revoked_at,
            gi.created_by, u.display_name as created_by_name,
            (select count(*)::int from group_invite_uses gu where gu.token_hash = gi.token_hash) as use_count,
            (select max(gu.used_at) from group_invite_uses gu where gu.token_hash = gi.token_hash) as last_used_at
       from group_invites gi
       join users u on u.id = gi.created_by
      where gi.group_id = $1
   order by gi.created_at desc
      limit 50`,
    [group_id],
  );

  return json({ data: rows.map(serialiseInvite), next_cursor: null, has_more: false });
});

/**
 * Mint a link. Any member may — unchanged from slice 1, and the reason is that a
 * group of friends has no administrator among them; the person who happens to
 * have created the group is not the person who happens to be in the 단톡방.
 *
 * Since 20260920000010 the link is reusable: the accept path no longer consumes
 * it, so one POST serves the whole room. Creating a second link does not retire
 * the first — both stay open until they expire or someone revokes them, which is
 * why GET above lists them all rather than pretending there is only ever one.
 */
export const POST = withRoute(async (req: Request, ctx: Ctx) => {
  const user = await requireUser();
  const { group_id } = await ctx.params;
  await assertGroupMember(group_id, user.id); // any member may invite

  return withIdempotency(req.headers.get('Idempotency-Key'), user.id, { group_id }, async () => {
    const { token, hash } = newToken('inv');
    const expires = new Date(Date.now() + INVITE_TTL_DAYS * 864e5);
    const row = await queryOne<{ id: string }>(
      `insert into group_invites (token_hash, group_id, created_by, expires_at)
       values ($1, $2, $3, $4) returning id`,
      [hash, group_id, user.id, expires],
    );
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    return {
      status: 201,
      body: {
        // `id` addresses the invite for revocation. It is NOT derived from the
        // token: handing out `token_hash` would let anyone holding a candidate
        // token confirm it offline.
        id: row!.id,
        token,
        url: `${base}/invite/${token}`,
        expires_at: expires.toISOString(),
      },
    };
  });
});
