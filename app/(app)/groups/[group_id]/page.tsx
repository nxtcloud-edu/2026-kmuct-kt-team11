import type { Metadata } from 'next';
import { Content } from '@/components/surface';
import { NotAllowedState } from '@/components/states';
import { requireSession } from '@/lib/require-session';
import { query, queryOne } from '@/lib/db';
import { listGroupInvites } from '@/lib/invites';
import type { GroupMember, GroupRole } from '@/lib/api/types';
import { GroupScreen } from './screen';

export const metadata: Metadata = { title: '그룹' };

/**
 * One group. Server-rendered because every fact on it — the name, who is in it,
 * which links are still open — is a database read that the client has no reason
 * to make twice.
 *
 * MEMBERSHIP IS CHECKED HERE, and with a plain query rather than
 * `assertGroupMember`: that helper throws a `ProblemError`, which is right for a
 * route handler and wrong in a page, where it would arm the error boundary
 * instead of rendering the state. Same reasoning as `requireSession` vs
 * `requireUser` — see the note in lib/require-session.ts.
 *
 * A non-member gets 볼 수 없는 페이지, not 404. The id in their URL came from
 * somewhere, and "this does not exist" would be a lie they could disprove by
 * asking the person who sent it.
 */
export default async function GroupPage({ params }: PageProps<'/groups/[group_id]'>) {
  const user = await requireSession();
  const { group_id } = await params;

  const membership = await queryOne<{ role: GroupRole }>(
    `select role from group_members where group_id = $1 and user_id = $2`,
    [group_id, user.id],
  );
  if (!membership) {
    return (
      <Content>
        <NotAllowedState />
      </Content>
    );
  }

  const group = await queryOne<{ id: string; name: string }>(
    `select id, name from groups where id = $1`,
    [group_id],
  );
  if (!group) {
    return (
      <Content>
        <NotAllowedState body="이 그룹은 더 이상 없어요." />
      </Content>
    );
  }

  // `joined_at` arrives from pg as a Date and `GroupMember` declares a string,
  // so it is mapped rather than cast. A cast here would type-check and then hand
  // the client screen a Date that its `.slice(0, 10)` would silently not have.
  const memberRows = await query<Omit<GroupMember, 'joined_at'> & { joined_at: Date }>(
    `select gm.user_id, u.display_name, u.avatar_url, gm.role, gm.joined_at
       from group_members gm join users u on u.id = gm.user_id
      where gm.group_id = $1 order by gm.joined_at`,
    [group_id],
  );
  const members: GroupMember[] = memberRows.map((m) => ({
    ...m,
    joined_at: m.joined_at.toISOString(),
  }));

  const placeCount = await queryOne<{ count: number }>(
    `select count(*)::int as count from saved_places
      where group_id = $1 and status <> 'rejected'`,
    [group_id],
  );

  // Membership was asserted above; `listGroupInvites` takes a group id, not a
  // caller, and says in its own doc comment that it cannot do that check itself.
  const invites = await listGroupInvites(group_id);

  return (
    <GroupScreen
      groupId={group.id}
      name={group.name}
      role={membership.role}
      members={members}
      invites={invites}
      placeCount={placeCount?.count ?? 0}
      meId={user.id}
    />
  );
}
