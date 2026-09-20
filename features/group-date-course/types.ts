import type {
  CandidatePlace,
  Confidence,
  ContentCategory,
  CourseRequest,
  HardConstraints,
  Mbti,
  RecommendationResult,
  TasteVector,
} from '@/packages/shared/src';

export interface GroupCourseInput {
  memberIds: string[];
  date: string;
  timeRange: string;
  region?: string;
  startStation?: string;
  budgetPerPerson?: number;
  hardConstraints?: HardConstraints;
  pinnedPlaceIds?: string[];
  forbiddenPlaceIds?: string[];
}

export interface MemberPreferenceProfile {
  userId: string;
  displayName: string;
  mbti: Mbti | null;
  visible: boolean;
  savedPlaceCount: number;
  confidence: Confidence;
  tasteVector: TasteVector;
  preferredAreas: string[];
}

export interface GroupContext {
  groupId: string;
  groupName: string;
  requesterId: string;
  requesterMbti: Mbti | null;
  members: MemberPreferenceProfile[];
  candidates: CandidatePlace[];
}

export interface CandidateMemberScore {
  userId: string;
  displayName: string;
  score: number;
  reasons: string[];
}

export interface GroupRankedCandidate {
  candidate: CandidatePlace;
  groupScore: number;
  memberScores: CandidateMemberScore[];
}

export interface MemberCoverage {
  userId: string;
  displayName: string;
  bestScore: number;
  covered: boolean;
  matchedPlaceIds: string[];
}

export interface StopAttribution {
  placeId: string;
  memberIds: string[];
  memberNames: string[];
}

export interface GroupMatch {
  memberCoverage: MemberCoverage[];
  stopAttributions: StopAttribution[];
  fairnessScore: number;
}

export interface GroupCourseResult {
  recommendation: RecommendationResult;
  groupMatch: GroupMatch;
  representativeMbti: Mbti;
  attempts: number;
}

export interface GroupCourseRun {
  id: string;
  course: RecommendationResult['course'];
  diagnostics: RecommendationResult['diagnostics'];
  group_match: GroupMatch;
  representative_mbti: Mbti;
  attempts: number;
  created_at: string;
}

export interface GroupAggregate {
  representativeMbti: Mbti;
  tasteVector: TasteVector;
  confidence: Confidence;
  savedPlaceCount: number;
}

export interface GroupAgentPreparedInput {
  request: CourseRequest;
  rankedCandidates: GroupRankedCandidate[];
  aggregate: GroupAggregate;
}

export const DB_CATEGORY_TO_CONTENT: Record<string, ContentCategory> = {
  restaurant: 'restaurant',
  cafe: 'cafe_dessert',
  exhibition: 'culture_exhibition',
  shop: 'shopping_product',
  activity: 'activity_experience',
};
