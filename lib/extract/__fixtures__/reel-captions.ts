/**
 * Caption fixtures for the deterministic parser.
 *
 * `TEN_CAFE_CAPTION` is built around entry 2 EXACTLY as
 * docs/gaja/reel-extraction-findings.md quotes it from the real reel
 * (@koh_min_, shortcode DZrAQQMPiAt) — same emoji, same two-space indent on the
 * address line, same spacing. The other entries are constructed in that grammar;
 * the real caption ran to ten, this one to six, because the thing under test is
 * the grammar and the tail, not the count.
 *
 * The tail is the point of the fixture. It reproduces what the findings say cost
 * a naive regex its accuracy: a 📍 of its own, an address-shaped line, and the
 * CREATOR's @handle. A parser that reads markers instead of numbered blocks
 * returns seven venues here.
 */

export const TEN_CAFE_CAPTION = `여름 날에 다녀오기 좋은 싱그러운 카페 10곳 ☀️

1.📍호우주의보 (HOWOO) @howoo.seoul
  서울 광진구 아차산로78길 110
🕰️매일 11:00-22:00 월 휴무
📓아인슈페너 (6,000) 바스크치즈케이크 (7,500)

2.📍우이그 (UIG) @uig.official
  서울 마포구 망원로3길 7
🕰️매일 11:00-22:30 금,토 11:00-23:00
📓티그레 (4,200) 아메리카노 (4,800)

3.📍김진환제과점
  서울 용산구 후암동 2-1
🕰️매일 08:00-20:00
📓밤식빵 (6,500) 소금빵 (3,000)

4.📍포레스트 아웃팅스 (Forest Outings) @forest.outings
  경기 고양시 덕양구 충장로 63
🕰️매일 10:30-22:00
📓콜드브루 (5,500) 밀크티 (6,000)

5.📍녹기 전에 @before.it.melts
  서울 마포구 신촌로12다길 17
🕰️화-일 13:00-22:00 월 휴무

6.📍테디뵈르하우스 (Teddy Beurre House) @teddybeurrehouse
  서울 용산구 후암로40길 3
🕰️매일 12:00-19:00
📓크루아상 (4,500) 뺑오쇼콜라 (5,000)

📍협업 및 광고 문의는 프로필 링크로 받고 있어요
서울 강남구 테헤란로 152 스파크플러스 5층
@koh_min_ 팔로우하고 다음 카페 리스트도 받아보세요 ☕️
#서울카페 #카페투어 #망원동카페 #연남동카페 #서울카페추천
`;

/**
 * The failure the findings predict: "Emoji are the delimiters. Robust in this
 * sample, absent the moment a creator uses a dash." Same tail problem, no marker
 * to hang a parse on — only the numbering.
 */
export const DASH_DELIMITED_CAPTION = `서울에서 빵 제일 잘하는 집 3곳 🥐

1. 밀도 - 서울 성동구 아차산로 68
2. 김진환제과점 - 서울 용산구 후암동 2-1
3. 테디뵈르하우스 - 서울 용산구 후암로40길 3

@bread_lover_ 팔로우하고 다음 리스트도 받아보세요
#서울빵집 #베이커리투어
`;

/**
 * No markers and no separator either: the name on one line, the address on the
 * next. The last entry runs straight into the creator's sign-off with no blank
 * line between them worth trusting, which is where a line-counting parser
 * quietly adopts `@walk_seoul` as a venue handle.
 */
export const BARE_NUMBERED_CAPTION = `망원동 반나절 산책 코스

1. 우이그
서울 마포구 망원로3길 7

2. 소금집델리
서울 마포구 포은로8길 13

@walk_seoul 저장해두고 주말에 다녀오세요
#망원동 #서울산책
`;

/**
 * The case the address window exists for: entries that list hours but NO
 * address, followed by a tail whose business-inquiry line is address-shaped and
 * carries no 📍 to terminate the block on.
 *
 * Without the rule that the unmarked line is only read between 📍 and 🕰️, the
 * last venue here silently acquires the creator's coworking-space address —
 * which then geocodes, and looks entirely plausible in the product.
 */
export const NO_ADDRESS_CAPTION = `요즘 자주 가는 야장 2곳 🍺

1.📍호우주의보 @howoo.seoul
🕰️매일 17:00-01:00
📓감자튀김 (9,000)

2.📍소금집델리 @salt.house
🕰️매일 12:00-22:00

서울 강남구 테헤란로 152 스파크플러스 5층 (광고·협업 문의)
@koh_min_ 저장해두고 퇴근길에 들러보세요
#서울야장 #맥주
`;
