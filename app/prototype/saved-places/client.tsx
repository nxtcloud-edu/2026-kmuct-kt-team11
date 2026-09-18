'use client';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { VariantA, VariantB, VariantC, type SavedPlace } from './variants';
import { PrototypeSwitcher } from './switcher';

const TITLES = { A: VariantA.title, B: VariantB.title, C: VariantC.title };
type State =
  | { k: 'loading' }
  | { k: 'error'; status: number; detail: string }
  | { k: 'unauth' }
  | { k: 'ok'; rows: SavedPlace[] };

export function Prototype() {
  const params = useSearchParams();
  const variant = (params.get('variant') ?? 'A').toUpperCase();
  const force = params.get('state'); // loading | empty | error — for demonstrating states
  // Forced states are derived during render, not set from inside the effect —
  // a synchronous setState in an effect body causes cascading renders.
  const forced: State | null =
    force === 'loading' ? { k: 'loading' }
    : force === 'empty' ? { k: 'ok', rows: [] }
    : force === 'error' ? { k: 'error', status: 500, detail: '저장한 곳을 불러오지 못했어요.' }
    : null;

  const [fetched, setFetched] = useState<State>({ k: 'loading' });
  const s = forced ?? fetched;

  useEffect(() => {
    if (force) return;
    let alive = true;
    fetch('/api/saved-places?limit=100')
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401) return setFetched({ k: 'unauth' });
        const body = await r.json();
        if (!r.ok) return setFetched({ k: 'error', status: r.status, detail: body.detail ?? '알 수 없는 오류' });
        setFetched({ k: 'ok', rows: body.data });
      })
      .catch(() => alive && setFetched({ k: 'error', status: 0, detail: '서버에 연결하지 못했어요.' }));
    return () => { alive = false; };
  }, [force]);

  return (
    <>
      <div className="proto-wrap">
        <header className="proto-head">
          <h1>저장한 곳</h1>
          <p>
            {s.k === 'ok' ? `${s.rows.length}곳` : ' '}
          </p>
        </header>

        {s.k === 'loading' && <Skeleton />}
        {s.k === 'unauth' && (
          <Notice title="로그인이 필요해요"
                  body="이 프로토타입은 실제 API를 씁니다. scripts/seed-prototype.sh 를 실행하면 로그인됩니다." />
        )}
        {s.k === 'error' && (
          <Notice title="불러오지 못했어요" body={s.detail}
                  action={<button className="chip" onClick={() => location.reload()}>다시 시도</button>} danger />
        )}
        {s.k === 'ok' && s.rows.length === 0 && (
          <Notice title="아직 저장한 곳이 없어요"
                  body="인스타그램에서 릴스를 공유하면 여기에 쌓입니다. 지금은 직접 추가할 수도 있어요."
                  action={<button className="chip">직접 추가하기</button>} />
        )}
        {s.k === 'ok' && s.rows.length > 0 && (
          <>
            {variant === 'A' && <VariantA rows={s.rows} />}
            {variant === 'B' && <VariantB rows={s.rows} />}
            {variant === 'C' && <VariantC rows={s.rows} />}
          </>
        )}
      </div>
      {process.env.NODE_ENV !== 'production' && <PrototypeSwitcher titles={TITLES} />}
    </>
  );
}

function Skeleton() {
  // Shown because the wait can exceed ~1s on a cold route. Shapes match the real
  // card so the layout does not jump when data lands.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-busy="true" aria-label="불러오는 중">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card" style={{ display: 'flex', gap: 12, padding: 16, alignItems: 'center' }}>
          <div style={{ width: 44, height: 14, background: 'var(--fill)', borderRadius: 4 }} />
          <div style={{ flex: 1 }}>
            <div style={{ height: 15, width: `${45 + i * 12}%`, background: 'var(--fill)', borderRadius: 4 }} />
            <div style={{ height: 12, width: '30%', background: 'var(--fill)', borderRadius: 4, marginTop: 8 }} />
          </div>
          <div className="cat cat--sq" />
        </div>
      ))}
    </div>
  );
}

function Notice({ title, body, action, danger }: { title: string; body: string; action?: React.ReactNode; danger?: boolean }) {
  return (
    <div className="card" style={{ padding: 24, textAlign: 'left', borderLeft: danger ? '2px solid var(--danger)' : undefined }}>
      <p className="title" style={{ fontSize: 18 }}>{title}</p>
      <p className="muted" style={{ fontSize: 14, margin: '6px 0 0' }}>{body}</p>
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}
