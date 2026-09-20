import type { Metadata } from 'next';
import { requireSession } from '@/lib/require-session';
import { listSavedPlacesForUser } from '@/lib/saved-places';
import { SavedPlacesScreen } from './screen';

export const metadata: Metadata = { title: '저장한 곳' };

/**
 * 저장한 곳.
 *
 * This file is only the data boundary now: fetch on the server, hand the rows
 * to a client screen. The screen is map-first and everything interesting —
 * grouping, filtering, selection, the sheet — lives in `screen.tsx`, because all
 * of it needs the browser.
 *
 * The flat reverse-chronological list this replaced was a scaffold that said so
 * in its own comment. It grouped nothing and answered nothing: a saved place is
 * holding the question "where is this, and what else is near it", and a list
 * ordered by save date answers neither.
 *
 * Pagination is still absent and still owned elsewhere. Every row is fetched,
 * which is correct while a user has tens of places and wrong at hundreds; the
 * map is the thing that will notice first, because every row becomes a marker.
 */
export default async function SavedPlacesPage() {
  const user = await requireSession();
  const places = await listSavedPlacesForUser(user.id);

  return <SavedPlacesScreen places={places} />;
}
