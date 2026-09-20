/**
 * Rung one of the extraction ladder: a reel caption in, place candidates out.
 *
 * SERVER ONLY. `GEMINI_API_KEY` is a real secret and a billed one. It must never
 * be prefixed `NEXT_PUBLIC_` (that prefix inlines the value into the browser
 * bundle at build time — see next/dist/docs/01-app/02-guides/environment-variables.md),
 * never be imported from anything under `app/` that a client component can
 * reach, and never be logged, echoed into an error message, or put in a problem
 * response. The same rule `.env.example` already states for
 * `NAVER_MAP_CLIENT_SECRET`, for the same reason.
 *
 * WHY a model at all, when lib/extract/caption-grammar.ts parses the one sample
 * we have without one: the sample is a creator who formats carefully. The
 * findings are explicit that single-venue reels and paragraph captions are
 * unmeasured, and a regex cannot read a caption that says "the second one is
 * around the corner from the first". The grammar parser is the floor; this is
 * the ceiling. They share `PlaceCandidate`, and they share `deriveConfidence`,
 * so a caller never has to know which one ran.
 *
 * WHY structured output rather than "return JSON" in the prompt: `responseSchema`
 * constrains decoding, so the failure mode is a missing field rather than an
 * apology wrapped in a code fence. A caption is Korean, mixed-script and
 * emoji-delimited — exactly the input where a model is most tempted to explain
 * itself instead of answering.
 */

import { GoogleGenAI, Type, type Schema } from '@google/genai';

import { countNumberedBlocks, deriveConfidence } from './caption-grammar';
import type { CaptionExtraction, PlaceCandidate, PlaceCandidateCategory } from './types';

/**
 * The enum the model is constrained to, and the list the normaliser checks
 * against. One array so the prompt and the guard can never disagree — a model
 * answering `'bar'` because the schema and the parser were edited apart is the
 * failure this avoids.
 */
const CATEGORIES = ['cafe', 'restaurant', 'exhibition', 'shop', 'activity'] as const;
const CATEGORY_CONFIDENCES = ['low', 'medium', 'high'] as const;

/**
 * Pinned, not `gemini-flash-lite-latest`.
 *
 * A caption parser is the kind of thing whose output shape people build on; an
 * alias that silently moves under it turns a model upgrade into an unexplained
 * change in extraction results with no diff to point at. Flash-lite because this
 * is short-context field-copying over a 1.2 KB caption — the expensive judgement
 * in this pipeline is the review digest, not this.
 */
const MODEL = 'gemini-3.1-flash-lite';

/**
 * Every field is `required` AND `nullable`, which reads redundant and is not.
 * `required` makes the key always present; `nullable` lets its value be absent.
 * Together they mean the response has one shape, so the normaliser below handles
 * "this venue listed no hours" and never "this key might be missing".
 */
const PLACE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ordinal: {
      type: Type.INTEGER,
      description: 'The number the creator wrote at the start of the entry (1, 2, 3 ...), not the position in this array.',
    },
    name: {
      type: Type.STRING,
      description: 'The venue name exactly as written, in its original script. Never translate or romanise it.',
    },
    name_alt: {
      type: Type.STRING,
      nullable: true,
      description:
        'A Latin-script alias the creator put in parentheses after the name, e.g. 우이그 (UIG) -> "UIG". Null if the parenthetical is Korean (본점, 2호점 and the like belong in name).',
    },
    handle: {
      type: Type.STRING,
      nullable: true,
      description:
        "The VENUE's own Instagram handle, without the @. It appears on the same line as the venue name. The creator's own handle appears in the promotional text after the last numbered entry — never return that one.",
    },
    address: {
      type: Type.STRING,
      nullable: true,
      description:
        'The street address, copied verbatim. Accept either 도로명 (서울 용산구 후암로40길 3) or jibun (서울 용산구 후암동 2-1). Do not normalise, complete or correct it.',
    },
    hours_raw: {
      type: Type.STRING,
      nullable: true,
      description:
        'Opening hours as raw text, copied verbatim, e.g. "매일 11:00-22:30 금,토 11:00-23:00". Do not parse into days or times.',
    },
    menu_raw: {
      type: Type.STRING,
      nullable: true,
      description: 'Menu items and prices as raw text, copied verbatim, e.g. "티그레 (4,200) 아메리카노 (4,800)".',
    },
    // The ONE field on this schema that is a judgement rather than a copy. See
    // `PlaceCandidate.category` in ./types.ts for why it is asked here at all
    // instead of being defaulted downstream.
    category: {
      type: Type.STRING,
      nullable: true,
      enum: [...CATEGORIES],
      description:
        'What kind of place this is. Null when it is none of these — a hotel, a park, a hiking trail, a festival. Never guess to fill the field.',
    },
    category_confidence: {
      type: Type.STRING,
      nullable: true,
      enum: ['low', 'medium', 'high'],
      description:
        'high: the caption or the menu says outright what it is. medium: strongly implied. low: a guess from the name alone. Null when category is null.',
    },
  },
  required: [
    'ordinal', 'name', 'name_alt', 'handle', 'address', 'hours_raw', 'menu_raw',
    'category', 'category_confidence',
  ],
  propertyOrdering: [
    'ordinal', 'name', 'name_alt', 'handle', 'address', 'hours_raw', 'menu_raw',
    'category', 'category_confidence',
  ],
};

const EXTRACTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      nullable: true,
      description: 'The caption\'s lead-in line describing the whole list, e.g. "여름 날에 다녀오기 좋은 싱그러운 카페 10곳". Null if there is none.',
    },
    places: { type: Type.ARRAY, items: PLACE_SCHEMA },
  },
  required: ['title', 'places'],
  propertyOrdering: ['title', 'places'],
};

/**
 * The instruction carries the one thing the schema cannot: where a caption STOPS.
 *
 * The tail rule is stated first and stated twice because it is the observed
 * failure. Ten venues produced eleven handles and thirteen address matches from
 * a naive pass, entirely from the creator's sign-off, which has its own 📍, its
 * own @handle and its own address-shaped line.
 */
const SYSTEM_INSTRUCTION = `You extract venues from Instagram Reel captions written by Korean food and cafe creators.

A caption is a numbered list. Each entry begins with a number at the start of a line ("1.", "2.", ...) and describes ONE venue. Markers inside an entry are usually emoji: 📍 the venue name and its Instagram handle, an unmarked line for the street address, 🕰️ the opening hours, 📓 the menu.

Rules:
- Text AFTER the last numbered entry is the creator's own promotion. It often contains a 📍, an @handle and an address-shaped line of its own. It is NOT a venue. Ignore all of it.
- Return exactly one object per numbered entry, in the order they appear, using the creator's own number as "ordinal".
- Copy values verbatim. Do not translate, romanise, normalise, reformat, complete or correct anything.
- A field the caption does not state is null. Never infer an address from a venue name or from your own knowledge of the place.
- Emoji markers are a convention, not a guarantee. If an entry uses dashes or plain text instead, read it the same way.

"category" is the one field you decide rather than copy, and it is the only one. Judge it from what the entry and the caption's lead-in actually say — a 카페 list, a menu of 아메리카노 and 디저트, a 전시 running until a date, a 소품샵. Set "category_confidence" to "high" only when the text says what kind of place it is, "medium" when it is strongly implied, and "low" when you are reading the venue name alone. If it is none of cafe, restaurant, exhibition, shop or activity — a hotel, a park, a trail, a festival — return null for both. A wrong category is worse than no category; do not stretch one of the five to cover a place that is not one of them.`;

/** What the model is constrained to return. Kept separate from `PlaceCandidate` — one is a wire shape, the other is ours. */
type RawPlace = Partial<Record<keyof PlaceCandidate, unknown>>;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Hand-rolled rather than zod, and coercing rather than rejecting.
 *
 * The schema already did the validating server-side; what is left is tidying —
 * a stray `@`, an empty string where the model meant null, an ordinal that came
 * back as "3". Rejecting the batch because one venue of ten has a blank menu
 * would throw away nine good candidates, and `confidence` already exists to say
 * the result is thin.
 */
function normalise(raw: RawPlace, index: number): PlaceCandidate | null {
  const name = text(raw.name);
  if (!name) return null;

  const ordinal = Number(raw.ordinal);

  // Checked against the list rather than cast. `responseSchema` constrains
  // decoding, but a schema is not a parser: an enum that a future model version
  // widens, or a value that arrives capitalised, must land as null and cost the
  // candidate a review — never as a string that is not one of the five and that
  // `places.category`'s CHECK will reject three frames later.
  const rawCategory = text(raw.category)?.toLowerCase();
  const category = (CATEGORIES as readonly string[]).includes(rawCategory ?? '')
    ? (rawCategory as PlaceCandidateCategory)
    : null;

  const rawCategoryConfidence = text(raw.category_confidence)?.toLowerCase();
  const categoryConfidence = (CATEGORY_CONFIDENCES as readonly string[]).includes(
    rawCategoryConfidence ?? '',
  )
    ? (rawCategoryConfidence as NonNullable<PlaceCandidate['category_confidence']>)
    : null;

  return {
    // Fall back to the array position only when the model lost the number
    // entirely; an ordinal is how a candidate is matched back to the caption a
    // human is reading, so it is better approximated than left at zero.
    ordinal: Number.isInteger(ordinal) && ordinal > 0 ? ordinal : index + 1,
    name,
    name_alt: text(raw.name_alt),
    handle: text(raw.handle)?.replace(/^@+/, '').replace(/\.+$/, '') || null,
    address: text(raw.address),
    hours_raw: text(raw.hours_raw),
    menu_raw: text(raw.menu_raw),
    category,
    // Null exactly when the category is, so `category_confidence: 'high'` can
    // never describe a category nobody has. A model that returned a confidence
    // for a category the guard above rejected was confident about the wrong
    // thing.
    category_confidence: category ? (categoryConfidence ?? 'low') : null,
  };
}

/**
 * Extract place candidates from a reel caption.
 *
 * Throws when `GEMINI_API_KEY` is unset. Deliberately not a silent fall back to
 * `parseCaptionGrammar` — a missing key is a deployment mistake, and a caller
 * that got grammar results where it asked for model results has no way to tell,
 * because both return `CaptionExtraction`. A caller that WANTS the fallback can
 * catch this and call `parseCaptionGrammar` itself, which is a decision made in
 * one visible line rather than hidden in here.
 *
 * The key is read here rather than at module scope so that importing this file —
 * which `next build` does for any route that references it — does not require
 * the key to be present at build time.
 */
export async function extractPlacesFromCaption(caption: string): Promise<CaptionExtraction> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. lib/extract/caption.ts needs it to call Gemini; set it in .env.local (server-side only, never NEXT_PUBLIC_).',
    );
  }

  const startedAt = Date.now();
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: caption,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseSchema: EXTRACTION_SCHEMA,
      // Copying fields out of a caption has one right answer; sampling can only
      // invent a different one on a retry of the same reel.
      temperature: 0,
    },
  });

  const body = response.text;
  if (!body) {
    // No caption text in the message either — a caption is user content and can
    // be anything, including the reason a safety filter returned nothing.
    throw new Error('Gemini returned no text for the caption extraction.');
  }

  let parsed: { title?: unknown; places?: unknown };
  try {
    parsed = JSON.parse(body) as { title?: unknown; places?: unknown };
  } catch {
    throw new Error('Gemini returned a response that was not JSON despite responseMimeType=application/json.');
  }

  const places = dedupeOrdinals(
    (Array.isArray(parsed.places) ? parsed.places : [])
      .map((p, i) => normalise((p ?? {}) as RawPlace, i))
      .filter((p): p is PlaceCandidate => p !== null),
  );

  return {
    places,
    title: text(parsed.title),
    // The cross-check the grammar parser exists for: count the numbered entries
    // in the caption ourselves and see whether the model agrees about how many
    // venues this reel has.
    confidence: deriveConfidence(places, countNumberedBlocks(caption)),
    model: MODEL,
    ms: Date.now() - startedAt,
  };
}

/**
 * Make the ordinals unique within one reel, renumbering positionally when they
 * are not.
 *
 * CREATORS MISCOUNT, and the model faithfully copies them: reel DTafJINEnWW
 * marks its eighth 다방 `❼` for the second time rather than `❽`, so two venues
 * came back as ordinal 7. `saved_places_reel_ordinal_idx` is unique on
 * (reel_id, ordinal), so the second insert raised 23505 and took the whole clip
 * down with it — eight venues lost to one mistyped character.
 *
 * Renumbering is positional and all-or-nothing: either the creator's numbering
 * is usable as-is and is kept exactly, or it is internally inconsistent and the
 * array's own order — which is the order the venues appear in the caption —
 * replaces it wholesale. A partial repair, bumping only the collision, would
 * silently reorder the rest relative to the text.
 *
 * The ordinal exists to match a candidate back to the entry a human is reading
 * and to key the saved row. A duplicate serves neither purpose, so there is
 * nothing to preserve by keeping it.
 */
function dedupeOrdinals(places: PlaceCandidate[]): PlaceCandidate[] {
  const seen = new Set<number>();
  let collides = false;
  for (const p of places) {
    if (seen.has(p.ordinal)) {
      collides = true;
      break;
    }
    seen.add(p.ordinal);
  }
  if (!collides) return places;

  console.warn(
    `[extract] caption numbering repeats an ordinal across ${places.length} venues; renumbering by position.`,
  );
  return places.map((p, i) => ({ ...p, ordinal: i + 1 }));
}
