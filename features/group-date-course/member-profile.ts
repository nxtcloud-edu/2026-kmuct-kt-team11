import type { ContentCategory, Mbti, TasteEvidenceEntry } from '@/packages/shared/src';
import { isMbtiType } from '@/lib/mbti';
import { DB_CATEGORY_TO_CONTENT, type MemberPreferenceProfile } from './types';

export interface MemberRow {
  user_id: string;
  display_name: string;
  mbti: string | null;
  profile_visible_in_groups: boolean;
}
export interface PreferencePlaceRow {
  saved_place_id: string;
  user_id: string;
  place_id: string;
  category: string;
  area: string;
}

function confidenceFor(count: number): MemberPreferenceProfile['confidence'] {
  if (count >= 5) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function normaliseCounts(counts: Map<ContentCategory, number>) {
  const max = Math.max(0, ...counts.values());
  const categories: Partial<Record<ContentCategory, number>> = {};
  if (max === 0) return categories;
  for (const [category, count] of counts) categories[category] = count / max;
  return categories;
}

export function buildMemberPreferenceProfile(
  member: MemberRow,
  places: PreferencePlaceRow[],
): MemberPreferenceProfile {
  const visiblePlaces = member.profile_visible_in_groups
    ? places.filter((place) => place.user_id === member.user_id)
    : [];
  const categoryCounts = new Map<ContentCategory, number>();
  const areaCounts = new Map<string, number>();
  const evidence: TasteEvidenceEntry[] = [];

  for (const place of visiblePlaces) {
    const category = DB_CATEGORY_TO_CONTENT[place.category];
    if (category) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      evidence.push({
        tag: category,
        sourceVideoId: place.saved_place_id,
        count: 1,
      });
    }
    if (place.area) areaCounts.set(place.area, (areaCounts.get(place.area) ?? 0) + 1);
  }

  const preferredAreas = [...areaCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([area]) => area);

  return {
    userId: member.user_id,
    displayName: member.display_name,
    mbti: member.mbti && isMbtiType(member.mbti) ? (member.mbti as Mbti) : null,
    visible: member.profile_visible_in_groups,
    savedPlaceCount: visiblePlaces.length,
    confidence: confidenceFor(visiblePlaces.length),
    tasteVector: {
      categories: normaliseCounts(categoryCounts),
      evidence: evidence.slice(0, 100),
    },
    preferredAreas,
  };
}
