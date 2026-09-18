'use client';
import { useEffect } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

const KEYS = ['A', 'B', 'C'] as const;

export function PrototypeSwitcher({ titles }: { titles: Record<string, string> }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const current = (params.get('variant') ?? 'A').toUpperCase();
  const i = Math.max(0, KEYS.indexOf(current as typeof KEYS[number]));

  const go = (delta: number) => {
    const next = KEYS[(i + delta + KEYS.length) % KEYS.length];
    const p = new URLSearchParams(params.toString());
    p.set('variant', next);
    router.replace(`${path}?${p}`, { scroll: false });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Never intercept arrows while the user is typing.
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Deliberately not the design being judged: high-contrast dark pill, so nobody
  // mistakes the switcher for part of the product.
  return (
    <div
      role="group"
      aria-label="Prototype variant switcher"
      style={{
        position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 4, zIndex: 50,
        background: '#131517', color: '#fff', borderRadius: 1000, padding: 4,
        boxShadow: '0 8px 24px rgba(0,0,0,.28)', maxWidth: 'calc(100vw - 32px)',
      }}
    >
      <button onClick={() => go(-1)} aria-label="Previous variant"
        style={{ width: 36, height: 36, borderRadius: 999, border: 0, background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 16 }}>←</button>
      <span style={{ fontSize: 13, padding: '0 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <strong style={{ fontWeight: 600 }}>{current}</strong> — {titles[current]}
      </span>
      <button onClick={() => go(1)} aria-label="Next variant"
        style={{ width: 36, height: 36, borderRadius: 999, border: 0, background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 16 }}>→</button>
    </div>
  );
}
