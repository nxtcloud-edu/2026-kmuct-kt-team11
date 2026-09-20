'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/surface';
import { ApiError, apiFetch, newIdempotencyKey } from '@/lib/api/client';

type CreatedGroup = { id: string };

export function CreateGroupForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const group = await apiFetch<CreatedGroup>('/groups', {
        method: 'POST',
        body: { name: name.trim() },
        idempotencyKey: newIdempotencyKey(),
      });
      router.replace(`/groups/${group.id}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '서버에 연결하지 못했어요.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor="group-name" className="block text-secondary" style={{ font: 'var(--type-meta)' }}>
        그룹 이름
      </label>
      <input
        id="group-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={120}
        required
        autoFocus
        placeholder="예: 주말 데이트"
        className="mt-2 h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] bg-surface-1 px-4"
        style={{ font: 'var(--type-body)' }}
      />
      <p role="status" className="mt-2 min-h-[var(--caption-lh)] text-secondary" style={{ font: 'var(--type-caption)' }}>
        {error}
      </p>
      <Button type="submit" variant="primary" className="mt-3 w-full" disabled={busy || !name.trim()}>
        {busy ? '만드는 중…' : '그룹 만들기'}
      </Button>
    </form>
  );
}
