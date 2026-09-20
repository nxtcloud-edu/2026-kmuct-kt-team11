import type { CandidatePlace } from '@/packages/shared/src';
import type {
  CandidateMemberScore,
  GroupRankedCandidate,
  MemberPreferenceProfile,
} from './types';

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreCandidateForMember(
  candidate: CandidatePlace,
  member: MemberPreferenceProfile,
): CandidateMemberScore {
  if (!member.visible || member.savedPlaceCount === 0) {
    return {
      userId: member.userId,
      displayName: member.displayName,
      score: 0.5,
      reasons: ['공개된 취향 데이터가 없어 중립값을 적용했어요.'],
    };
  }

  const categoryScore = candidate.category
    ? (member.tasteVector.categories?.[candidate.category] ?? 0)
    : 0;
  const candidateAreas = new Set(candidate.location?.regionTags ?? []);
  const areaMatched = member.preferredAreas.some((area) => candidateAreas.has(area));
  const areaScore = areaMatched ? 1 : 0;
  const score = clamp(categoryScore * 0.8 + areaScore * 0.2);
  const reasons: string[] = [];
  if (categoryScore > 0) reasons.push('자주 저장한 장소 종류와 맞아요.');
  if (areaMatched) reasons.push('자주 저장한 지역과 가까워요.');
  if (reasons.length === 0) reasons.push('직접 일치하는 저장 취향이 적어요.');

  return {
    userId: member.userId,
    displayName: member.displayName,
    score: Number(score.toFixed(4)),
    reasons,
  };
}

export function rankCandidatesForGroup(
  candidates: CandidatePlace[],
  members: MemberPreferenceProfile[],
): GroupRankedCandidate[] {
  const informed = members.filter((member) => member.visible && member.savedPlaceCount > 0);
  const scoringMembers = informed.length > 0 ? informed : members;
  return candidates
    .map((candidate) => {
      const memberScores = scoringMembers.map((member) => scoreCandidateForMember(candidate, member));
      const scores = memberScores.map((item) => item.score);
      const mean = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
      const minimum = Math.min(...scores);
      const coverage = scores.filter((score) => score >= 0.45).length / Math.max(1, scores.length);
      const groupScore = clamp(mean * 0.55 + minimum * 0.3 + coverage * 0.15);

      return {
        candidate: {
          ...candidate,
          similarUserSignal: {
            ...candidate.similarUserSignal,
            likeRate: Number(groupScore.toFixed(4)),
          },
          sourceEvidence: [
            ...(candidate.sourceEvidence ?? []),
            {
              source: 'group-preference',
              text: `${memberScores.filter((item) => item.score >= 0.45).length}명의 공개 취향과 일치`,
            },
          ],
        },
        groupScore: Number(groupScore.toFixed(4)),
        memberScores,
      };
    })
    .sort(
      (a, b) =>
        b.groupScore - a.groupScore ||
        a.candidate.title.localeCompare(b.candidate.title),
    );
}
