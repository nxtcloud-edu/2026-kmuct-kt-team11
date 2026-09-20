import assert from 'node:assert/strict';

import { generateDateCourse } from '../packages/shared/src/agent';
import { parseCourseRequest } from '../packages/shared/src/request';
import type { CandidatePlace, CourseDraft, CourseRequest } from '../packages/shared/src/types';

function place(
  placeId: string,
  title: string,
  category: CandidatePlace['category'],
  source: CandidatePlace['source'],
  perPerson: number | null,
): CandidatePlace {
  return {
    placeId,
    title,
    category,
    source,
    location: { nearestStation: '성수', regionTags: ['성수'] },
    price: { perPerson },
    normalizedHashtags: ['데이트'],
    features: ['조용한'],
    openingHours: '10:00-23:30',
    cautions: [],
    sponsored: false,
  };
}

const candidates = [
  place('p1', '저녁 식당', 'restaurant', 'saved', 20_000),
  place('p2', '골목 카페', 'cafe_dessert', 'saved', 10_000),
  place('p3', '야간 산책로', 'travel_attraction', 'external', 0),
  place('p4', '대안 전시', 'culture_exhibition', 'saved', 12_000),
  place('p5', '대안 공방', 'activity_experience', 'saved', 15_000),
  place('p6', '대안 디저트', 'cafe_dessert', 'external', 8_000),
];

const request: CourseRequest = {
  user: {
    mbti: 'INFP',
    tasteVectorConfidence: 'high',
    savedVideoCount: 8,
    tasteVector: {
      categories: { cafe_dessert: 0.9, restaurant: 0.8, travel_attraction: 0.7 },
      evidence: [{ tag: '데이트', sourceVideoId: 'video-1', count: 4 }],
    },
    constraints: {
      region: '성수',
      date: '2026-09-26',
      timeRange: '18:00-23:00',
      participantCount: 2,
      budgetPerPerson: 40_000,
    },
  },
  candidatePlaces: candidates,
};

const why = {
  tasteEvidence: ['저장 영상 태그: 데이트'],
  similarUserEvidence: null,
  mbtiFit: '조용한 장소를 이어 대화 흐름을 유지합니다.',
};

const validDraft: CourseDraft = {
  mbti: 'INFP',
  characterName: '감성 산책러',
  courseTitle: '성수 저녁 산책 코스',
  courseSummary: '저녁 식사와 카페 뒤 산책으로 이어지는 코스입니다.',
  stops: [
    {
      order: 1, slot: 'meal', placeId: 'p1', name: '저녁 식당', category: 'restaurant', why,
      alternatives: [
        { placeId: 'p4', name: '대안 전시', reason: '실내 대안' },
        { placeId: 'p5', name: '대안 공방', reason: '체험 대안' },
      ],
      cautions: [], sponsoredNotice: null,
    },
    {
      order: 2, slot: 'cafe_dessert', placeId: 'p2', name: '골목 카페', category: 'cafe_dessert', why,
      alternatives: [
        { placeId: 'p4', name: '대안 전시', reason: '실내 대안' },
        { placeId: 'p5', name: '대안 공방', reason: '체험 대안' },
      ],
      cautions: [], sponsoredNotice: null,
    },
    {
      order: 3, slot: 'experience', placeId: 'p3', name: '야간 산책로', category: 'travel_attraction', why,
      alternatives: [
        { placeId: 'p4', name: '대안 전시', reason: '실내 대안' },
        { placeId: 'p5', name: '대안 공방', reason: '체험 대안' },
      ],
      cautions: [], sponsoredNotice: null,
    },
  ],
  mbtiRationale: '차분한 장소를 가까운 동선으로 연결했습니다.',
  verificationRequired: [],
  cautions: [],
};

const invalidDraft: CourseDraft = {
  ...validDraft,
  stops: [{ ...validDraft.stops[0], placeId: 'hallucinated-place' }, ...validDraft.stops.slice(1)],
};

async function main() {
  let calls = 0;
  const result = await generateDateCourse(parseCourseRequest(request), {
    modelId: 'self-check-model',
    callModel: async () => {
      calls += 1;
      return JSON.stringify(calls === 1 ? invalidDraft : validDraft);
    },
  });

  assert.equal(calls, 2, '검증 실패 뒤 한 번만 수정 호출해야 합니다.');
  assert.equal(result.status, 'validated');
  assert.equal(result.diagnostics.attempts, 2);
  assert.equal(result.course.stops.length, 3);
  assert.equal(result.course.savedPlaceCount, 2);
  assert.equal(result.course.estimatedBudgetPerPerson, 30_000);
  assert.equal(result.course.stops[0].startTime, '18:00');
  assert.equal(result.course.stops[2].moveToNext, null);
  assert.equal(result.violations.length, 0);

  console.log('recommendation agent self-check passed');
}

void main();
