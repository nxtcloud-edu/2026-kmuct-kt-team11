import type { PlaceCategory } from '@/lib/api/types';
import type { ContentCategory } from './types';

/**
 * 추출 어휘(transcript-extraction.json, 8종)와 DB 어휘(lib/api/types.ts, 5종)를 잇는다.
 *
 * 두 어휘를 하나로 합치지 않은 이유: 추출 쪽은 해시태그에서 읽어낸 의미를 잘게 나눠야
 * 추천 신호가 살고, DB 쪽은 places 테이블의 열거형이라 마이그레이션 없이 못 바꾼다.
 * 대신 변환을 이 파일 한 곳에만 둔다.
 */

const TO_PLACE_CATEGORY: Record<ContentCategory, PlaceCategory> = {
  restaurant: 'restaurant',
  cafe_dessert: 'cafe',
  culture_exhibition: 'exhibition',
  shopping_product: 'shop',
  activity_experience: 'activity',
  // DB에 대응 열거값이 없다. 관광지·숙소·뷰티는 활동으로 접는다.
  travel_attraction: 'activity',
  accommodation: 'activity',
  beauty_wellness: 'activity',
};

/** DB 어휘로 좁히면 정보가 줄기 때문에 역방향은 1:N이다. 후보 조회 필터에만 쓴다. */
const TO_CONTENT_CATEGORIES: Record<PlaceCategory, ContentCategory[]> = {
  restaurant: ['restaurant'],
  cafe: ['cafe_dessert'],
  exhibition: ['culture_exhibition'],
  shop: ['shopping_product'],
  activity: ['activity_experience', 'travel_attraction', 'accommodation', 'beauty_wellness'],
};

export function toPlaceCategory(category: ContentCategory): PlaceCategory {
  return TO_PLACE_CATEGORY[category];
}

export function toContentCategories(category: PlaceCategory): ContentCategory[] {
  return TO_CONTENT_CATEGORIES[category];
}

/** 코스 슬롯을 DB 조회용 카테고리 집합으로 바꾼다. */
export function placeCategoriesForContentCategories(
  categories: ContentCategory[],
): PlaceCategory[] {
  return [...new Set(categories.map(toPlaceCategory))];
}
