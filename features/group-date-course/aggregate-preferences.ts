import type { ContentCategory, Mbti, TasteEvidenceEntry } from '@/packages/shared/src';
import type { GroupAggregate, MemberPreferenceProfile } from './types';

const CONTENT_CATEGORIES: ContentCategory[] = [
  'restaurant',
  'cafe_dessert',
  'travel_attraction',
  'accommodation',
  'culture_exhibition',
  'activity_experience',
  'shopping_product',
  'beauty_wellness',
];

function representativeMbti(members: MemberPreferenceProfile[], requesterMbti: Mbti | null): Mbti {
  const known = members.map((member) => member.mbti).filter((mbti): mbti is Mbti => mbti !== null);
  if (known.length === 0) return requesterMbti ?? 'ENFP';

  const poles = [
    ['E', 'I'],
    ['S', 'N'],
    ['T', 'F'],
    ['J', 'P'],
  ] as const;

  return poles
    .map(([left, right], index) => {
      const leftCount = known.filter((mbti) => mbti[index] === left).length;
      const rightCount = known.length - leftCount;
      if (leftCount === rightCount) return requesterMbti?.[index] ?? known[0][index];
      return leftCount > rightCount ? left : right;
    })
    .join('') as Mbti;
}

export function aggregateMemberPreferences(
  members: MemberPreferenceProfile[],
  requesterMbti: Mbti | null,
): GroupAggregate {
  const informed = members.filter((member) => member.visible && member.savedPlaceCount > 0);
  const categories: Partial<Record<ContentCategory, number>> = {};

  for (const category of CONTENT_CATEGORIES) {
    const sum = informed.reduce(
      (total, member) => total + (member.tasteVector.categories?.[category] ?? 0),
      0,
    );
    const average = informed.length === 0 ? 0 : sum / informed.length;
    // The individual agent requires at least one taste link per candidate. A small
    // neutral floor keeps unseen categories available for a complete course while
    // preserving a large gap from categories backed by actual saves.
    categories[category] = Number(Math.max(0.05, average).toFixed(4));
  }

  const evidence = informed
    .flatMap((member) =>
      (member.tasteVector.evidence ?? []).map<TasteEvidenceEntry>((item) => ({
        ...item,
        tag: `참여자 취향:${item.tag}`,
      })),
    )
    .slice(0, 100);
  const savedPlaceCount = informed.reduce((sum, member) => sum + member.savedPlaceCount, 0);
  const confidence =
    informed.length > 0 && informed.every((member) => member.confidence === 'high')
      ? 'high'
      : informed.length > 0 && informed.every((member) => member.confidence !== 'low')
        ? 'medium'
        : 'low';

  return {
    representativeMbti: representativeMbti(members, requesterMbti),
    tasteVector: { categories, evidence },
    confidence,
    savedPlaceCount,
  };
}
