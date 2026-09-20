import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content } from '@/components/surface';
import { PlaceDetail } from '@/components/place-detail';
import { requireSession } from '@/lib/require-session';
import { getSavedPlaceDetailForUser } from '@/lib/saved-places';

/**
 * A saved place at its own URL.
 *
 * THE SHEET IS THE NORMAL WAY IN, not this. The Map View checklist says a tapped
 * marker expands a bottom sheet rather than navigating away from the map, and the
 * saved-places screen obeys that (`components/place-sheet.tsx`). This route
 * exists for the three things a sheet cannot do: be linked to, be opened in a new
 * tab, and be the destination of "같은 릴스의 다른 9곳" — where following a
 * sibling from inside a sheet and landing in another sheet would stack two
 * dialogs.
 *
 * The page renders exactly the component the sheet mounts, so the two can never
 * drift into showing different facts about the same place.
 */

type Props = { params: Promise<{ saved_place_id: string }> };

/**
 * The title is the venue's name, so a shared link and a browser tab both say
 * which place. It costs a second read of the same row; Next dedupes neither this
 * nor the page's, and one extra indexed lookup is the right price for a tab that
 * does not say "저장한 곳".
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = await requireSession();
  const detail = await getSavedPlaceDetailForUser((await params).saved_place_id, user.id);
  return { title: detail?.saved.place?.name ?? '저장한 곳' };
}

export default async function SavedPlacePage({ params }: Props) {
  const user = await requireSession();
  const { saved_place_id } = await params;

  // `getSavedPlaceDetailForUser` puts visibility in its WHERE clause and returns
  // null both for a row that does not exist and for one this user may not see.
  // Collapsing the two into 404 is deliberate: a 403 would confirm the id is real
  // to whoever guessed it. Same posture as the route handler's `authorise`.
  const detail = await getSavedPlaceDetailForUser(saved_place_id, user.id);
  if (!detail) notFound();

  return (
    <Content>
      <Link
        href="/saved-places"
        className="mb-[var(--space-13)] inline-block text-secondary transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
        style={{ font: 'var(--type-meta)' }}
      >
        ← 저장한 곳
      </Link>
      <PlaceDetail detail={detail} />
    </Content>
  );
}
