'use client';

export type SavedPlace = {
  id: string;
  place: { id: string; name: string; category: string; area: string } | null;
  group_id: string | null;
  status: string;
  confirmed: boolean;
  hook: string | null;
  saved_at: string;
};

const GLYPH: Record<string, string> = {
  cafe: '☕', restaurant: '🍽', exhibition: '◻', shop: '🛍', activity: '◆',
};
const CAT_KO: Record<string, string> = {
  cafe: '카페', restaurant: '음식점', exhibition: '전시', shop: '쇼핑', activity: '액티비티',
};

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - that.getTime()) / 864e5);
  if (days === 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

function groupBy<T>(rows: T[], key: (r: T) => string) {
  const out: { key: string; rows: T[] }[] = [];
  for (const r of rows) {
    const k = key(r);
    const last = out[out.length - 1];
    if (last && last.key === k) last.rows.push(r);
    else out.push({ key: k, rows: [r] });
  }
  return out;
}

/* ───────────────────────────────────────────────────────────────────────────
   A — AGENDA.  luma faithful: the save DATE is the organising fact. Date marker
   headings, save time at the card's left edge, thumbnail right.
   Premise under test: a saved place behaves like an event on a day.
   ─────────────────────────────────────────────────────────────────────────── */
export function VariantA({ rows }: { rows: SavedPlace[] }) {
  const groups = groupBy(rows, (r) => dayLabel(r.saved_at));
  return (
    <div>
      {groups.map((g) => (
        <section key={g.key} style={{ marginBottom: 64 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>{g.key}</h2>
            <span style={{ flex: 1, height: 1, background: 'var(--hairline)' }} />
            <span className="muted" style={{ fontSize: 12 }}>{g.rows.length}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {g.rows.map((r) => (
              <article key={r.id} className="card" style={{ display: 'flex', gap: 12, padding: 16, alignItems: 'flex-start' }}>
                {/* time at the card's left edge — luma's scannable column */}
                <div style={{ width: 44, flex: '0 0 44px', paddingTop: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{hhmm(r.saved_at)}</div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p className="title">{r.place?.name ?? '확인 중'}</p>
                  <p className="muted" style={{ fontSize: 13, margin: '2px 0 0' }}>
                    {r.place?.area} · {CAT_KO[r.place?.category ?? ''] ?? ''}
                  </p>
                  {r.hook && <p className="hook">{r.hook}</p>}
                  {!r.confirmed && <span className="chip chip--danger" style={{ marginTop: 8 }}>확인 필요</span>}
                </div>
                <div className="cat cat--sq" aria-hidden>{GLYPH[r.place?.category ?? ''] ?? '◆'}</div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
VariantA.title = 'Agenda — grouped by save date';

/* ───────────────────────────────────────────────────────────────────────────
   B — AREA BOARD.  The place's WHERE is the organising fact; the save date is
   demoted to metadata. Premise: you plan "a Saturday in 성수", so area is the
   axis you actually reach for. Sticky area headers, count and category mix.
   ─────────────────────────────────────────────────────────────────────────── */
export function VariantB({ rows }: { rows: SavedPlace[] }) {
  const byArea = new Map<string, SavedPlace[]>();
  for (const r of rows) {
    const a = r.place?.area ?? '미확인';
    byArea.set(a, [...(byArea.get(a) ?? []), r]);
  }
  const areas = [...byArea.entries()].sort((x, y) => y[1].length - x[1].length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {areas.map(([area, list]) => {
        const mix = [...new Set(list.map((r) => r.place?.category))].filter(Boolean) as string[];
        return (
          <section key={area}>
            <div
              style={{
                position: 'sticky', top: 0, zIndex: 1, background: 'var(--canvas)',
                paddingBottom: 12, display: 'flex', alignItems: 'baseline', gap: 8,
              }}
            >
              <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>{area}</h2>
              <span className="muted" style={{ fontSize: 14 }}>{list.length}곳</span>
              <span style={{ flex: 1 }} />
              <span className="muted" style={{ fontSize: 12 }}>{mix.map((c) => CAT_KO[c]).join(' · ')}</span>
            </div>
            {/* One surface per area, hairline-ruled inside — the area is the card,
                not each place. Grouping is the thing being merchandised. */}
            <div className="card" style={{ overflow: 'hidden' }}>
              {list.map((r, i) => (
                <article
                  key={r.id}
                  style={{
                    display: 'flex', gap: 12, padding: 14, alignItems: 'center',
                    borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                  }}
                >
                  <div className="cat" aria-hidden>{GLYPH[r.place?.category ?? ''] ?? '◆'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="title">{r.place?.name ?? '확인 중'}</p>
                    {r.hook && <p className="hook">{r.hook}</p>}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{dayLabel(r.saved_at)}</div>
                    {!r.confirmed && <span className="chip chip--danger" style={{ marginTop: 6 }}>확인</span>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
VariantB.title = 'Area board — grouped by where';

/* ───────────────────────────────────────────────────────────────────────────
   C — FLAT STREAM.  The null hypothesis: no grouping at all, newest first, one
   continuous list with a filter row. Premise: at 13 items grouping is overhead
   that does not earn its keep, and the real axis is "what did I save recently".
   ─────────────────────────────────────────────────────────────────────────── */
export function VariantC({ rows }: { rows: SavedPlace[] }) {
  const areas = [...new Set(rows.map((r) => r.place?.area).filter(Boolean))] as string[];
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 16, marginBottom: 4 }}>
        <button className="chip" style={{ background: 'var(--ink)', color: 'var(--surface-1)', boxShadow: 'none' }}>전체 {rows.length}</button>
        {areas.map((a) => (
          <button key={a} className="chip">{a}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((r, i) => (
          <article
            key={r.id}
            style={{
              display: 'flex', gap: 12, padding: '16px 4px', alignItems: 'flex-start',
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
            }}
          >
            <div className="cat" aria-hidden>{GLYPH[r.place?.category ?? ''] ?? '◆'}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="title">{r.place?.name ?? '확인 중'}</p>
              <p className="muted" style={{ fontSize: 13, margin: '2px 0 0' }}>
                {r.place?.area} · {CAT_KO[r.place?.category ?? ''] ?? ''} · {dayLabel(r.saved_at)}
              </p>
              {r.hook && <p className="hook">{r.hook}</p>}
              {!r.confirmed && <span className="chip chip--danger" style={{ marginTop: 8 }}>확인 필요</span>}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
VariantC.title = 'Flat stream — no grouping';
