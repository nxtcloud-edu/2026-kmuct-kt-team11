import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Chip, Content, PageHeader } from '@/components/surface';
import { query, queryOne } from '@/lib/db';
import { requireSession } from '@/lib/require-session';
import { GroupCourseForm, type GroupMemberOption } from './group-course-form';
import { InviteButton } from './invite-button';

export const metadata: Metadata = { title: '그룹 코스' };

type Params = { params: Promise<{ group_id: string }> };
type GroupRow = { id: string; name: string; role: 'owner' | 'member'; saved_place_count: number };
type MemberRow = GroupMemberOption & { role: 'owner' | 'member' };

export default async function GroupDetailPage({ params }: Params) {
  const user = await requireSession();
  const { group_id } = await params;
  const group = await queryOne<GroupRow>(
    `select g.id, g.name, gm.role,
            (select count(*)::int from saved_places sp
              where sp.group_id = g.id and sp.status = 'resolved') as saved_place_count
       from groups g
       join group_members gm on gm.group_id = g.id and gm.user_id = $2
      where g.id = $1`,
    [group_id, user.id],
  );
  if (!group) notFound();

  const members = await query<MemberRow>(
    `select gm.user_id, u.display_name, u.mbti, u.profile_visible_in_groups, gm.role
       from group_members gm join users u on u.id = gm.user_id
      where gm.group_id = $1 order by gm.joined_at`,
    [group_id],
  );

  return (
    <Content>
      <Link href="/groups" className="mb-4 inline-block text-secondary">
        그룹으로 돌아가기
      </Link>
      <div className="flex items-start justify-between gap-4">
        <PageHeader title={group.name} meta={`공유 장소 ${group.saved_place_count}곳`} />
        <InviteButton groupId={group.id} />
      </div>

      <section className="mb-[var(--section-gap)]">
        <h3 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>멤버</h3>
        <ul className="mt-3 flex list-none flex-col gap-2 p-0">
          {members.map((member) => (
            <Card as="li" key={member.user_id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p>{member.display_name}</p>
                <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
                  {member.profile_visible_in_groups
                    ? `${member.mbti ?? 'MBTI 미설정'} · 취향 공개`
                    : '개인 취향 비공개'}
                </p>
              </div>
              {member.role === 'owner' ? <Chip>관리자</Chip> : null}
            </Card>
          ))}
        </ul>
      </section>

      <GroupCourseForm groupId={group.id} members={members} />
    </Content>
  );
}
