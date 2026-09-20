import { query, queryOne } from '@/lib/db';
import type {
  GroupContext,
  GroupCourseInput,
  GroupCourseResult,
  GroupCourseRun,
} from './types';

type StoredRun = {
  id: string;
  result: GroupCourseResult;
  created_at: Date;
};

function serialiseRun(row: StoredRun): GroupCourseRun {
  return {
    id: row.id,
    course: row.result.recommendation.course,
    diagnostics: row.result.recommendation.diagnostics,
    group_match: row.result.groupMatch,
    representative_mbti: row.result.representativeMbti,
    attempts: row.result.attempts,
    created_at: row.created_at.toISOString(),
  };
}
export async function saveGroupCourseRun(options: {
  context: GroupContext;
  input: GroupCourseInput;
  result: GroupCourseResult;
}): Promise<GroupCourseRun> {
  const profileSnapshot = options.context.members.map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
    mbti: member.mbti,
    visible: member.visible,
    savedPlaceCount: member.savedPlaceCount,
    confidence: member.confidence,
    tasteVector: member.tasteVector,
    preferredAreas: member.preferredAreas,
  }));
  const row = await queryOne<StoredRun>(
    `insert into group_itineraries (
       group_id, requested_by, participant_ids, request,
       member_profile_snapshot, result, fairness_score, status
     ) values ($1, $2, $3::uuid[], $4::jsonb, $5::jsonb, $6::jsonb, $7, 'completed')
     returning id, result, created_at`,
    [
      options.context.groupId,
      options.context.requesterId,
      options.input.memberIds,
      JSON.stringify(options.input),
      JSON.stringify(profileSnapshot),
      JSON.stringify(options.result),
      options.result.groupMatch.fairnessScore,
    ],
  );
  if (!row) throw new Error('그룹 코스 저장 결과가 없습니다.');
  return serialiseRun(row);
}

export async function listGroupCourseRuns(groupId: string, limit = 10): Promise<GroupCourseRun[]> {
  const rows = await query<StoredRun>(
    `select id, result, created_at
       from group_itineraries
      where group_id = $1
   order by created_at desc
      limit $2`,
    [groupId, limit],
  );
  return rows.map(serialiseRun);
}
