import type { CoursePlan } from '@/packages/shared/src';
import type { GroupMatch, GroupRankedCandidate, MemberPreferenceProfile } from './types';

export const MEMBER_COVERAGE_THRESHOLD = 0.45;

export function evaluateGroupFairness(
  course: CoursePlan,
  rankedCandidates: GroupRankedCandidate[],
  members: MemberPreferenceProfile[],
): GroupMatch {
  const selected = new Set(course.stops.map((stop) => stop.placeId));
  const byPlace = new Map(rankedCandidates.map((item) => [item.candidate.placeId, item]));
  const eligible = members.filter((member) => member.visible && member.savedPlaceCount > 0);
  const eligibleIds = new Set(eligible.map((member) => member.userId));

  const memberCoverage = eligible.map((member) => {
    const scores = course.stops.map((stop) => {
      const score = byPlace
        .get(stop.placeId)
        ?.memberScores.find((item) => item.userId === member.userId)?.score ?? 0;
      return { placeId: stop.placeId, score };
    });
    const bestScore = Math.max(0, ...scores.map((item) => item.score));
    return {
      userId: member.userId,
      displayName: member.displayName,
      bestScore: Number(bestScore.toFixed(4)),
      covered: bestScore >= MEMBER_COVERAGE_THRESHOLD,
      matchedPlaceIds: scores
        .filter((item) => item.score >= MEMBER_COVERAGE_THRESHOLD)
        .map((item) => item.placeId),
    };
  });

  const stopAttributions = [...selected].map((placeId) => {
    const matched =
      byPlace
        .get(placeId)
        ?.memberScores.filter(
          (item) => eligibleIds.has(item.userId) && item.score >= MEMBER_COVERAGE_THRESHOLD,
        ) ?? [];
    return {
      placeId,
      memberIds: matched.map((item) => item.userId),
      memberNames: matched.map((item) => item.displayName),
    };
  });

  if (memberCoverage.length === 0) {
    return { memberCoverage, stopAttributions, fairnessScore: 1 };
  }

  const coverageRatio = memberCoverage.filter((item) => item.covered).length / memberCoverage.length;
  const averageBest =
    memberCoverage.reduce((sum, item) => sum + item.bestScore, 0) / memberCoverage.length;
  const fairnessScore = Math.min(1, coverageRatio * 0.7 + averageBest * 0.3);

  return {
    memberCoverage,
    stopAttributions,
    fairnessScore: Number(fairnessScore.toFixed(4)),
  };
}

export function repairPinsForUncoveredMembers(
  currentPins: string[],
  course: CoursePlan,
  match: GroupMatch,
  rankedCandidates: GroupRankedCandidate[],
): string[] {
  const selected = new Set(course.stops.map((stop) => stop.placeId));
  const pins = new Set(currentPins);

  for (const member of match.memberCoverage.filter((item) => !item.covered)) {
    const replacement = rankedCandidates.find((item) => {
      if (selected.has(item.candidate.placeId) || pins.has(item.candidate.placeId)) return false;
      return item.memberScores.some(
        (score) => score.userId === member.userId && score.score >= MEMBER_COVERAGE_THRESHOLD,
      );
    });
    if (replacement) pins.add(replacement.candidate.placeId);
    if (pins.size >= 4) break;
  }

  return [...pins];
}
