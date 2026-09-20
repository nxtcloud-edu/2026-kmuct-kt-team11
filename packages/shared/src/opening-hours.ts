export interface OpeningWindow {
  start: number;
  end: number;
  lastOrder: number | null;
}

export interface OpeningHoursResolution {
  status: 'open' | 'closed' | 'unknown';
  windows: OpeningWindow[];
}

interface ScheduleEntry {
  days: Set<number> | null;
  window: OpeningWindow;
}

const DAY_INDEX: Record<string, number> = {
  일: 0,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
};

const ALL_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
const RANGE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

function normalizeHours(value: string): string {
  return value
    .replace(/(오전|오후)\s*(\d{1,2})시(?:\s*(\d{1,2})분)?/g, (_, period, hourText, minuteText) => {
      let hour = Number(hourText) % 12;
      if (period === '오후') hour += 12;
      return `${String(hour).padStart(2, '0')}:${String(Number(minuteText ?? 0)).padStart(2, '0')}`;
    })
    .replace(/(\d{1,2})시(?:\s*(\d{1,2})분)?/g, (_, hourText, minuteText) =>
      `${String(Number(hourText)).padStart(2, '0')}:${String(Number(minuteText ?? 0)).padStart(2, '0')}`,
    )
    .replace(/[~〜～∼–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function rangeDays(start: number, end: number): Set<number> {
  const days = new Set<number>();
  let current = start;
  while (!days.has(current)) {
    days.add(current);
    if (current === end) break;
    current = (current + 1) % 7;
  }
  return days;
}

function parseDaySelector(value: string): Set<number> | null {
  const clause = value.split(/[;/\n]|휴무/).at(-1)?.trim() ?? '';
  if (/매일|연중무휴/.test(clause)) return new Set(ALL_DAYS);
  if (/평일/.test(clause)) return new Set([1, 2, 3, 4, 5]);
  if (/주말/.test(clause)) return new Set([0, 6]);

  const range = clause.match(/([월화수목금토일])(?:요일)?\s*-\s*([월화수목금토일])(?:요일)?/);
  if (range) return rangeDays(DAY_INDEX[range[1]], DAY_INDEX[range[2]]);

  const days = [...clause.matchAll(/([월화수목금토일])(?:요일)?/g)]
    .map((match) => DAY_INDEX[match[1]]);
  return days.length > 0 ? new Set(days) : null;
}

function parseClock(hourText: string, minuteText: string): number | null {
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 24 || minute > 59) return null;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

function weekday(date: string): number | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) return null;
  return value.getUTCDay();
}

function addDays(date: string, amount: number): string | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + amount));
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, '0'),
    String(value.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function matchesDay(days: Set<number> | null, target: number): boolean {
  return days === null || days.has(target);
}

function selectEntries(entries: ScheduleEntry[], target: number): ScheduleEntry[] {
  const matching = entries.filter((entry) => matchesDay(entry.days, target));
  const specific = matching.filter((entry) => entry.days !== null && entry.days.size < 7);
  return specific.length > 0 ? specific : matching.filter((entry) => entry.days === null || entry.days.size === 7);
}

function closureDays(value: string): Set<number>[] {
  if (/연중무휴|휴무\s*없음/.test(value)) return [];
  const results: Set<number>[] = [];
  const regex = /((?:매주\s*)?(?:평일|주말|[월화수목금토일](?:요일)?(?:\s*[,/]\s*[월화수목금토일](?:요일)?)*|[월화수목금토일](?:요일)?\s*-\s*[월화수목금토일](?:요일)?))\s*휴무/g;
  for (const match of value.matchAll(regex)) {
    const days = parseDaySelector(match[1]);
    if (days) results.push(days);
  }
  return results;
}

function parseEntries(value: string): {
  openings: ScheduleEntry[];
  breaks: ScheduleEntry[];
  lastOrders: Array<{ days: Set<number> | null; at: number }>;
} {
  const openings: ScheduleEntry[] = [];
  const breaks: ScheduleEntry[] = [];
  const lastOrders: Array<{ days: Set<number> | null; at: number }> = [];
  let previousEnd = 0;

  RANGE.lastIndex = 0;
  for (const match of value.matchAll(RANGE)) {
    const start = parseClock(match[1], match[2]);
    let end = parseClock(match[3], match[4]);
    if (start === null || end === null) continue;
    if (end <= start) end += 24 * 60;

    const prefix = value.slice(previousEnd, match.index);
    const entry = { days: parseDaySelector(prefix), window: { start, end, lastOrder: null } };
    if (/브레이크\s*타임|휴게\s*시간/.test(prefix)) breaks.push(entry);
    else if (!/라스트\s*오더/.test(prefix)) openings.push(entry);
    previousEnd = (match.index ?? 0) + match[0].length;
  }

  const lastOrderRegex = /((?:매일|평일|주말|(?:매주\s*)?[월화수목금토일](?:요일)?(?:\s*[,/]\s*[월화수목금토일](?:요일)?)*|[월화수목금토일](?:요일)?\s*-\s*[월화수목금토일](?:요일)?)\s*)?라스트\s*오더\s*(\d{1,2}):(\d{2})/g;
  for (const match of value.matchAll(lastOrderRegex)) {
    const at = parseClock(match[2], match[3]);
    if (at !== null) lastOrders.push({ days: parseDaySelector(match[1] ?? ''), at });
  }

  const allDayRegex = /((?:매일|평일|주말|(?:매주\s*)?[월화수목금토일](?:요일)?)\s*)?24시간/g;
  for (const match of value.matchAll(allDayRegex)) {
    openings.push({
      days: parseDaySelector(match[1] ?? ''),
      window: { start: 0, end: 24 * 60, lastOrder: null },
    });
  }

  return { openings, breaks, lastOrders };
}

function applyBreaks(windows: OpeningWindow[], breaks: OpeningWindow[]): OpeningWindow[] {
  let result = windows;
  for (const pause of breaks) {
    result = result.flatMap((window) => {
      if (pause.end <= window.start || pause.start >= window.end) return [window];
      const split: OpeningWindow[] = [];
      if (pause.start > window.start) split.push({ ...window, end: pause.start });
      if (pause.end < window.end) split.push({ ...window, start: pause.end });
      return split;
    });
  }
  return result;
}

export function parseHourRange(value: string): { start: number; end: number } | null {
  const normalized = normalizeHours(value);
  if (normalized.includes('24시간')) return { start: 0, end: 24 * 60 };
  RANGE.lastIndex = 0;
  const match = RANGE.exec(normalized);
  if (!match) return null;
  const start = parseClock(match[1], match[2]);
  let end = parseClock(match[3], match[4]);
  if (start === null || end === null) return null;
  if (end <= start) end += 24 * 60;
  return { start, end };
}

export function resolveOpeningHours(value: string, date: string): OpeningHoursResolution {
  const normalized = normalizeHours(value);
  const target = weekday(date);
  if (target === null) return { status: 'unknown', windows: [] };

  const parsed = parseEntries(normalized);
  const hasParsedSchedule = parsed.openings.length > 0;
  const isClosed = closureDays(normalized).some((days) => days.has(target));
  if (isClosed) return { status: 'closed', windows: [] };

  const selected = selectEntries(parsed.openings, target);
  if (selected.length === 0) {
    return { status: hasParsedSchedule ? 'closed' : 'unknown', windows: [] };
  }

  const pauses = selectEntries(parsed.breaks, target).map((entry) => entry.window);
  const orders = parsed.lastOrders.filter((entry) => matchesDay(entry.days, target));
  const specificOrders = orders.filter((entry) => entry.days !== null && entry.days.size < 7);
  const applicableOrders = specificOrders.length > 0 ? specificOrders : orders;

  const windows = applyBreaks(selected.map((entry) => ({ ...entry.window })), pauses)
    .map((window) => {
      const order = applicableOrders
        .map((entry) => entry.at < window.start ? entry.at + 24 * 60 : entry.at)
        .find((at) => at >= window.start && at <= window.end);
      return { ...window, lastOrder: order ?? null };
    })
    .sort((a, b) => a.start - b.start);

  return { status: windows.length > 0 ? 'open' : 'closed', windows };
}

export function resolveOpeningTimeline(value: string, date: string): OpeningHoursResolution {
  const dates = [addDays(date, -1), date, addDays(date, 1)];
  const shifts = [-24 * 60, 0, 24 * 60];
  const windows: OpeningWindow[] = [];
  let parsed = false;

  dates.forEach((candidate, index) => {
    if (!candidate) return;
    const resolution = resolveOpeningHours(value, candidate);
    if (resolution.status !== 'unknown') parsed = true;
    for (const window of resolution.windows) {
      const shift = shifts[index];
      windows.push({
        start: window.start + shift,
        end: window.end + shift,
        lastOrder: window.lastOrder === null ? null : window.lastOrder + shift,
      });
    }
  });

  return {
    status: windows.length > 0 ? 'open' : parsed ? 'closed' : 'unknown',
    windows: windows.sort((a, b) => a.start - b.start),
  };
}

export function alignClockMinutes(time: string, notBefore: number): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  let value = parseClock(match[1], match[2]);
  if (value === null) return null;
  while (value < notBefore) value += 24 * 60;
  return value;
}

export function visitFitsWindow(
  windows: OpeningWindow[],
  start: number,
  end: number,
): boolean {
  return windows.some((window) =>
    start >= window.start &&
    end <= window.end &&
    (window.lastOrder === null || start <= window.lastOrder),
  );
}
