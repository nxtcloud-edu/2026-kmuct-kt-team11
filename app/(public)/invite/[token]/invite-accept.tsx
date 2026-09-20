'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/surface';
import { ApiError, apiFetch } from '@/lib/api/client';

type InviteResponse = {
  requires?: 'recovery_channel';
  group: { id: string; name: string; member_count: number };
  role?: 'member';
};

export function InviteAccept({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<InviteResponse['group'] | null>(null);

  const next = `/invite/${token}`;
  const query = `?next=${encodeURIComponent(next)}`;

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await apiFetch<InviteResponse>(`/invites/${token}/accept`, { method: 'POST' });
      if (result.requires) {
        setPreview(result.group);
        setBusy(false);
        return;
      }
      router.replace(`/groups/${result.group.id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '서버에 연결하지 못했어요.');
      setBusy(false);
    }
  }

  return (
    <div className="mt-[var(--space-17)]">
      {preview ? (
        <div>
          <p style={{ font: 'var(--type-section)' }}>{preview.name}</p>
          <p className="mt-1 text-secondary">현재 멤버 {preview.member_count}명</p>
          <p className="mt-4 text-secondary">그룹에 참여하려면 먼저 로그인하거나 계정을 만들어 주세요.</p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <Link
              href={`/sign-in${query}`}
              className="flex h-[var(--field-height)] items-center justify-center rounded-[var(--radius-lg)] bg-surface-2"
              style={{ font: 'var(--type-button)' }}
            >
              로그인
            </Link>
            <Link
              href={`/sign-up${query}`}
              className="flex h-[var(--field-height)] items-center justify-center rounded-[var(--radius-lg)] bg-ink text-on-ink"
              style={{ font: 'var(--type-button)' }}
            >
              계정 만들기
            </Link>
          </div>
        </div>
      ) : (
        <Button type="button" variant="primary" className="w-full" onClick={accept} disabled={busy}>
          {busy ? '확인하는 중…' : '초대 확인하기'}
        </Button>
      )}
      <p role="status" className="mt-3 min-h-[var(--caption-lh)] text-secondary" style={{ font: 'var(--type-caption)' }}>
        {error}
      </p>
    </div>
  );
}
