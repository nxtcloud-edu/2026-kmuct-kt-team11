import type { Metadata } from 'next';
import { requireSession } from '@/lib/require-session';
import { OnboardingSteps } from './steps';

export const metadata: Metadata = { title: '시작하기' };

/**
 * The layout has already established that this user exists and has not finished
 * onboarding. This page only seeds the first step with whatever name the account
 * was born with — for an email sign-up that is the address's local part, which
 * is a poor thing to be called in a group and is exactly what step 1 fixes.
 */
export default async function OnboardingPage() {
  const user = await requireSession();
  return <OnboardingSteps initialName={user.display_name} />;
}
