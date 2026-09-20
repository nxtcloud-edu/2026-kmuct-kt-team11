'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { Button, Card, Chip } from '@/components/surface';
import type { Me } from '@/lib/api/types';

/**
 * Instagram — as a connected account, which is what it is.
 *
 * It used to render inside a section headed 로그인 수단. It is not one. There is
 * no Instagram OAuth in this app (`SOCIAL_PROVIDERS` in lib/supabase.ts is
 * `['google']`), sign-in is an email link, an email password or Google, and
 * nothing anywhere exchanges an Instagram credential for a session. Listing it
 * as a way in told the user that somebody holding their Instagram account could
 * sign in as them, which is both false and alarming.
 *
 * What it actually means is a delivery address: reels DM'd to Gaja from this
 * Instagram account land in this Gaja account.
 *
 * TWO STATES, AND THEY ARE NOT THE SAME FACT — docs/gaja/instagram-binding.md:
 *
 *   `linked` (users.igsid)      proof. Meta signed a webhook payload saying this
 *                               Instagram account is this person.
 *   `handle` (instagram_handle) a claim. Somebody typed it into a text field.
 *
 * So a bound account says 확인됨 and an unbound claim says 확인 전, and the
 * second one is the only one offering a way to remove it. Clearing the handle on
 * a bound account would look like disconnecting and would not be: `igsid` is
 * untouched by `PATCH /api/me` by design, and no route in this app unbinds it.
 * Rather than ship a control that lies, the bound state ships no control at all.
 */
export function InstagramCard({ handle, linked }: { handle: string | null; linked: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(handle);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(handle ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const fieldId = useId();
  const noteId = useId();

  // Derived during render, never written back by an effect: the field holds what
  // was typed, and what the server is sent is computed from it. Same alphabet as
  // the zod schema in app/api/me/route.ts and the CHECK in 20260920000006.
  const normalised = text.trim().replace(/^@+/, '').toLowerCase();
  const malformed = normalised !== '' && !/^[a-z0-9._]{1,30}$/.test(normalised);

  async function write(next: string | null, done: string) {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const me = await apiFetch<Me>('/me', {
        method: 'PATCH',
        body: { instagram_handle: next },
      });
      setValue(me.instagram_handle);
      setEditing(false);
      setConfirmed(done);
      router.refresh();
    } catch (err) {
      // 409 instagram-handle-taken arrives here with a sentence written to be
      // read by the person who hit it — lib/problem.ts owns that copy.
      if (err instanceof ApiError) setFailure(err.problem.detail);
      else if (err instanceof NetworkError) setFailure(err.message);
      else setFailure('알 수 없는 오류가 생겼어요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-[var(--space-13)]">
      <div className="flex items-baseline justify-between gap-[var(--space-11)]">
        <p style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>Instagram</p>
        {value || linked ? <Chip>{linked ? '확인됨' : '확인 전'}</Chip> : null}
      </div>

      {editing ? (
        <div className="mt-[var(--space-11)]">
          <label htmlFor={fieldId} className="block text-secondary" style={{ font: 'var(--type-caption)' }}>
            인스타그램 아이디
          </label>
          <div className="mt-[var(--space-7)] flex h-[var(--field-height)] w-full items-center rounded-[var(--radius-2xl)] bg-surface-2 px-[var(--space-11)]">
            <span className="text-secondary" style={{ font: 'var(--type-body)' }} aria-hidden>
              @
            </span>
            <input
              id={fieldId}
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={31}
              aria-invalid={malformed}
              aria-describedby={noteId}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              className="ml-[var(--space-4)] h-full min-w-0 flex-1 bg-transparent outline-none"
              style={{ font: 'var(--type-body)' }}
            />
          </div>
          <p id={noteId} className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-caption)' }}>
            {malformed
              ? '영문 소문자와 숫자, 마침표, 밑줄만 쓸 수 있어요.'
              : '아이디만으로는 연결되지 않아요. 나중에 인스타그램에서 한 번 더 확인해요.'}
          </p>

          {failure ? (
            <p
              role="alert"
              className="mt-[var(--space-9)] rounded-[var(--radius-2xl)] bg-[var(--status-cancel-bg)] p-[var(--space-9)] text-ink"
              style={{ font: 'var(--type-meta)' }}
            >
              {failure}
            </p>
          ) : null}

          <div className="mt-[var(--space-13)] flex gap-[var(--space-7)]">
            <Button
              variant="primary"
              className="flex-1"
              disabled={busy || malformed || normalised === ''}
              onClick={() => void write(normalised, '아이디를 저장했어요')}
            >
              {busy ? '저장 중' : '저장'}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setEditing(false)}>
              취소
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-body)' }}>
            {linked
              ? '가자 인스타그램으로 보낸 릴스가 이 계정에 저장돼요.'
              : value
                ? '아이디만 받아둔 상태예요. 이 아이디만으로는 아직 아무것도 연결되지 않아요.'
                : '아이디를 알려주면 나중에 릴스를 보낼 때 이 계정을 찾는 데 써요. 로그인과는 상관없어요.'}
          </p>

          {value ? (
            <p className="mt-[var(--space-9)] [overflow-wrap:anywhere]" style={{ font: 'var(--type-body)' }}>
              @{value}
            </p>
          ) : null}

          {confirmed ? (
            <p role="status" className="mt-[var(--space-9)] text-secondary" style={{ font: 'var(--type-meta)' }}>
              {confirmed}
            </p>
          ) : null}

          {failure ? (
            <p
              role="alert"
              className="mt-[var(--space-9)] rounded-[var(--radius-2xl)] bg-[var(--status-cancel-bg)] p-[var(--space-9)] text-ink"
              style={{ font: 'var(--type-meta)' }}
            >
              {failure}
            </p>
          ) : null}

          {/* A bound account gets no control here, and that is deliberate: the
              binding lives in users.igsid and nothing in this app unbinds it. */}
          {linked ? null : (
            <div className="mt-[var(--space-13)] flex gap-[var(--space-7)]">
              <Button
                className="flex-1"
                onClick={() => {
                  setText(value ?? '');
                  setFailure(null);
                  setConfirmed(null);
                  setEditing(true);
                }}
              >
                {value ? '아이디 바꾸기' : '아이디 등록'}
              </Button>
              {value ? (
                <Button
                  variant="quiet"
                  disabled={busy}
                  onClick={() => void write(null, '아이디를 지웠어요')}
                >
                  {busy ? '지우는 중' : '연결 해제'}
                </Button>
              ) : null}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
