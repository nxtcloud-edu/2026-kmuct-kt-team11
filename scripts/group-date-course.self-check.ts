import assert from 'node:assert/strict';
import type { CandidatePlace, CoursePlan } from '../packages/shared/src';
import { aggregateMemberPreferences } from '../features/group-date-course/aggregate-preferences';
import { evaluateGroupFairness, repairPinsForUncoveredMembers } from '../features/group-date-course/fairness';
import { buildMemberPreferenceProfile } from '../features/group-date-course/member-profile';
import { rankCandidatesForGroup } from '../features/group-date-course/rank-for-group';
import { parseGroupCourseInput } from '../features/group-date-course/schema';
import type { MemberPreferenceProfile } from '../features/group-date-course/types';

const visibleMember = buildMemberPreferenceProfile(
  {
    user_id: '10000000-0000-4000-8000-000000000001',
    display_name: '민지',
    mbti: 'ISFP',
    profile_visible_in_groups: true,
  },
  [
    {
      saved_place_id: '20000000-0000-4000-8000-000000000001',
      user_id: '10000000-0000-4000-8000-000000000001',
      place_id: '30000000-0000-4000-8000-000000000001',
      category: 'cafe',
      area: '성수',
    },
    {
      saved_place_id: '20000000-0000-4000-8000-000000000002',
      user_id: '10000000-0000-4000-8000-000000000001',
      place_id: '30000000-0000-4000-8000-000000000002',
      category: 'cafe',
      area: '성수',
    },
    {
      saved_place_id: '20000000-0000-4000-8000-000000000003',
      user_id: '10000000-0000-4000-8000-000000000001',
      place_id: '30000000-0000-4000-8000-000000000003',
      category: 'restaurant',
      area: '건대',
    },
  ],
);

const privateMember = buildMemberPreferenceProfile(
  {
    user_id: '10000000-0000-4000-8000-000000000002',
    display_name: '현우',
    mbti: 'ENTP',
    profile_visible_in_groups: false,
  },
  [
    {
      saved_place_id: '20000000-0000-4000-8000-000000000004',
      user_id: '10000000-0000-4000-8000-000000000002',
      place_id: '30000000-0000-4000-8000-000000000004',
      category: 'activity',
      area: '잠실',
    },
  ],
);

assert.equal(visibleMember.tasteVector.categories?.cafe_dessert, 1);
assert.equal(visibleMember.tasteVector.categories?.restaurant, 0.5);
assert.equal(privateMember.savedPlaceCount, 0);
assert.deepEqual(privateMember.tasteVector.categories, {});

const secondVisible: MemberPreferenceProfile = {
  userId: '10000000-0000-4000-8000-000000000003',
  displayName: '준',
  mbti: 'ENTJ',
  visible: true,
  savedPlaceCount: 4,
  confidence: 'medium',
  tasteVector: { categories: { activity_experience: 1, restaurant: 0.5 } },
  preferredAreas: ['잠실'],
};
const aggregate = aggregateMemberPreferences([visibleMember, secondVisible], 'ISFP');
assert.equal(aggregate.representativeMbti.length, 4);
assert.equal(aggregate.tasteVector.categories?.restaurant, 0.5);
assert.equal(aggregate.tasteVector.categories?.accommodation, 0.05);
assert.ok(aggregate.tasteVector.evidence?.every((item) => !item.tag.includes('민지')));

const candidates: CandidatePlace[] = [
  {
    placeId: 'cafe',
    title: '카페',
    category: 'cafe_dessert',
    source: 'saved',
    location: { regionTags: ['성수'] },
  },
  {
    placeId: 'activity',
    title: '체험',
    category: 'activity_experience',
    source: 'saved',
    location: { regionTags: ['잠실'] },
  },
  {
    placeId: 'meal',
    title: '식사',
    category: 'restaurant',
    source: 'external',
    location: { regionTags: ['성수'] },
  },
];
const ranked = rankCandidatesForGroup(candidates, [visibleMember, secondVisible]);
assert.equal(ranked.length, 3);
assert.ok(ranked.every((item) => item.groupScore >= 0 && item.groupScore <= 1));
assert.ok(
  ranked.every((item) =>
    item.candidate.sourceEvidence?.every((evidence) => !evidence.text.includes('민지')),
  ),
);

const course = {
  stops: [
    { placeId: 'cafe' },
    { placeId: 'meal' },
  ],
} as CoursePlan;
const match = evaluateGroupFairness(course, ranked, [visibleMember, secondVisible]);
assert.equal(match.memberCoverage.length, 2);
assert.equal(match.memberCoverage.find((member) => member.userId === secondVisible.userId)?.covered, false);
const repaired = repairPinsForUncoveredMembers([], course, match, ranked);
assert.deepEqual(repaired, ['activity']);

const parsed = parseGroupCourseInput({
  member_ids: [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
  ],
  date: '2026-10-03',
  time_range: '14:00-19:00',
  region: '성수',
  hard_constraints: { no_spicy: true, limited_walking: true },
});
assert.equal(parsed.memberIds.length, 1);
assert.equal(parsed.hardConstraints?.noSpicy, true);
assert.equal(parsed.hardConstraints?.limitedWalking, true);

console.log('group date course self-check: ok');
