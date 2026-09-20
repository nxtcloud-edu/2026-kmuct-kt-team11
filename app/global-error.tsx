'use client';

/**
 * Only fires when the root layout itself throws, which means `app/error.tsx`
 * never mounted. It has to render its own <html>/<body>, and it cannot rely on
 * globals.css having loaded — hence the inline styles, which are the one place
 * in this codebase where hardcoded token values are correct.
 */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: '#F7F8F9',
          color: '#131517',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 380, padding: 24, textAlign: 'center' }}>
          <p style={{ fontSize: 18, fontWeight: 500, margin: 0 }}>앱을 불러오지 못했어요</p>
          <p style={{ fontSize: 14, color: 'rgba(19,21,23,0.64)', margin: '8px 0 20px' }}>
            새로고침해도 같은 화면이 보이면 잠시 후 다시 시도해 주세요.
          </p>
          <button
            onClick={reset}
            style={{
              font: 'inherit', fontSize: 16, padding: '10px 20px', borderRadius: 1000,
              border: 'none', background: '#131517', color: '#FFFFFF', cursor: 'pointer',
            }}
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
