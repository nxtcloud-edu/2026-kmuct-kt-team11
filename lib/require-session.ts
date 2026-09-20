import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { currentUser, type SessionUser } from './session';

/**
 * The session guard for Server Components.
 *
 * Use this, not `requireUser()`, anywhere under `app/(app)/`. Next renders a
 * layout and its page concurrently, so a page's own guard runs even on requests
 * the layout is already redirecting. `requireUser()` throws a ProblemError to do
 * that job — correct for a route handler, but in a page it logs an error and
 * arms the error boundary on every signed-out request, and the only reason the
 * user does not see it is that the layout's redirect wins the race.
 *
 * `redirect()` is control flow rather than failure, so the same guard in both
 * places is silent and the race has no wrong outcome.
 *
 * `x-gaja-pathname` comes from `proxy.ts`; without it there is no way to learn
 * the URL being rendered, and sign-in would lose the user's destination.
 */
export async function requireSession(): Promise<SessionUser> {
  const user = await currentUser();
  if (user) return user;

  const path = (await headers()).get('x-gaja-pathname');
  const next = path?.startsWith('/') ? `?next=${encodeURIComponent(path)}` : '';
  redirect(`/sign-in${next}`);
}
