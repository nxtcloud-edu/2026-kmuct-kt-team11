import { redirect } from 'next/navigation';

import { requireSession } from '@/lib/require-session';
import { TabBarShell } from '@/components/tab-bar';
import { AgentButton } from '@/components/agent-button';

/**
 * The auth gate for every signed-in route.
 *
 * It lives here, in the layout, rather than in `proxy.ts`. Gaja's session is an
 * opaque token that has to be checked against Postgres, and Proxy runs on every
 * request including prefetches — the Next docs are explicit that it must not do
 * database work and must not be the authorization boundary. Putting the check
 * next to the data it protects also means a new route under `(app)/` is gated by
 * existing, not by remembering to add it to a matcher.
 *
 * Pages under here call `requireSession()` too. That is not redundant: layouts
 * and pages render concurrently, so a page must be able to stand on its own.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  // Onboarding is not optional-but-skippable at the route level: every step
  // inside it can be skipped, but the flow itself runs once before the app.
  if (!user.onboarded_at) redirect('/onboarding');

  // The assistant is mounted here, beside the tab bar, for the same reason the
  // bar is: it is chrome for every signed-in route, and a new route under
  // `(app)/` should get it by existing rather than by remembering to add it.
  //
  // Only two fields cross into the client, both already public to this user:
  // their own MBTI pick and their own display name. The session itself never
  // does — the agent route re-reads it server-side from the cookie, so nothing
  // here is trusted as identity.
  // It is a sibling of the shell rather than a child of it: `TabBarShell` puts
  // its children inside `<main>`, and the assistant is chrome, not the page's
  // main content. Both are fixed, so the DOM order costs no layout.
  return (
    <>
      <TabBarShell>{children}</TabBarShell>
      <AgentButton mbti={user.mbti} displayName={user.display_name} />
    </>
  );
}
