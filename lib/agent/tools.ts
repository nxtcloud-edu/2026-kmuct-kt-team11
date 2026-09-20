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
 * `discover_places` LOOKS LIKE AN EXCEPTION TO THAT AND IS NOT. It returns venue
 * names the product has never seen, which is the whole reason it exists: the
 * database covers 망원동, 성수동, 연남동 and a dozen others and holds NOTHING in
 * 강남, so "강남에서 9시 반 넘어 갈 만한 데" had exactly one honest answer, which
 * was to decline. But every name it returns comes with the URL of the post it
 * was read out of, and that is the difference between discovery and invention.
 * The model is told to present them as 다른 사람 글에서 찾은 곳, they never enter
 * `propose_course`, and saving one writes a row with no pin rather than a new
 * `places` record. The rule was never "only places we already have"; it was
 * "never a place nobody can check".
 *
 * WHAT THE TOOLS NOW SAY ABOUT HOURS. `hours_raw` has been on every
 * reel-sourced venue since 20260920000005 and nothing exposed it, so the one
 * question a 저녁 9시 반 plan turns on was unanswerable. It is exposed here,
 * nested under `caption` and never beside `place.address`, with the caveat
 * repeated in the tool response and again in the system instruction. It is NOT
 * parsed into a weekly schedule anywhere — that laundering is the reason the
 * column is stored raw (docs/gaja/reel-extraction-findings.md).
 *
 * AUTHORIZATION. Every tool that touches the database takes `userId` from the
 * closure built in `forUser()`, never from a model argument. A tool signature
 * with a `user_id` parameter would be an object-level authorization hole the
 * model could walk through by guessing a uuid — the same class of bug the
 * backend suite has 40 cases for. The model cannot name a user; it can only act
 * as the one whose session opened the stream.
 */

import { Type, type FunctionDeclaration, type Schema } from '@google/genai';

import {
  captionEntriesForSavedPlaces,
  hoursClaimsForPlaces,
  listPlacesNearby,
  listSavedPlacesForUser,
} from '../saved-places';
import { naverBlog } from '../research/sources/naver-blog';
import { ApifyError, ApifyNotConfiguredError, apifyConfigured } from '../ingest/apify';
import {
  NearbyNotConfiguredError,
  streamNearbyPlaces,
  type NearbyCandidate,
  type NearbyResult,
} from '../research/nearby';
import type { Place, PlaceCategory, SavedPlace } from '../api/types';
import type { Course, CourseStop, PlaceSuggestion, SourceLink } from './types';

/**
 * THE CATEGORY UNIONS AGREE, PROVEN AT BUILD TIME.
 *
 * `PlaceSuggestion.category` restates the five values rather than importing
 * `PlaceCategory`, because `lib/agent/types.ts` is reached from a Client
 * Component and its header says to keep it inert. This file holds both, so this
 * is where the duplication is checked — the same device, for the same reason,
 * that `lib/research/resolve-place.ts` uses for `lib/extract/types.ts`. Each
 * parameter's DEFAULT is one union and its CONSTRAINT is the other, and a sixth
 * category added to one list and not the other fails `npx tsc --noEmit` here,
 * naming both.
 */
type SuggestionCategory = NonNullable<PlaceSuggestion['category']>;
export type SuggestionCategoryAgrees<
  Suggested extends PlaceCategory = SuggestionCategory,
  Api extends SuggestionCategory = PlaceCategory,
> = [Suggested, Api];

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
 * THE EXPENSIVE ONE, and the description is written almost entirely as a
 * restraint because that is what the model gets wrong about it.
 *
 * It is the only tool here that can name a venue Gaja has never heard of, which
 * makes it the answer to the question the assistant currently cannot answer at
 * all — "강남에서 갈 만한 데" when `places` holds nothing in 강남 — and also the
 * one tool that could quietly turn this product into a scraper with a chat box.
 * The guard rails, in order of how much they cost to breach: the model is told
 * to try the cheap tools first, the executor refuses a second call in the same
 * turn, and the executor refuses any call that starts too late in the turn to
 * finish.
 */
const discoverDecl: FunctionDeclaration = {
  name: 'discover_places',
  description:
    '저장된 곳에도 근처 목록에도 없는 지역의 장소를, 네이버 블로그와 인스타그램 글에서 찾아옵니다. 마지막 수단입니다 — list_saved_places와 list_nearby_places가 빈 결과를 준 다음에만, 한 대화에서 딱 한 번만 부르세요. 30초 넘게 걸리고 비용이 듭니다. 결과는 가자가 확인한 장소가 아니라 남의 글에 적힌 이름이므로, 반드시 "다른 사람 글에서 찾은 곳"으로 소개하고 출처 링크를 함께 말하세요. 여기서 나온 곳은 propose_course에 넣지 마세요.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      area: {
        type: Type.STRING,
        description: '찾을 지역의 동/역 이름(예: 강남, 역삼동, 성수). 사용자가 말한 그대로.',
      },
      category: {
        type: Type.STRING,
        nullable: true,
        enum: ['cafe', 'restaurant', 'exhibition', 'shop', 'activity'],
        description: '찾을 종류. 사용자가 말하지 않았으면 null — 그러면 "가볼만한곳"으로 찾습니다.',
      },
    },
    required: ['area'],
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
  discoverDecl,
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
  /** Venues we hold no row for, each with its receipt and a save control. */
  suggestions?: PlaceSuggestion[];
};

/**
 * Trimmed to what a recommendation actually needs. Sending the full row wastes
 * context on `confirmed` and `group_id`.
 *
 * `caption` is the creator's claims about this venue, nested rather than spread,
 * and the nesting is the warning — the same device `lib/saved-places.ts` uses on
 * `SavedPlaceDetail` and for the same reason. `place.address` and
 * `caption.hours_raw` sitting at the same depth would read as two facts of one
 * kind. One is a geocoded row in our own table; the other is a sentence a
 * stranger typed under a video.
 */
function forModel(s: SavedPlace, caption: CaptionClaims | null) {
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
    // Absent, not null-filled, when the row came from no reel or the caption
    // named nothing useful. An object of five nulls invites the model to mention
    // that it does not know the hours, which nobody asked.
    ...(caption &&
    (caption.hours_raw || caption.menu_raw || caption.handle || caption.name_alt)
      ? {
          caption: {
            name_alt: caption.name_alt,
            handle: caption.handle,
            /** RAW. Never parsed into a schedule here — see the note below. */
            hours_raw: caption.hours_raw,
            menu_raw: caption.menu_raw,
          },
        }
      : {}),
    // The reel this came from, so a caption claim the model repeats has a link
    // the user can go and check for themselves.
    source_url: s.source_url,
  };
}

/** Structurally what `CaptionEntry` gives us, without importing the ordinal we do not use. */
type CaptionClaims = {
  name_alt: string | null;
  handle: string | null;
  hours_raw: string | null;
  menu_raw: string | null;
};

/**
 * The declaration carries an `enum`, and Gemini honours it — but a tool argument
 * is model output, and model output is validated, not trusted. An unrecognised
 * string becomes `null`, which `searchWord` turns into `가볼만한곳`; the
 * alternative is handing an arbitrary string to a paid actor as a search term.
 */
const CATEGORIES = new Set<string>(['cafe', 'restaurant', 'exhibition', 'shop', 'activity']);

/**
 * `NearbyCandidate` -> `PlaceSuggestion`.
 *
 * Almost a rename, and deliberately so — the two types say the same thing
 * because they are the same claim, and the conversion exists only so the sheet
 * does not have to import `lib/research/nearby.ts` (a server module) to name the
 * shape it renders.
 *
 * WHAT IS DROPPED, AND WHY. `thumbUrl` — Gaja stores no third-party media, and a
 * remote image in a chat bubble is a request to somebody else's CDN carrying
 * which conversation the user is in. `sourceHandle` — the save route does not
 * take it and the card does not show it; the link is the attribution.
 *
 * `hours_raw` is NOT dropped. It was never there: `NearbyCandidate` does not
 * carry it, even though `extractPlacesFromCaption` reads it off the same
 * captions. So a discovered venue has no hours, which is stated to the model as
 * an absence rather than left for it to fill in.
 */
function toSuggestion(c: NearbyCandidate, area: string): PlaceSuggestion {
  return {
    key: c.key,
    name: c.name,
    name_alt: c.nameAlt,
    address: c.address,
    // The 동 THE SEARCH WAS RUN FOR, not one read off this venue — no extractor
    // returns an area and guessing one from a written address is how a café in
    // 강남구 논현동 ends up filed under 강남역.
    area,
    category: c.category,
    category_confidence: c.categoryConfidence,
    source: c.source,
    source_url: c.sourceUrl,
    source_title: c.sourceTitle,
    posted_at: c.postedAt,
  };
}

/**
 * The loser of the deadline race, as a value rather than a rejection.
 *
 * A timeout that throws would land in the same `catch` as a real failure and get
 * reported to the model as "the search broke", which is not what happened — the
 * search was working and we stopped waiting. A unique symbol keeps the two
 * apart, and `Promise.race` narrows against it cleanly.
 */
const EXPIRED: unique symbol = Symbol('discovery-deadline');

/**
 * Resolves to `EXPIRED` after `ms`.
 *
 * `unref` so a pending timer cannot hold a Node process open past the work it
 * was timing — the loser of every race is a timer nobody clears, and on a
 * long-lived server that is a handle per discovery call. Guarded because the
 * method does not exist on the browser's `Timeout`, and this module is typed
 * against both.
 */
function expire(ms: number): Promise<typeof EXPIRED> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(EXPIRED), ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Many venues come out of one post, and one receipt per post is what a reader wants. */
function dedupeSources(links: SourceLink[]): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  for (const l of links) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
  }
  return out;
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

/* ── The discovery budget ─────────────────────────────────────────────────── */

/**
 * How late in a turn `discover_places` may still be started.
 *
 * `app/api/agent/route.ts` gives a turn 180 seconds. One discovery call is two
 * concurrent Apify actor runs plus up to fourteen Gemini extractions — the
 * sibling route that does nothing else budgets 120s for exactly that work — and
 * the turn still owes a model call afterwards to write the answer. So the sum
 * that matters is: elapsed + discovery + one more model call < 180.
 *
 * 45 seconds of elapsed turn is the line. Below it, a 120s discovery and a ~10s
 * answer still land inside the budget. Above it, the honest move is to refuse
 * and say why, because the alternative is a function the platform kills
 * mid-search — and a killed function does not get to apologise. The user sees
 * the spinner stop and nothing else.
 *
 * This is a floor under the model's judgement, not a substitute for it: the
 * system instruction tells it to call the cheap tools first, and by the time it
 * has done that, five or ten seconds have gone, not forty-five.
 */
const DISCOVERY_LATEST_START_MS = 45_000;

/**
 * How long a discovery may run once started, after which it is abandoned.
 *
 * A start deadline alone is not a budget, because the work has no ceiling of its
 * own. Both sources cap their actor at 90 seconds and abort the request at 100,
 * but `runActor` treats its OWN abort as a retryable transport failure and tries
 * again — which is right for a background ingest pass and unbounded here. Two
 * retries of a hanging actor is five minutes, and at five minutes the platform
 * kills the function: no answer, no error event, the sheet's spinner simply
 * stops. That is the single worst outcome available on this surface, and it is
 * reachable through a dependency neither of these files controls.
 *
 * So the drain is raced against this, and the generator is dropped when it wins.
 * 100s is one full source phase plus the extraction pass — the honest duration —
 * and 45 + 100 leaves the turn better than half a minute to write its answer.
 * Abandoning is not free (the actor run is already billed) but it buys the only
 * thing that matters at that point, which is a turn that can still say what
 * happened.
 */
const DISCOVERY_BUDGET_MS = 100_000;

/** Enough of a scraped list to choose from; more is a wall of unverified names. */
const MAX_SUGGESTIONS = 8;

/** Trimmed for the model. The full candidate carries a thumbnail and a React key it has no use for. */
function suggestionForModel(s: PlaceSuggestion) {
  return {
    name: s.name,
    name_alt: s.name_alt,
    address: s.address,
    category: s.category,
    category_confidence: s.category_confidence,
    // Travels with every venue rather than in a separate list, so a name the
    // model repeats to the user has its receipt attached at the point of use and
    // cannot be paired with the wrong post three sentences later.
    source_url: s.source_url,
    source_title: s.source_title,
    posted_at: s.posted_at,
  };
}

/**
 * Builds the executors bound to one user.
 *
 * `userId` is captured here, once, and is unreachable from any model argument.
 * See the authorization note at the top of the file.
 *
 * `forUser` is called once per turn by `lib/agent/run.ts`, which is what makes
 * the two closures below a per-TURN budget rather than a per-process one. A
 * model that decides to search 강남 and then 홍대 gets told no the second time,
 * in Korean, at a cost of zero Apify runs.
 */
export function forUser(userId: string, homeArea: string | null) {
  const turnStartedAt = Date.now();
  let discoveries = 0;

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

        // One extra round trip for the whole page, not one per row. See
        // `captionEntriesForSavedPlaces` for why these are not folded into
        // `SavedPlace` itself.
        const captions = await captionEntriesForSavedPlaces(
          filtered.map((s) => s.id),
          userId,
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
            // Said once, next to the data it governs, and repeated in the system
            // instruction. A model reading `hours_raw: '매일 11:00-22:30'` with no
            // qualifier in sight will report it as opening hours, because that is
            // what the field is called.
            hours_note:
              'hours_raw는 영상/글을 올린 사람이 캡션에 적어둔 문장을 그대로 옮긴 것입니다. 가자가 확인한 영업시간이 아닙니다. 반드시 "캡션에는 …라고 적혀 있어요" 처럼 인용해서 말하고, 단정하지 마세요.',
            places: filtered.map((s) => forModel(s, captions.get(s.id) ?? null)),
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
        const hours = await hoursClaimsForPlaces(rows.map((r) => r.id));

        return {
          label: `${area} 근처를 보는 중`,
          response: {
            area,
            count: rows.length,
            // Only present when some row actually carried one — an unconditional
            // caveat about a field that is null everywhere teaches the model to
            // skim caveats.
            ...(hours.size > 0
              ? {
                  hours_note:
                    'hours_raw는 이 장소를 소개한 릴스 캡션에 적혀 있던 문장 그대로입니다. 가자가 확인한 영업시간이 아니므로 인용해서 말하고 단정하지 마세요.',
                }
              : {}),
            places: rows.map((r) => {
              const claim = hours.get(r.id);
              return {
                ...r,
                hours_raw: claim?.hours_raw ?? null,
                hours_source_url: claim?.source_url ?? null,
              };
            }),
          },
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

      case 'discover_places': {
        const area = typeof args.area === 'string' ? args.area.trim() : '';
        if (!area) {
          return {
            label: '새로운 곳을 찾는 중',
            response: { error: '지역 이름이 비어 있습니다. 사용자에게 어느 동네인지 물어보세요.' },
          };
        }

        const category = CATEGORIES.has(args.category as string)
          ? (args.category as PlaceCategory)
          : null;

        // ── The two refusals that cost nothing ────────────────────────────
        // Both are checked before a single actor run, and both answer in the
        // model's own language rather than as an error, so the turn continues
        // with an honest sentence instead of a failed tool.
        if (discoveries > 0) {
          return {
            label: '새로운 곳을 찾는 중',
            response: {
              error:
                '이 대화에서는 새로 찾아보기를 이미 한 번 썼습니다. 다시 부를 수 없으니, 이미 찾은 결과와 저장된 곳으로 답하세요.',
            },
          };
        }

        const elapsed = Date.now() - turnStartedAt;
        if (elapsed > DISCOVERY_LATEST_START_MS) {
          console.warn(`[agent] discovery refused: ${elapsed}ms already spent this turn.`);
          return {
            label: '새로운 곳을 찾는 중',
            response: {
              error:
                '지금 찾아보기를 시작하면 답변 시간 안에 끝나지 않습니다. 찾아보지 못했다고 말하고, 저장된 곳으로 답하거나 다시 물어봐 달라고 하세요.',
            },
          };
        }
        discoveries++;

        // `streamNearbyPlaces` is the nearby screen's engine, called and not
        // copied. Its caps (2 actor runs, 14 extractions, 12 months) live in
        // that file and nothing here can raise them — which is the point of
        // calling it rather than reimplementing the chain.
        //
        // ITS ANCHOR IS A SEARCH, NOT A PLACE. `name` seeds the dedupe set that
        // stops the anchor being proposed as somewhere to go next; here the
        // "anchor" is the area itself, so passing the area drops a candidate
        // named exactly 강남 and nothing else. `fold` is exact-match, so 강남면옥
        // survives.
        const events = streamNearbyPlaces({ name: area, area, category });

        let result: NearbyResult | null = null;
        let streamError: string | null = null;
        let timedOut = false;
        const deadline = Date.now() + DISCOVERY_BUDGET_MS;

        try {
          // Hand-driven rather than `for await`, because each step has to be
          // raced against the deadline above. The intermediate events — which
          // source landed, how many posts have been read — drive the nearby
          // SCREEN's progress list; the sheet has one status line, which is
          // already saying the true thing, so they are read and dropped. The
          // alternative is a status line flickering through six labels in
          // thirty seconds.
          for (;;) {
            const left = deadline - Date.now();
            if (left <= 0) {
              timedOut = true;
              break;
            }
            const step = await Promise.race([events.next(), expire(left)]);
            if (step === EXPIRED) {
              timedOut = true;
              break;
            }
            if (step.done) break;
            if (step.value.type === 'result') result = step.value.result;
            if (step.value.type === 'error') streamError = step.value.detail;
          }
        } catch (e) {
          if (e instanceof NearbyNotConfiguredError) {
            // Degrade loudly and in the model's own language, exactly as
            // `research_place_reviews` does: it must tell the user it could not
            // look, rather than answering from memory as if it had. The variable
            // name is a billed credential and goes to the log, never the model.
            console.error(`[agent] discovery not configured: ${e.variable} is unset.`);
            return {
              label: '새로운 곳을 찾는 중',
              response: {
                error:
                  '새로운 곳을 찾는 기능이 이 환경에 설정되어 있지 않습니다. 찾아보지 못했다고 사용자에게 분명히 말하고, 저장된 곳만으로 답하세요.',
              },
            };
          }
          console.error('[agent] discovery failed', e);
          return {
            label: '새로운 곳을 찾는 중',
            response: {
              error:
                '새로운 곳을 찾지 못했습니다. 찾아보려 했지만 실패했다고 말하고, 저장된 곳으로 답하세요.',
            },
          };
        }

        if (timedOut) {
          // NOT awaited. `.return()` resumes the generator at its next
          // suspension point, and the thing it is suspended on is the actor run
          // that just overran — awaiting it would wait out exactly the wait this
          // deadline exists to escape. Fire it so the generator's `finally`
          // blocks run, and walk away. Same posture as the nearby route's
          // `cancel()`.
          void events.return(undefined).catch(() => {});
          console.warn(`[agent] discovery for ${area} exceeded ${DISCOVERY_BUDGET_MS}ms; abandoned.`);
          return {
            label: `${area}에서 새로운 곳을 찾는 중`,
            response: {
              error:
                '찾아보는 데 시간이 너무 오래 걸려서 중간에 멈췄습니다. 이번에는 찾지 못했다고 말하고, 저장된 곳으로 답하거나 조금 뒤에 다시 물어봐 달라고 하세요.',
            },
          };
        }

        if (!result) {
          return {
            label: `${area}에서 새로운 곳을 찾는 중`,
            response: {
              error:
                streamError ??
                '새로운 곳을 찾지 못했습니다. 찾아보지 못했다고 말하고 저장된 곳으로 답하세요.',
            },
          };
        }

        // Re-bound to a const so the narrowing survives into the closure
        // below — `result` is a `let` assigned inside the loop above, and TS
        // resets a `let`'s narrowing across a function boundary.
        const found = result;
        const suggestions = found.candidates
          .slice(0, MAX_SUGGESTIONS)
          .map((c) => toSuggestion(c, found.area));

        if (suggestions.length === 0) {
          return {
            label: `${area}에서 새로운 곳을 찾는 중`,
            // The per-source verdicts go back untouched. "Both scrapers returned
            // nothing" and "they returned posts that named no venue we could
            // read" are different sentences, and `lib/research/nearby.ts` went to
            // some trouble to keep them apart; collapsing them here would undo
            // that one frame from where it matters.
            response: {
              area: found.area,
              searched: found.keyword,
              count: 0,
              sources: found.sources,
              note: `${found.area} 관련 글에서 장소 이름을 찾지 못했습니다. 찾아봤지만 나온 게 없다고 말하세요 — 그 동네에 아무것도 없다는 뜻은 아닙니다.`,
            },
          };
        }

        return {
          label: `${area}에서 ${suggestions.length}곳을 찾았어요`,
          // The cards the user can save from. They travel as their own event so
          // the sheet can render a 미확인 chip and a save control, which is the
          // only shape in which an unverified scraped name is allowed on screen.
          suggestions,
          // Receipts, in the same list the blog research already fills. A
          // suggestion whose URL is dropped is a suggestion indistinguishable
          // from an invention.
          sources: dedupeSources(
            suggestions.map((s) => ({
              title: s.source_title,
              url: s.source_url,
              posted_at: s.posted_at ? s.posted_at.slice(0, 10) : null,
            })),
          ),
          response: {
            area: found.area,
            searched: found.keyword,
            count: suggestions.length,
            sources: found.sources,
            // The three sentences that decide how these get presented, stated at
            // the point of use rather than only in the system instruction —
            // thirty turns of history later, this is the text sitting next to the
            // data.
            note:
              '이 장소들은 가자가 확인한 곳이 아니라, 다른 사람이 쓴 블로그 글과 릴스에서 이름만 읽어온 것입니다. "다른 사람 글에서 찾은 곳"이라고 분명히 밝히고, 각 장소마다 source_url을 함께 말하세요. 영업시간, 주소, 웨이팅은 여기에 없으니 지어내지 마세요. 화면에 어떤 버튼이 있는지는 말하지 마세요. propose_course에는 넣지 마세요 — 코스는 저장된 곳으로만 짭니다.',
            places: suggestions.map(suggestionForModel),
          },
        };
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
