'use client';

import { useState } from 'react';
import { Button } from '@/components/surface';
import { ApiError, apiFetch, newIdempotencyKey } from '@/lib/api/client';

export function InviteButton({ groupId }: { groupId: string }) {
  const [label, setLabel] = useState('초대');

  async function invite() {
    try {
      setLabel('만드는 중…');
      const result = await apiFetch<{ url: string }>(`/groups/${groupId}/invites`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
      });
      await navigator.clipboard.writeText(result.url);
      setLabel('링크 복사됨');
    } catch (cause) {
      setLabel(cause instanceof ApiError ? '다시 시도' : '연결 확인');
    }
  }

  return (
    <Button type="button" variant="secondary" onClick={invite} className="shrink-0 px-4">
      {label}
    </Button>
  );
}
