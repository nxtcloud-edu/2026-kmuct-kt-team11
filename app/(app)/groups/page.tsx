import type { Metadata } from 'next';
import { Content, PageHeader } from '@/components/surface';
import { EmptyState } from '@/components/states';
import { requireSession } from '@/lib/require-session';
import { query } from '@/lib/db';
import type { GroupSummary } from '@/lib/api/types';
import { Card, Chip } from '@/components/surface';

export const metadata: Metadata = { title: '그룹' };

/**
 * SCAFFOLD. Lists the caller's groups and stops there — create, invite, rename
 * and leave all exist in the API but have no screen until step 4 of the run
 * order specifies the flows. The routes are `/api/groups*`; wire the actions to
 * them rather than inventing new endpoints.
 */
export default async function GroupsPage() {
  const user = await requireSession();

  const groups = await query<GroupSummary>(
    `select g.id, g.name, gm.role,
            (select count(*)::int from group_members m where m.group_id = g.id) as member_count
       from group_members gm
       join groups g on g.id = gm.group_id
      where gm.user_id = $1
   order by g.created_at desc`,
    [user.id],
  );

  return (
    <Content>
      <PageHeader title="그룹" />
      {groups.length === 0 ? (
        <EmptyState
          title="아직 그룹이 없어요"
          body="그룹을 만들면 저장한 곳을 함께 모으고 같이 일정을 짤 수 있어요."
        />
      ) : (
        <ul className="flex list-none flex-col gap-3 p-0">
          {groups.map((g) => (
            <Card as="li" key={g.id} className="flex items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium [overflow-wrap:anywhere]">{g.name}</p>
                <p className="mt-0.5 text-sm text-ink-muted">멤버 {g.member_count}명</p>
              </div>
              {g.role === 'owner' ? <Chip>관리자</Chip> : null}
            </Card>
          ))}
        </ul>
      )}
    </Content>
  );
}
