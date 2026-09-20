import type { Metadata } from 'next';
import { requireSession } from '@/lib/require-session';
import { query } from '@/lib/db';
import { reelThumbPublicUrl } from '@/lib/storage';
import { reelThumb } from '@/lib/reel-thumb';
import type { GroupSummary } from '@/lib/api/types';
import { GroupsScreen, type GroupRow } from './screen';

export const metadata: Metadata = { title: '그룹' };

/**
 * 그룹 — the data boundary. Everything interactive is in `screen.tsx`.
 *
 * Two queries, not one per group. The thumbnail cluster is a single windowed
 * read over every group the caller belongs to, so adding a group costs a row
 * rather than a round trip; `row_number()` caps it at three per group inside
 * Postgres instead of fetching every saved place and slicing in JS.
 *
 * The cluster is drawn from the group's own saved places, which is the only
 * honest picture of a room: the places in it. Where a group has none, the
 * screen draws nothing rather than a placeholder grid — the record's rule is
 * that a line with no data behind it is deleted, not filled.
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

  const ids = groups.map((g) => g.id);
  const thumbs = ids.length
    ? await query<{ group_id: string; id: string; thumb_path: string | null }>(
        `select group_id, id, thumb_path from (
           select sp.group_id, sp.id, r.thumb_path,
                  row_number() over (partition by sp.group_id order by sp.saved_at desc) as rn
             from saved_places sp
             left join reels r on r.id = sp.reel_id
            where sp.group_id = any($1::uuid[]) and sp.status <> 'rejected'
         ) t where rn <= 3`,
        [ids],
      )
    : [];

  const byGroup = new Map<string, string[]>();
  for (const t of thumbs) {
    const list = byGroup.get(t.group_id) ?? [];
    // Same fallback chain the deck and the place list use: the reel's own cover
    // frame when it downloaded, otherwise a stable stand-in keyed on the row id.
    list.push(reelThumbPublicUrl(t.thumb_path) ?? reelThumb(t.id));
    byGroup.set(t.group_id, list);
  }

  const rows: GroupRow[] = groups.map((g) => ({ ...g, thumbs: byGroup.get(g.id) ?? [] }));

  return <GroupsScreen groups={rows} />;
}
