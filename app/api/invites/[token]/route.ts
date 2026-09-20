import { withRoute, json } from '@/lib/route';
import { ProblemError } from '@/lib/problem';
import { currentUser } from '@/lib/session';
import { previewInvite } from '@/lib/invites';

type Ctx = { params: Promise<{ token: string }> };

/**
 * Look before you join.
 *
 * `/invite/{token}` needs to render a decision — this group, these many people,
 * this is what you will be able to see — and the accept endpoint cannot serve
 * that, because for a signed-in caller accepting IS joining. A preview with no
 * side effect is the only way the landing page can show an access-scope summary
 * *before* the confirm rather than after it.
 *
 * Unauthenticated on purpose: the whole point of the flow is that a friend opens
 * this link before they have an account. The token is the credential.
 *
 * The predicate moved to `lib/invites.ts` when the landing page was built. That
 * page is a Server Component and reads Postgres directly rather than fetching
 * this handler, so leaving the query here would have meant two definitions of
 * "is this link still open" — the exact fork `serialiseInvite` exists to
 * prevent. This route now owns only the mapping from state to problem document,
 * which is the part that is HTTP's business; what is and is not disclosed for
 * each state is documented on `previewInvite`.
 */
export const GET = withRoute(async (_req: Request, ctx: Ctx) => {
  const { token } = await ctx.params;
  const user = await currentUser();

  const preview = await previewInvite(token, user?.id ?? null);
  if (preview.state !== 'live') {
    // One map, three codes. `detail` differs per code in the catalogue and each
    // one carries a different remedy — see lib/problem.ts.
    throw new ProblemError(
      ({ invalid: 'invite-invalid', revoked: 'invite-revoked', expired: 'invite-expired' } as const)[
        preview.state
      ],
    );
  }

  return json({
    group: preview.group,
    expires_at: preview.expires_at,
    // Drives the "you are already in here" branch on the landing page, which is
    // a different screen from an error: the remedy is a link into the group, not
    // a request for a new invite.
    already_member: preview.already_member,
    // Every invite grants the same thing. The schema's `owner` role is held by
    // exactly one person per group and is enforced by a partial unique index
    // (`group_members_one_owner_idx`), so there is no role for an invite to
    // choose between — see the note in the accept route.
    grants: 'member' as const,
  });
});
