import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';

/**
 * `/` is a router, not a screen. Gaja has no marketing site in slice 1 — the
 * product is reached from an Instagram DM — so a landing page here would be a
 * page nobody asked for standing between the user and their saved places.
 *
 * When marketing does exist it replaces this file, and the signed-in redirect
 * moves into it as a conditional.
 */
export default async function Root() {
  redirect((await currentUser()) ? '/saved-places' : '/sign-in');
}
