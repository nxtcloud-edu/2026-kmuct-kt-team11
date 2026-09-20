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

/**
 * The 3D object each category wears in the saved-places filter row.
 *
 * Keyed by `PlaceCategory` rather than `string`, unlike the labels above: a new
 * value in the CHECK constraint should fail the build here rather than render a
 * chip with a hole in it, and unlike a missing label there is no sane fallback —
 * the raw enum value is at least readable, a missing image is a broken icon.
 *
 * CHOSEN FOR SILHOUETTE AT 22px, not for wit. A 3D render loses every internal
 * detail at chip size, so the test each of these passed is "is it still that
 * object when it is 22 pixels tall": a latte cup, a bowl of soup, a framed
 * painting, a shopfront, a ticket. The more interesting renders lost it — a
 * marble bust for 전시 and a pottery wheel for 체험 both collapse into a brown
 * smudge. 전시 also deliberately takes the painting rather than the columned
 * museum, which at 22px is indistinguishable from any other beige building.
 *
 * Files live in `public/category-3d/`, copied from the iconsax `ai-3d` library
 * in `anu-designer` and re-encoded at 128px through PIL — a new image, pixels
 * copied, so no ancillary PNG chunk survives the trip. That is not tidiness: a
 * gAMA+sRGB pair in a PNG is what rendered this repo's MBTI art pure black
 * through `next/image`, and these come from the same shelf.
 */
export const CATEGORY_ICON: Record<PlaceCategory, string> = {
  cafe: '/category-3d/cafe.png',
  restaurant: '/category-3d/restaurant.png',
  exhibition: '/category-3d/exhibition.png',
  shop: '/category-3d/shop.png',
  activity: '/category-3d/activity.png',
};
