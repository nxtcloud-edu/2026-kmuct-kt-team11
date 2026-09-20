import { query, queryOne } from '@/lib/db';
import { ProblemError } from '@/lib/problem';
import type { CandidatePlace, Mbti } from '@/packages/shared/src';
import { buildMemberPreferenceProfile, type MemberRow, type PreferencePlaceRow } from './member-profile';
import {
  DB_CATEGORY_TO_CONTENT,
  type GroupContext,
  type GroupCourseInput,
} from './types';

type GroupAccessRow = {
  id: string;
  name: string;
  requester_mbti: string | null;
};

type CandidateRow = {
  place_id: string;
  title: string;
  category: string;
  lat: number;
  lng: number;
  address: string | null;
  area: string;
  is_saved: boolean;
  price_band: string | null;
  review_digest: unknown;
  degraded: boolean | null;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function digestFeatures(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return stringArray((value as { vibe?: unknown }).vibe).slice(0, 20);
}

function toCandidate(row: CandidateRow): CandidatePlace | null {
  const category = DB_CATEGORY_TO_CONTENT[row.category];
  if (!category) return null;
  const features = digestFeatures(row.review_digest);

  return {
    placeId: row.place_id,
    title: row.title,
    category,
    source: row.is_saved ? 'saved' : 'external',
    location: {
      name: row.area,
      address: row.address,
      regionTags: [row.area],
      coords: { lat: row.lat, lng: row.lng },
    },
    price: row.price_band ? { priceLevel: row.price_band } : undefined,
    features,
    normalizedHashtags: features,
    openingHours: null,
    cautions: row.degraded ? ['일부 장소 정보가 최신 상태가 아닐 수 있어요.'] : [],
    sourceEvidence: row.is_saved
      ? [{ source: 'saved-place', text: '그룹 또는 공개 프로필에서 저장한 장소' }]
      : [{ source: 'place-database', text: '선택 지역의 보충 후보' }],
  };
}

export async function loadGroupContext(options: {
  groupId: string;
  requesterId: string;
  input: GroupCourseInput;
}): Promise<GroupContext> {
  const access = await queryOne<GroupAccessRow>(
    `select g.id, g.name, u.mbti as requester_mbti
       from groups g
       join group_members gm on gm.group_id = g.id and gm.user_id = $2
       join users u on u.id = gm.user_id
      where g.id = $1`,
    [options.groupId, options.requesterId],
  );
  if (!access) throw new ProblemError('not-group-member');

  const memberRows = await query<MemberRow>(
    `select gm.user_id, u.display_name, u.mbti, u.profile_visible_in_groups
       from group_members gm
       join users u on u.id = gm.user_id
      where gm.group_id = $1 and gm.user_id = any($2::uuid[])
   order by gm.joined_at`,
    [options.groupId, options.input.memberIds],
  );
  if (memberRows.length !== options.input.memberIds.length) {
    throw new ProblemError('validation-error', {
      detail: '선택한 참여자 중 이 그룹에 속하지 않은 사용자가 있습니다.',
      errors: [{ field: 'member_ids', message: '모든 참여자는 현재 그룹의 멤버여야 합니다.' }],
    });
  }

  const preferenceRows = await query<PreferencePlaceRow>(
    `select sp.id as saved_place_id, sp.user_id, p.id as place_id,
            p.category, p.area
       from saved_places sp
       join places p on p.id = sp.place_id
       join users u on u.id = sp.user_id
      where sp.user_id = any($2::uuid[])
        and sp.status = 'resolved' and sp.confirmed = true
        and (sp.group_id = $1 or (sp.group_id is null and u.profile_visible_in_groups = true))`,
    [options.groupId, options.input.memberIds],
  );
  const members = memberRows.map((member) => buildMemberPreferenceProfile(member, preferenceRows));

  const searchArea = (options.input.region ?? options.input.startStation ?? '').replace(/역$/, '');
  const candidateRows = await query<CandidateRow>(
    `with saved_candidates as (
       select distinct sp.place_id
         from saved_places sp
         join users u on u.id = sp.user_id
        where sp.place_id is not null
          and sp.status = 'resolved' and sp.confirmed = true
          and (sp.group_id = $1
               or (sp.group_id is null and sp.user_id = any($2::uuid[])
                   and u.profile_visible_in_groups = true))
     )
     select p.id as place_id, p.name as title, p.category, p.lat, p.lng,
            p.address, p.area, (sc.place_id is not null) as is_saved,
            pf.price_band, pf.review_digest, pf.degraded
       from places p
       left join saved_candidates sc on sc.place_id = p.id
       left join place_facts pf on pf.place_id = p.id
      where sc.place_id is not null
         or p.id = any($4::uuid[])
         or p.area ilike ('%' || $3 || '%')
         or coalesce(p.address, '') ilike ('%' || $3 || '%')
   order by (sc.place_id is not null) desc, p.created_at desc
      limit 60`,
    [
      options.groupId,
      options.input.memberIds,
      searchArea,
      options.input.pinnedPlaceIds ?? [],
    ],
  );
  const candidates = candidateRows
    .map(toCandidate)
    .filter((candidate): candidate is CandidatePlace => candidate !== null);

  return {
    groupId: access.id,
    groupName: access.name,
    requesterId: options.requesterId,
    requesterMbti: access.requester_mbti as Mbti | null,
    members,
    candidates,
  };
}
