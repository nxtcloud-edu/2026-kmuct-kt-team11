import type { Metadata } from 'next';
import { Card, Chip, Content, PageHeader } from '@/components/surface';
import { EmptyState } from '@/components/states';
import { requireSession } from '@/lib/require-session';
import { listSavedPlacesForUser } from '@/lib/saved-places';
import type { SavedPlace } from '@/lib/api/types';

export const metadata: Metadata = { title: '저장한 곳' };

/**
 * SCAFFOLD — flat reverse-chronological list, deliberately uncommitted.
 *
 * `app/prototype/saved-places/DEMO.md` recommends grouping by `place.area`
 * (variant B) over luma's save-date agenda, and the reasoning is convincing.
 * That recommendation has NOT been folded into `.agents/visual-language.md`
 * yet, and the record — not this file — is where the organising fact is
 * decided. Promoting B here first would make the implementation the record,
 * which is exactly backwards.
 *
 * So this renders variant C, the null hypothesis: no grouping. It is the least
 * committed thing that still works, and swapping in area groups is a change to
 * this one component once the record says so.
 *
 * Also absent by design, because step 4 of the run order owns them: add-a-place,
 * tap-into-a-place, filtering, sorting, and infinite scroll. The list is capped
 * at the first 30 rows rather than paginating.
 */
export default async function SavedPlacesPage() {
  const user = await requireSession();
  const places = await listSavedPlacesForUser(user.id);

  return (
    <Content>
      <PageHeader title="저장한 곳" meta={places.length > 0 ? `${places.length}곳` : undefined} />

      {places.length === 0 ? (
        <EmptyState
          title="아직 저장한 곳이 없어요"
          body="인스타그램에서 릴스를 공유하면 여기에 쌓여요. 직접 추가할 수도 있어요."
        />
      ) : (
        <ul className="flex list-none flex-col gap-3 p-0">
          {places.map((p) => (
            <SavedPlaceRow key={p.id} saved={p} />
          ))}
        </ul>
      )}
    </Content>
  );
}

function SavedPlaceRow({ saved }: { saved: SavedPlace }) {
  const { place } = saved;

  return (
    <Card as="li" className="flex items-start gap-3 p-4">
      <div className="min-w-0 flex-1">
        {/* `place` is null while status is 'pending' — slice 3's extractor can
            produce a saved row before it has resolved to a real venue. */}
        <p className="font-medium [overflow-wrap:anywhere]">
          {place?.name ?? '장소를 확인하는 중이에요'}
        </p>

        {saved.hook ? (
          <p className="mt-0.5 line-clamp-2 text-secondary">{saved.hook}</p>
        ) : null}

        <div className="mt-2 flex flex-wrap gap-1.5">
          {place?.area ? <Chip>{place.area}</Chip> : null}
          {saved.status === 'needs_review' ? <Chip tone="danger">확인 필요</Chip> : null}
        </div>
      </div>

      <time
        dateTime={saved.saved_at}
        className="shrink-0 text-secondary tabular-nums"
      >
        {new Date(saved.saved_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
      </time>
    </Card>
  );
}
