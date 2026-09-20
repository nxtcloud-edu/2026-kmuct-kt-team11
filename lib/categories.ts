import type { PlaceCategory } from './api/types';

/**
 * `places.category` is an English enum in the database (the CHECK constraint is
 * the authority) and every word a user reads is Korean, so the labels are
 * translated at the point of display.
 *
 * One copy, here, because three screens now render a bare category and a fourth
 * copy is how one of them ends up saying `cafe`.
 */
export const CATEGORY_KO: Record<string, string> = {
  cafe: '카페',
  restaurant: '음식점',
  exhibition: '전시',
  shop: '가게',
  activity: '체험',
};

/**
 * Display order for anything that lists categories side by side — chips, legends,
 * filters. The database enum has no order of its own, and sorting by the Korean
 * label would reshuffle the row the day a label is reworded.
 */
export const CATEGORY_ORDER: PlaceCategory[] = [
  'cafe',
  'restaurant',
  'exhibition',
  'shop',
  'activity',
];

/** Falls through to the raw value rather than throwing: an unknown category is a
 *  migration that landed ahead of this file, not a reason to blank the label. */
export function categoryLabel(category: string): string {
  return CATEGORY_KO[category] ?? category;
}
