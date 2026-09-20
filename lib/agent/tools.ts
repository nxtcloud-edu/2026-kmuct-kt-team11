/**
 * The agent's tools. SERVER ONLY.
 *
 * Every tool here reads something that actually exists. That is the whole
 * design rule of this file, and it is the reason there is no `plan_my_day` tool
 * that returns a plausible-looking itinerary out of the model's own knowledge of
 * Seoul: `app/(app)/home/page.tsx` already refuses to render an MBTI shelf
 * because there is no recommendation source behind it, and an agent that
 * invents what the screen declines to fake would undo that decision in a place
 * nobody is reviewing.
 *
 * So the agent can read the user's saved places, the places near them, and — when
 * `APIFY_TOKEN` is set — real Naver blog posts about a place. It composes a
 * course out of those. What it cannot do is source a venue from nowhere, and the
 * system instruction says so in as many words.
 *
 * AUTHORIZATION. Every tool that touches the database takes `userId` from the
 * closure built in `forUser()`, never from a model argument. A tool signature
 * with a `user_id` parameter would be an object-level authorization hole the
 * model could walk through by guessing a uuid — the same class of bug the
 * backend suite has 40 cases for. The model cannot name a user; it can only act
 * as the one whose session opened the stream.
 */

import { Type, type FunctionDeclaration, type Schema } from '@google/genai';

import { listPlacesNearby, listSavedPlacesForUser } from '../saved-places';
import { naverBlog } from '../research/sources/naver-blog';
import { ApifyError, ApifyNotConfiguredError, apifyConfigured } from '../ingest/apify';
import type { Place, SavedPlace } from '../api/types';
import type { Course, CourseStop, SourceLink } from './types';

/* ── Declarations ─────────────────────────────────────────────────────────── */

/**
 * Descriptions are written for the model, not for a human reading the file, so
 * they state the constraint rather than the capability. "Only call this once"
 * and "never invent" land better here than in the system instruction, because
 * they sit next to the thing being constrained.
 */

const listSavedPlacesDecl: FunctionDeclaration = {
  name: 'list_saved_places',
  description:
    '이 사용자가 저장해 둔 장소를 최신순으로 가져옵니다. 추천이나 코스를 만들기 전에 거의 항상 먼저 호출하세요. 인자 없이 호출하면 전부 가져옵니다.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      category: {
        type: Type.STRING,
        nullable: true,
        enum: ['cafe', 'restaurant', 'exhibition', 'shop', 'activity'],
        description: '이 분류만 남깁니다. 비우면 전체.',
      },
      area: {
        type: Type.STRING,
        nullable: true,
        description: '지역명으로 거릅니다(예: 성수, 연남). 저장된 표기와 정확히 같아야 합니다.',
      },
    },
    required: [],
  } as Schema,
};

const listNearbyDecl: FunctionDeclaration = {
  name: 'list_nearby_places',
  description:
    '사용자가 아직 저장하지 않은, 특정 지역의 장소를 가져옵니다. 저장한 곳만으로 코스가 부족하거나 새로운 곳을 물어볼 때 사용하세요.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      area: {
        type: Type.STRING,
        description: '지역명(예: 성수, 연남, 한남). 사용자의 활동 지역이 기본값입니다.',
      },
    },
    required: ['area'],
  } as Schema,
};

const researchDecl: FunctionDeclaration = {
  name: 'research_place_reviews',
  description:
    '한 장소에 대한 최근 6개월 네이버 블로그 후기 본문을 가져옵니다. 웨이팅, 분위기, 브레이크타임, 주의사항처럼 저장된 데이터에 없는 것을 물어볼 때만 사용하세요. 한 번의 대화에서 최대 두 곳까지만, 느리고 비용이 듭니다.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: '장소 이름. 저장된 표기 그대로.' },
      area: { type: Type.STRING, description: '장소가 있는 지역명(예: 성수).' },
    },
    required: ['name', 'area'],
  } as Schema,
};

/**
 * The course tool takes the finished itinerary as its argument and returns
 * almost nothing. It exists to get a STRUCTURE out of the model — the sheet
 * renders a card with times and stops, and parsing that back out of prose would
 * be a regex against a language model's formatting habits.
 *
 * `saved_place_id` is how a stop is tied to a real row. The model is told to
 * copy it from `list_saved_places` output and to send null rather than guess,
 * because a fabricated uuid renders as a link that 404s.
 */
const proposeCourseDecl: FunctionDeclaration = {
  name: 'propose_course',
  description:
    '완성된 코스를 사용자에게 카드로 보여줍니다. 코스를 글로 풀어 쓰지 말고 반드시 이 도구로 보내세요. 보낸 뒤에는 한두 문장으로 짧게만 덧붙이면 됩니다.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: '코스 이름. 짧게, 예: "성수 토요일 오후 코스".' },
      when: {
        type: Type.STRING,
        nullable: true,
        description: '사용자가 말한 때(예: "토요일 오후"). 말하지 않았으면 null.',
      },
      stops: {
        type: Type.ARRAY,
        description: '방문 순서대로. 2곳에서 5곳 사이.',
        items: {
          type: Type.OBJECT,
          properties: {
            order: { type: Type.INTEGER, description: '1부터 시작하는 방문 순서.' },
            name: { type: Type.STRING, description: '장소 이름.' },
            saved_place_id: {
              type: Type.STRING,
              nullable: true,
              description:
                'list_saved_places가 준 id를 그대로 복사. 저장한 곳이 아니면 반드시 null. 절대 지어내지 마세요.',
            },
            area: { type: Type.STRING, nullable: true },
            category: { type: Type.STRING, nullable: true },
            start: {
              type: Type.STRING,
              nullable: true,
              description: '"13:00" 형식 24시간 시각. 시간을 정하지 못하면 null.',
            },
            minutes: { type: Type.INTEGER, nullable: true, description: '머무는 시간(분).' },
            why: { type: Type.STRING, description: '왜 이 순서 이 자리인지 한 문장.' },
          },
          required: ['order', 'name', 'saved_place_id', 'area', 'category', 'start', 'minutes', 'why'],
          propertyOrdering: [
            'order', 'name', 'saved_place_id', 'area', 'category', 'start', 'minutes', 'why',
          ],
        },
      },
      notes: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: '휴무일, 이동 시간, 웨이팅처럼 코스에 붙는 주의사항. 없으면 빈 배열.',
      },
    },
    required: ['title', 'when', 'stops', 'notes'],
    propertyOrdering: ['title', 'when', 'stops', 'notes'],
  } as Schema,
};

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  listSavedPlacesDecl,
  listNearbyDecl,
  researchDecl,
  proposeCourseDecl,
];

/* ── Execution ────────────────────────────────────────────────────────────── */

/** What a tool call produced, beyond the JSON handed back to the model. */
export type ToolOutcome = {
  /** Fed back to the model as the function response. */
  response: Record<string, unknown>;
  /** Korean UI copy for the status line, written where the work happens. */
  label: string;
  /** Emitted to the client as a card. */
  course?: Course;
  /** Receipts to show under the answer. */
  sources?: SourceLink[];
};

/** Trimmed to what a recommendation actually needs. Sending the full row wastes context on `confirmed` and `group_id`. */
function forModel(s: SavedPlace) {
  return {
    saved_place_id: s.id,
    name: s.place?.name ?? null,
    category: s.place?.category ?? null,
    area: s.place?.area ?? null,
    address: s.place?.address ?? null,
    // The line the creator wrote about it in the reel. The single most useful
    // field for "why this place", and the only one in the user's own voice.
    hook: s.hook,
    saved_at: s.saved_at,
  };
}

/** Per §4.1's recency window, and the same six months the refresh job uses. */
function sixMonthsAgo(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d;
}

/**
 * A blog body runs to thousands of characters and the agent reads up to ten of
 * them. Uncapped, one research call would crowd the saved places out of the
 * context window that the answer is supposed to be grounded in. 1200 characters
 * is long enough to hold a wait claim together with the qualifier that makes it
 * usable, which is the thing §7.3 says a snippet cannot do.
 */
const BODY_CHARS = 1200;

/**
 * Builds the executors bound to one user.
 *
 * `userId` is captured here, once, and is unreachable from any model argument.
 * See the authorization note at the top of the file.
 */
export function forUser(userId: string, homeArea: string | null) {
  async function run(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    switch (name) {
      case 'list_saved_places': {
        const all = await listSavedPlacesForUser(userId, 60);
        const category = typeof args.category === 'string' ? args.category : null;
        const area = typeof args.area === 'string' ? args.area : null;

        const filtered = all.filter(
          (s) =>
            (!category || s.place?.category === category) && (!area || s.place?.area === area),
        );

        return {
          label: '저장한 곳을 보는 중',
          response: {
            // Reported even when it is zero, and reported separately from
            // `places`. "You have saved nothing" and "nothing matched your
            // filter" need different answers, and an empty array alone cannot
            // tell the model which one happened.
            total_saved: all.length,
            returned: filtered.length,
            places: filtered.map(forModel),
          },
        };
      }

      case 'list_nearby_places': {
        const area = (typeof args.area === 'string' && args.area) || homeArea;
        if (!area) {
          return {
            label: '근처를 보는 중',
            response: { error: '지역을 알 수 없습니다. 사용자에게 어느 동네인지 물어보세요.' },
          };
        }
        const rows = await listPlacesNearby(area, userId, 12);
        return {
          label: `${area} 근처를 보는 중`,
          response: { area, count: rows.length, places: rows },
        };
      }

      case 'research_place_reviews': {
        const name_ = typeof args.name === 'string' ? args.name.trim() : '';
        const area = typeof args.area === 'string' ? args.area.trim() : '';
        if (!name_) {
          return { label: '후기를 찾는 중', response: { error: '장소 이름이 비어 있습니다.' } };
        }

        if (!apifyConfigured()) {
          // Degrade loudly and in the model's own language, so it tells the user
          // it could not look rather than answering from memory as if it had.
          return {
            label: '후기를 찾는 중',
            response: {
              error:
                '블로그 후기 검색이 이 환경에 설정되어 있지 않습니다(APIFY_TOKEN 없음). 후기를 확인하지 못했다고 사용자에게 분명히 말하고, 저장된 정보만으로 답하세요.',
            },
          };
        }

        // A synthetic `Place`: the source needs a name, aliases and an area to
        // build its query and run its match, and the other fields are the map's,
        // not the blog's. Coordinates are unknown here and are never read by
        // `NaverBlogSource` — filling them with zeros would be a lie in a field
        // nobody asked for, so they carry the place's own if we have it.
        const place: Place = {
          id: '',
          name: name_,
          name_alt: [],
          category: 'cafe',
          lat: 0,
          lng: 0,
          address: null,
          area,
        };

        try {
          const posts = await naverBlog.reviews(place, sixMonthsAgo());

          if (posts.length === 0) {
            return {
              label: `${name_} 후기를 찾는 중`,
              response: {
                place: name_,
                count: 0,
                note: '최근 6개월 안에 이 장소를 본문에서 언급한 블로그 글을 찾지 못했습니다. 후기가 없다고 말하되, 장소가 없다는 뜻은 아니라고 덧붙이세요.',
              },
            };
          }

          return {
            label: `${name_} 후기 ${posts.length}건을 읽는 중`,
            sources: posts.map((p) => ({
              title: p.title,
              url: p.url,
              posted_at: p.postedAt.toISOString().slice(0, 10),
            })),
            response: {
              place: name_,
              count: posts.length,
              // The URL travels with every excerpt so a claim the model makes
              // can be attributed to the post it came from, rather than to "a
              // blog" — a receipt that cannot be followed is not one.
              posts: posts.map((p) => ({
                title: p.title,
                url: p.url,
                posted_at: p.postedAt.toISOString().slice(0, 10),
                excerpt: p.body.slice(0, BODY_CHARS),
              })),
            },
          };
        } catch (e) {
          if (e instanceof ApifyNotConfiguredError) {
            return {
              label: '후기를 찾는 중',
              response: { error: '블로그 후기 검색이 설정되어 있지 않습니다.' },
            };
          }
          if (e instanceof ApifyError) {
            // Loud in the log, vague to the model: it should say it could not
            // check, not relay an upstream status code to the user.
            console.error('[agent] naver-blog research failed', e.message);
            return {
              label: '후기를 찾는 중',
              response: {
                error:
                  '블로그 후기를 가져오지 못했습니다. 후기를 확인하지 못했다고 말하고 저장된 정보만으로 답하세요.',
              },
            };
          }
          throw e;
        }
      }

      case 'propose_course': {
        const course = normaliseCourse(args);
        return {
          label: '코스를 짜는 중',
          course,
          // The model gets back only an acknowledgement. Echoing the course
          // would invite it to restate the whole thing in prose underneath the
          // card the user is already looking at.
          response: { ok: true, stops: course.stops.length },
        };
      }

      default:
        return { label: '처리 중', response: { error: `알 수 없는 도구: ${name}` } };
    }
  }

  return { run };
}

/* ── Course normalisation ─────────────────────────────────────────────────── */

function s(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Coerces rather than rejects, for the same reason `lib/extract/caption.ts`
 * does: the response schema already constrained the shape server-side, so what
 * is left is tidying. Throwing away a five-stop course because one stop came
 * back with `minutes: "90"` would be the wrong trade — the user loses the whole
 * card to fix a field that is about to be rendered as text anyway.
 *
 * The one thing that is NOT coerced is `saved_place_id`. A uuid is either one we
 * gave the model or it is invented, and an invented one becomes a link to a
 * place that does not exist. Anything that is not uuid-shaped becomes null.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normaliseCourse(args: Record<string, unknown>): Course {
  const rawStops = Array.isArray(args.stops) ? args.stops : [];

  const stops: CourseStop[] = rawStops
    .map((raw, i): CourseStop | null => {
      const st = (raw ?? {}) as Record<string, unknown>;
      const name = s(st.name);
      if (!name) return null;

      const order = Number(st.order);
      const minutes = Number(st.minutes);
      const id = s(st.saved_place_id);

      return {
        order: Number.isInteger(order) && order > 0 ? order : i + 1,
        name,
        saved_place_id: id && UUID.test(id) ? id : null,
        area: s(st.area),
        category: s(st.category),
        // Accept "9:00" as well as "09:00" and normalise; reject anything else
        // rather than render "오후쯤" in a slot the card formats as a time.
        start: normaliseTime(s(st.start)),
        minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
        why: s(st.why) ?? '',
      };
    })
    .filter((st): st is CourseStop => st !== null)
    .sort((a, b) => a.order - b.order)
    // Re-number after the sort so a card never shows 1, 2, 2, 4 because the
    // model repeated an ordinal.
    .map((st, i) => ({ ...st, order: i + 1 }));

  return {
    title: s(args.title) ?? '오늘의 코스',
    when: s(args.when),
    stops,
    notes: (Array.isArray(args.notes) ? args.notes : [])
      .map((n) => s(n))
      .filter((n): n is string => n !== null),
  };
}

function normaliseTime(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
