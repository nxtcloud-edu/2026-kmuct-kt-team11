import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/require-session';

/**
 * Its own route group, not part of (app): onboarding needs a session but must
 * NOT sit behind the onboarding gate, which would redirect it to itself forever.
 *
 * It also gets no tab bar. There is nowhere else to go until this is finished,
 * and a nav that advertises three destinations you cannot reach is furniture.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  if (user.onboarded_at) redirect('/home');
  return <div className="flex min-h-dvh flex-col px-[var(--gutter)]">{children}</div>;
}
