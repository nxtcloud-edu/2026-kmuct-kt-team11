'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/surface';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';

/**
 * The confirm. A Client Component because joining is a POST and the page around
 * it is static server output.
 *
 * The failure branches matter as much as the success one: a link can die between
 * the render and the tap — the sharer revokes it, or the seventh day passes —
 * and the page the reader is looking at would still be showing the group's name.
 * Each of those gets its own sentence, and `router.refresh()` re-runs the server
 * preview so the screen itself catches up with what just happened rather than
 * leaving a dead 참여하기 button under an error.
 */
export function JoinButton({
  token,
  groupId,
  groupName,
}: {
  token: string;
  groupId: string;
  groupName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onJoin() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
      router.replace(`/groups/${groupId}`);
      router.refresh();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError) {
        if (err.is('invite-already-member')) {
          // Not a failure worth explaining — they are in, which is what they
          // asked for. Take them there.
          router.replace(`/groups/${groupId}`);
          router.refresh();
          return;
        }
        if (err.is('invite-revoked')) {
          setError('방금 이 링크의 사용이 중지됐어요. 그룹 멤버에게 새 링크를 요청해 주세요.');
        } else if (err.is('invite-expired')) {
          setError('방금 이 링크가 만료됐어요. 초대해 준 사람에게 새 링크를 받아 주세요.');
        } else if (err.is('invite-invalid')) {
          setError('이 초대 링크를 더 이상 쓸 수 없어요.');
        } else if (err.is('unauthenticated')) {
          // The session lapsed between the render and the tap. Send them through
          // sign-in with the token still in `next`, so nothing is lost.
          router.push(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
          return;
        } else {
          setError(err.problem.detail);
        }
        // The page's own state is now stale in every one of those branches.
        router.refresh();
        return;
      }
      setError(err instanceof NetworkError ? err.message : '알 수 없는 오류가 생겼어요.');
    }
  }

  return (
    <>
      <Button variant="primary" className="w-full" onClick={onJoin} disabled={busy}>
        {busy ? '참여하는 중…' : `${groupName} 참여하기`}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className="mt-[var(--space-7)] min-h-[var(--caption-lh)] text-secondary"
        style={{ font: 'var(--type-caption)' }}
      >
        {error ?? ''}
      </p>
    </>
  );
}
