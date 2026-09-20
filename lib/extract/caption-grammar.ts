/**
 * The model-free caption parser, and the count the model gets checked against.
 *
 * WHY this exists next to a perfectly good Gemini call: a naive regex over one
 * real caption returned ELEVEN @handles and THIRTEEN address matches for TEN
 * venues (docs/gaja/reel-extraction-findings.md). The extra three came from the
 * creator's self-promo tail, which carries its own 📍, its own @handle and
 * address-shaped text. Anything that parses to the emoji markers inherits that
 * bug. So this file parses to the NUMBERED ENTRIES — `1.` `2.` … — and reads the
 * markers only *inside* a numbered block. Whatever follows the last block is
 * tail, and tail is discarded.
 *
 * Two jobs, and the second is the one that pays for the file:
 *
 *   1. A fallback extractor for when the API key is missing, the call fails, or
 *      the caption is cheap enough that a model is not worth the latency.
 *   2. `countNumberedBlocks` — an independent count of how many venues the
 *      caption claims. The Gemini path cross-checks its own place count against
 *      it and drops to `'low'` when they disagree. A model grading its own
 *      output grades its fluency; counting `N.` markers in the source text is
 *      evidence that can actually contradict it.
 *
 * The grammar is ONE SAMPLE, from a creator who formats carefully. It is coded
 * here as a hypothesis with an escape hatch, not as a spec: a block with no
 * recognisable emoji falls back to reading the numbering alone (see
 * `parseUnmarkedBlock`), because the findings call the emoji "robust in this
 * sample, absent the moment a creator uses a dash".
 */

import type { CaptionExtraction, PlaceCandidate } from './types';

/** One numbered entry, already cut away from its neighbours and from the tail. */
export type CaptionBlock = {
  /** The number the creator wrote, not the array index. */
  ordinal: number;
  /** Everything from just after the `N.` marker to just before the next one. */
  body: string;
};

/**
 * A numbered entry starts at the start of a line. Anchoring to the line rather
 * than to `\d+\.` anywhere is what stops a menu price (`아메리카노 (4,800)`) or a
 * date from opening a phantom entry. Two digits is the ceiling: these are
 * listicles, and `2026.` should not read as entry 20.
 */
const BLOCK_START =
  /^[ \t]*(?:(\d{1,2})[ \t]*[.)]|([\u2460-\u2473\u2776-\u277F\u278A-\u2793]))[ \t]*/gm;

/**
 * CIRCLED NUMERALS COUNT AS NUMBERING, and leaving them out was a real defect
 * rather than a missing nicety.
 *
 * A caption reading `❶ 터방내 / 📍서울 동작구 흑석로 101-7` numbers eight venues and
 * gives all eight an address, but `❶` is not `1.`, so `countNumberedBlocks`
 * returned 0. The Gemini path cross-checks its own count against that number and
 * drops to `'low'` when they disagree — so a perfectly extracted caption was
 * scored as a failure. In the ladder that `'low'` then lost to a `'medium'`
 * transcript of the on-screen text, which carries names and no addresses, and
 * eight geocodable venues became eight unpinnable ones.
 *
 * Three ranges, because creators use all three and a reader cannot tell them
 * apart: ① U+2460-2473 (1-20), ❶ U+2776-277F (1-10), ➊ U+278A-2793 (1-10).
 * No separator is required after them — `❶ 터방내` has none and `❶.` is unusual —
 * which is safe precisely because these characters do not occur in prices,
 * dates or addresses, the strings the ASCII branch has to defend against with
 * its mandatory `.` or `)`.
 */
const CIRCLED_RANGES: [number, number, number][] = [
  [0x2460, 0x2473, 1], // ①-⑳
  [0x2776, 0x277f, 1], // ❶-❿
  [0x278a, 0x2793, 1], // ➊-➓
];

function circledValue(ch: string): number | null {
  const code = ch.codePointAt(0);
  if (code === undefined) return null;
  for (const [lo, hi, base] of CIRCLED_RANGES) {
    if (code >= lo && code <= hi) return code - lo + base;
  }
  return null;
}

/**
 * Marker sets, widened slightly past the one observed caption.
 *
 * Widening is cheap and lossless — an unrecognised marker line simply ends the
 * block early — so a few near-synonyms are worth having. But the marker list is
 * NOT the safety net; `parseUnmarkedBlock` is. Do not chase every clock emoji.
 */
const NAME_MARKERS = ['📍', '📌'];
const HOURS_MARKERS = ['🕰', '⏰', '🕐', '🕒', '🕘', '🕛'];
const MENU_MARKERS = ['📓', '📔', '📝'];

/**
 * A street address, 도로명 or jibun, both of which appear for the same venue
 * across reels. Requires an administrative token (`마포구`, `서귀포시`, `양평군`)
 * followed by whitespace, plus a digit somewhere after it.
 *
 * Deliberately loose on the tail of the string and strict on the head: a Korean
 * address always opens with the region, and the building part varies far more
 * than a regex can usefully track. The length ceiling keeps a prose sentence
 * that happens to name a district from qualifying.
 */
const ADDRESS_HEAD = /(?:[가-힣]{2,10}(?:특별시|광역시|자치시|시|군|구))[ \t]/;

function looksLikeAddress(line: string): boolean {
  return line.length <= 60 && ADDRESS_HEAD.test(line) && /\d/.test(line);
}

/**
 * Instagram handles: letters, digits, dot, underscore. The trailing-dot trim
 * matters because a handle at the end of a sentence (`@uig.official.`) would
 * otherwise be stored with punctuation and never match the account.
 */
const HANDLE = /@([A-Za-z0-9._]{1,30})/;

/** U+FE0F turns 🕰 into 🕰️ and breaks a `startsWith` compare. Strip it before matching, never before storing. */
function stripVariationSelectors(s: string): string {
  return s.replace(/️/g, '');
}

function startsWithAny(line: string, markers: string[]): string | null {
  const bare = stripVariationSelectors(line);
  for (const m of markers) if (bare.startsWith(m)) return bare.slice(m.length).trim();
  return null;
}

/**
 * Cut the caption into numbered blocks.
 *
 * Ordinals must strictly increase. A caption that numbers its venues and then
 * numbers a menu inside one of them would otherwise fold the two sequences
 * together; keeping only the increasing run means the inner list stays inside
 * its block, where it is menu text, instead of becoming three venues.
 *
 * Exported because the Gemini path needs the COUNT independently of this
 * parser's opinion about what is in each block.
 */
export function splitNumberedBlocks(caption: string): CaptionBlock[] {
  const starts: { ordinal: number; from: number; bodyFrom: number }[] = [];
  BLOCK_START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_START.exec(caption)) !== null) {
    // `m[1]` is the ASCII branch, `m[2]` the circled one; exactly one matches.
    const ordinal = m[1] !== undefined ? Number(m[1]) : (circledValue(m[2]) ?? 0);
    if (ordinal === 0) continue;
    const previous = starts[starts.length - 1];
    // A REPEATED ordinal opens a new block; a DECREASING one does not.
    //
    // The rule used to be strictly increasing, to stop a menu numbered inside an
    // entry from folding into the venue sequence. That still holds — an inner
    // `1.` after an outer `3.` decreases and is still skipped. What it also did
    // was drop a real entry when the creator miscounted: reel DTafJINEnWW marks
    // its eighth 다방 `❼` for the second time rather than `❽`, so eight venues
    // were counted as seven and the model's correct eight was graded a
    // disagreement. Admitting equality costs only the case where a nested list
    // repeats its parent's exact number at the start of a line, which no caption
    // observed so far does.
    if (previous && ordinal < previous.ordinal) continue;
    starts.push({ ordinal, from: m.index, bodyFrom: m.index + m[0].length });
  }

  return starts.map((s, i) => ({
    ordinal: s.ordinal,
    // The last block runs to the end of the caption INCLUDING the tail. Cutting
    // the tail off is the block scanner's job, not the splitter's — the splitter
    // has no way to tell prose from a field, and guessing here would silently
    // drop the last venue of every caption that ends without a sign-off.
    body: caption.slice(s.bodyFrom, i + 1 < starts.length ? starts[i + 1].from : caption.length),
  }));
}

/** The independent count the model path cross-checks against. */
export function countNumberedBlocks(caption: string): number {
  return splitNumberedBlocks(caption).length;
}

/**
 * The caption's lead-in: everything before the first numbered entry, first
 * non-empty line only. Absent a numbered entry there is no title either —
 * calling the whole caption a title would turn a paragraph reel into a place
 * named after its own prose.
 */
export function captionTitle(caption: string): string | null {
  BLOCK_START.lastIndex = 0;
  const first = BLOCK_START.exec(caption);
  if (!first) return null;
  for (const line of caption.slice(0, first.index).split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

/**
 * Pull the venue's own handle and its romanised alias off the 📍 line.
 *
 * The handle is read from THIS LINE ONLY, never from the block and never from
 * the caption. That single restriction is what kept the creator's own handle out
 * of the ten venues — it lives in the tail, on a line of its own.
 *
 * The parenthetical becomes `name_alt` only when it is Latin script. Korean
 * parentheticals are qualifiers (`(본점)`, `(2호점)`) that belong in the name:
 * dropping `본점` would merge a flagship with its branch two streets away.
 */
function parseNameLine(line: string): Pick<PlaceCandidate, 'name' | 'name_alt' | 'handle'> {
  const handleMatch = line.match(HANDLE);
  const handle = handleMatch ? handleMatch[1].replace(/\.+$/, '') : null;

  let name = line.replace(HANDLE, '').trim();
  let nameAlt: string | null = null;

  const paren = name.match(/\(([^)]{1,40})\)\s*$/);
  if (paren && /^[A-Za-z0-9 .'&-]+$/.test(paren[1].trim())) {
    nameAlt = paren[1].trim();
    name = name.slice(0, paren.index).trim();
  }

  return { name, name_alt: nameAlt, handle };
}

/**
 * Read one numbered block, stopping at the first line that does not fit.
 *
 * The scanner is a one-way state machine over three rules, and each rule exists
 * to shut one door the naive regex left open:
 *
 *   - A marker whose field is ALREADY FILLED ends the block. This is what stops
 *     the tail: the self-promo line opens with its own 📍, and a second 📍 in a
 *     block that already has a name is not a second name, it is the end.
 *   - The unmarked address line is read ONLY in the window between 📍 and the
 *     first 🕰️/📓. In the observed grammar the address sits exactly there. The
 *     window also means a venue that lists no address cannot adopt the
 *     address-shaped line from the creator's tail twenty lines later.
 *   - Blank lines are skipped rather than treated as terminators, because
 *     creators pad between fields; the non-fitting line is the reliable signal.
 */
function parseMarkedBlock(block: CaptionBlock): PlaceCandidate | null {
  const lines = block.body.split('\n');
  let candidate: PlaceCandidate | null = null;
  let addressWindowOpen = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const nameText = startsWithAny(line, NAME_MARKERS);
    if (nameText !== null) {
      if (candidate) break;
      candidate = {
        ordinal: block.ordinal,
        ...parseNameLine(nameText),
        address: null,
        hours_raw: null,
        menu_raw: null,
        // A REGEX CANNOT CLASSIFY, AND THIS ONE DOES NOT PRETEND TO. Category is
        // a judgement about what a place IS; everything else in this file is a
        // substring of the caption. Guessing 'cafe' from the word 아메리카노 would
        // be the hardcoded default that `PlaceCandidate.category` exists to
        // refuse, only harder to find. Null sends the candidate to the reel-level
        // fallback in lib/research/resolve-place.ts, or to review.
        category: null,
        category_confidence: null,
      };
      addressWindowOpen = true;
      continue;
    }

    if (!candidate) break;

    const hoursText = startsWithAny(line, HOURS_MARKERS);
    if (hoursText !== null) {
      if (candidate.hours_raw !== null) break;
      candidate.hours_raw = hoursText;
      addressWindowOpen = false;
      continue;
    }

    const menuText = startsWithAny(line, MENU_MARKERS);
    if (menuText !== null) {
      if (candidate.menu_raw !== null) break;
      candidate.menu_raw = menuText;
      addressWindowOpen = false;
      continue;
    }

    if (addressWindowOpen && candidate.address === null && looksLikeAddress(line)) {
      candidate.address = line;
      continue;
    }

    break;
  }

  return candidate && candidate.name ? candidate : null;
}

/**
 * The numbering-only fallback the findings ask for: "the parser needs a fallback
 * that reads the numbering alone".
 *
 * A block with no recognisable emoji is read as `name — address` on its first
 * line, then as `name` on the first line with the address on a following one.
 * The dash is the documented failure mode ("absent the moment a creator uses a
 * dash"), so it is the separator this handles.
 *
 * The first line is still the ONLY place a handle is read from. The tail rule
 * does not get weaker just because the grammar did.
 */
function parseUnmarkedBlock(block: CaptionBlock): PlaceCandidate | null {
  const lines = block.body.split('\n').map((l) => l.trim());
  const firstIndex = lines.findIndex((l) => l !== '');
  if (firstIndex === -1) return null;

  const first = lines[firstIndex];
  const separator = first.match(/\s+[-–—·|]\s+/);
  const splitAt = separator?.index ?? first.length;
  const head = first.slice(0, splitAt);
  const rest = separator ? first.slice(splitAt + separator[0].length).trim() : '';

  const candidate: PlaceCandidate = {
    ordinal: block.ordinal,
    ...parseNameLine(head),
    address: rest && looksLikeAddress(rest) ? rest : null,
    hours_raw: null,
    menu_raw: null,
    // See parseMarkedBlock: no classifier here, and none smuggled in.
    category: null,
    category_confidence: null,
  };

  // Without markers there is no window to close, so the scan stops at the first
  // line that is neither blank nor an address. That is what keeps the trailing
  // `@creator 팔로우 부탁드려요` line out of the last entry.
  if (!candidate.address) {
    for (const line of lines.slice(firstIndex + 1)) {
      if (!line) continue;
      if (looksLikeAddress(line)) {
        candidate.address = line;
      }
      break;
    }
  }

  return candidate.name ? candidate : null;
}

/**
 * Confidence, derived rather than guessed — and derived the same way for both
 * paths so a `'high'` from Gemini means what a `'high'` from here means.
 *
 *   low    — the two counts disagree, the caption has no numbered entries at
 *            all, or some entry parsed without a name. Disagreement is the
 *            important one: it is the only signal available that the model
 *            invented or swallowed a venue.
 *   medium — counts agree and every entry is named, but at least one has no
 *            address. Addresses are what geocode; without one, a candidate
 *            re-enters the fuzzy cross-source name matching that the findings
 *            say an address avoids ("Address beats name matching").
 *   high   — counts agree, every entry is named, every entry has an address.
 *
 * Note what is NOT here: hours and menu. Both are creator claims that get
 * verified elsewhere, and a listicle of bars that omits menus is not a worse
 * extraction, just a thinner caption.
 */
export function deriveConfidence(
  places: PlaceCandidate[],
  blockCount: number,
): CaptionExtraction['confidence'] {
  if (blockCount === 0) return 'low';
  if (blockCount !== places.length) return 'low';
  if (places.some((p) => !p.name.trim())) return 'low';
  if (places.some((p) => !p.address)) return 'medium';
  return 'high';
}

/** The model id reported by this path. Not a model; the point is that it is not one. */
export const GRAMMAR_MODEL = 'caption-grammar';

/**
 * Deterministic, network-free extraction. Same contract as the Gemini path, so a
 * caller can swap one for the other without branching on which produced the row.
 */
export function parseCaptionGrammar(caption: string): CaptionExtraction {
  const startedAt = Date.now();
  const blocks = splitNumberedBlocks(caption);

  const places: PlaceCandidate[] = [];
  for (const block of blocks) {
    const place = parseMarkedBlock(block) ?? parseUnmarkedBlock(block);
    if (place) places.push(place);
  }

  return {
    places,
    title: captionTitle(caption),
    confidence: deriveConfidence(places, blocks.length),
    model: GRAMMAR_MODEL,
    ms: Date.now() - startedAt,
  };
}
