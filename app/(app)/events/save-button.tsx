'use client';

import { useState } from 'react';
import { Button } from '@/components/surface';
import type { Problem } from '@/lib/api/types';

/**
 * 저장 — the one control on the events feed that writes anything.
 *
 * CONTROLLED, NOT SELF-KNOWING. `saved` is a prop and the parent owns the set of
 * saved place ids. This component deliberately does not remember whether it
 * succeeded, because the feed's filter chips re-render the list and a button
 * holding its own "I am saved now" would lose it the moment its subtree was
 * reconciled away — the user would tap 팝업, tap 전체, and watch 저장됨 turn back
 * into 저장. Lifting the fact one level up is the fix; an effect that re-reads
 * the prop and repairs local state would be the bug.
 *
 * There are NO EFFECTS in this file at all. Everything rendered is derived from
 * props and from the request's own status, which is set by the click handler
 * that started the request.
 */

type Status = { kind: 'idle' | 'saving' } | { kind: 'error'; detail: string };

export function SaveButton({
  eventId,
  placeId,
  saved,
  onSaved,
}: {
  eventId: string;
  /**
   * The `places` row this event resolved to, or null.
   *
   * NULL IS A DESIGNED-FOR STATE, not a loading state. Most yanolja listings
   * publish a hall name and no street address, so there was nothing to geocode
   * and there is no pin to put on a map. The control says so in words instead of
   * sitting there greyed and unexplained — a disabled button with no reason is
   * indistinguishable from a broken one.
   */
  placeId: string | null;
  saved: boolean;
  onSaved: (placeId: string) => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  if (!placeId) {
    return (
      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        위치를 확인하지 못해 저장할 수 없어요
      </p>
    );
  }

  if (saved) {
    // Not a button. There is nothing to do here — un-saving lives on 저장한 곳,
    // which is where the row and its group belong — and a disabled button
    // invites a tap that will never work.
    return (
      <p className="text-secondary" style={{ font: 'var(--type-meta)' }}>
        저장함
      </p>
    );
  }

  async function save() {
    setStatus({ kind: 'saving' });
    try {
      const res = await fetch(`/api/events/${eventId}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      if (res.ok) {
        setStatus({ kind: 'idle' });
        onSaved(placeId!);
        return;
      }

      // 409 duplicate-saved-place is a SUCCESS from here: the row this tap wanted
      // already exists — another tab, a double tap, a stale page. Telling the
      // user it failed would be a lie about a place that is in their list.
      const problem = (await res.json().catch(() => null)) as Problem | null;
      if (problem?.type?.endsWith('/duplicate-saved-place')) {
        setStatus({ kind: 'idle' });
        onSaved(placeId!);
        return;
      }

      // The catalogue's `detail` is written to be read by a user
      // (lib/problem.ts), so it is shown rather than translated here. A status
      // code with no sentence would send someone to support with nothing to say.
      setStatus({
        kind: 'error',
        detail: problem?.detail ?? '저장하지 못했어요. 잠시 후 다시 시도해 주세요.',
      });
    } catch {
      // Transport, not HTTP. `fetch` rejects for a dropped connection and for an
      // offline device, and neither has a problem document to quote.
      setStatus({ kind: 'error', detail: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.' });
    }
  }

  return (
    <div className="flex flex-col items-end gap-[var(--space-4)]">
      <Button
        variant="primary"
        // Height and padding are trimmed from the 56px field default: this sits
        // in a card's action row beside a link, not on its own as a form's
        // submit. It stays at --tap-min, which is the floor that matters.
        className="h-[var(--tap-min)] px-[var(--space-13)]"
        onClick={save}
        disabled={status.kind === 'saving'}
      >
        {status.kind === 'saving' ? '저장 중' : '저장'}
      </Button>

      {status.kind === 'error' ? (
        // `role="alert"` because this appears after an action the user took and
        // nothing else on screen moves — without it a screen reader announces
        // nothing at all and the tap looks like it did nothing.
        <p role="alert" className="text-right text-secondary" style={{ font: 'var(--type-caption)' }}>
          {status.detail}
        </p>
      ) : null}
    </div>
  );
}
