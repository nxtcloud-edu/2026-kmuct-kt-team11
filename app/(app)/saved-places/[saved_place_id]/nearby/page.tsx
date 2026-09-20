import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content } from '@/components/surface';
import { requireSession } from '@/lib/require-session';
import { getSavedPlaceDetailForUser } from '@/lib/saved-places';
import { NearbyScreen } from './nearby-screen';

/**
 * 주변 장소 찾기, nested under the saved place it searches around.
 *
 * ── WHY HERE AND NOT `/discover/[area]` ────────────────────────────────────
 * The discovery spec §9 reserves `/discover/[area]` for a CRAWLED, STORED area
 * feed — warm/queued/cold, ordered by `place_facts` confidence, shared by every
 * user who asks for that 동. None of that exists yet: there is no `area_crawls`
 * table, no worker and no stored result. This screen is a different thing that
 * happens to search the same neighbourhood — a live, user-triggered, unstored
 * lookup anchored on one saved place — and putting it at the spec's URL would
 * squat on a route whose semantics are already decided.
 *
 * Nesting it under the anchor earns three things instead:
 *   * the anchor is IN the URL, so nothing has to be smuggled through a query
 *     string and no client state survives a refresh into the wrong context;
 *   * the visibility check is the one that already guards the parent, run again
 *     here rather than inherited (see below);
 *   * "← 뒤로" is unambiguous, because there is exactly one place to go back to.
 *
 * ── THE SERVER DOES THE AUTH; THE CLIENT DOES THE WAITING ──────────────────
 * This page is a Server Component and fetches NOTHING expensive: it resolves the
 * session, reads the one saved-place row, and hands three strings to a client
 * component. The Apify runs happen only when the button in that component posts
 * to `app/api/saved-places/[saved_place_id]/nearby/route.ts`. Rendering this URL
 * costs a database read, which is what makes the route safe to link to from the
 * detail screen.
 */

type Props = { params: Promise<{ saved_place_id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = await requireSession();
  const detail = await getSavedPlaceDetailForUser((await params).saved_place_id, user.id);
  const area = detail?.saved.place?.area;
  return { title: area ? `${area} 주변` : '주변 장소 찾기' };
}

export default async function NearbyPage({ params }: Props) {
  const user = await requireSession();
  const { saved_place_id } = await params;

  // Re-run rather than inherited from the parent route. `getSavedPlaceDetailForUser`
  // puts visibility in its WHERE clause and returns null both for a row that does
  // not exist and for one this user may not see — collapsing the two into 404 is
  // deliberate, because a 403 confirms the id is real to whoever guessed it.
  const detail = await getSavedPlaceDetailForUser(saved_place_id, user.id);
  if (!detail) notFound();

  const place = detail.saved.place;

  // A pending row has no place and therefore no 동 to search around, and there is
  // nothing honest to render without one. The record's rule is that a line with
  // no data behind it is deleted rather than filled — at screen scale that means
  // 404, and it is why the detail screen hides the button in the same state.
  if (!place?.area) notFound();

  return (
    <Content>
      <Link
        href={`/saved-places/${saved_place_id}`}
        className="mb-[var(--space-13)] inline-block text-secondary transition-opacity duration-200 active:opacity-[var(--press-opacity-strong)]"
        style={{ font: 'var(--type-meta)' }}
      >
        ← {place.name}
      </Link>

      <NearbyScreen savedPlaceId={saved_place_id} name={place.name} area={place.area} />
    </Content>
  );
}
