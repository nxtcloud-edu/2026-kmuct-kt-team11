'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Chip, Content } from '@/components/surface';
import { ModalSheet } from '@/components/modal-sheet';
import { apiFetch } from '@/lib/api/client';
import type { Group, GroupInvite, GroupMember, GroupRole } from '@/lib/api/types';
import { messageFor } from '../screen';
import { InviteSheet } from './invite-sheet';

/**
 * One group's screen.
 *
 * LAW OF COMMON REGION, again and deliberately: the name, the member count and
 * the place count sit together on one tinted block at the top, and the member
 * list is a second block below it. Two regions, two objects — "what this group
 * is" and "who is in it" — rather than one undifferentiated column of rows.
 *
 * CHUNKING decides the order. Identity first, then people, then the actions that
 * change either. 나가기 is last and quiet: it is the one irreversible thing here,
 * and putting it beside 초대하기 would make the destructive action a peer of the
 * one people came for.
 */
export function GroupScreen({
  groupId,
  name: initialName,
  role,
  members,
  invites,
  placeCount,
  meId,
}: {
  groupId: string;
  name: string;
  role: GroupRole;
  members: GroupMember[];
  invites: GroupInvite[];
  placeCount: number;
  meId: string;
}) {
  const router = useRouter();
  // Server-rendered name is the source of truth; this holds the optimistic value
  // between a successful PATCH and the refresh that re-renders the page. It is
  // seeded from the prop during render, never repaired from it inside an effect.
  const [name, setName] = useState(initialName);
  const [sheet, setSheet] = useState<'none' | 'rename' | 'invite' | 'leave'>('none');

  return (
    <Content>
      <header className="mb-[var(--space-15)]">
        <Link
          href="/groups"
          className="inline-flex h-[var(--tap-min)] items-center text-secondary
                     transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
          style={{ font: 'var(--type-meta)' }}
        >
          ← 그룹
        </Link>
      </header>

      <Card className="p-[var(--space-15)]">
        <h2
          className="[overflow-wrap:anywhere]"
          style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
        >
          {name}
        </h2>
        <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          멤버 <span className="tabular-nums">{members.length}</span>명
          {placeCount > 0 ? (
            <>
              {' · '}저장한 곳 <span className="tabular-nums">{placeCount}</span>곳
            </>
          ) : null}
        </p>

        <div className="mt-[var(--space-13)] flex flex-wrap gap-[var(--space-7)]">
          <Button variant="primary" onClick={() => setSheet('invite')}>
            초대하기
          </Button>
          {role === 'owner' ? (
            <Button variant="secondary" onClick={() => setSheet('rename')}>
              이름 바꾸기
            </Button>
          ) : null}
        </div>
      </Card>

      <section className="mt-[var(--space-16)]">
        <h3
          className="mb-[var(--space-9)]"
          style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}
        >
          멤버
        </h3>
        <Card>
          <ul className="flex list-none flex-col p-0">
            {members.map((m, i) => (
              <li
                key={m.user_id}
                className={
                  'flex items-center gap-[var(--space-9)] px-[var(--space-11)] py-[var(--space-10)] ' +
                  // A hairline between rows, not a gap: the list is one region
                  // and a gap would break it into as many objects as it has
                  // members.
                  (i > 0 ? 'border-t border-hairline' : '')
                }
              >
                <span
                  aria-hidden
                  className="flex size-[var(--space-17)] shrink-0 items-center justify-center
                             rounded-[var(--radius-pill)] bg-surface-2 text-ink"
                  style={{ font: 'var(--type-card-title)' }}
                >
                  {m.display_name.slice(0, 1)}
                </span>
                <p className="min-w-0 flex-1 [overflow-wrap:anywhere]" style={{ font: 'var(--type-body)' }}>
                  {m.display_name}
                  {m.user_id === meId ? (
                    <span className="text-secondary"> (나)</span>
                  ) : null}
                </p>
                {m.role === 'owner' ? <Chip>관리자</Chip> : null}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <div className="mt-[var(--space-16)]">
        <Button variant="quiet" onClick={() => setSheet('leave')} className="w-full">
          그룹에서 나가기
        </Button>
      </div>

      <RenameSheet
        open={sheet === 'rename'}
        onDismiss={() => setSheet('none')}
        groupId={groupId}
        current={name}
        onRenamed={(next) => {
          setName(next);
          setSheet('none');
          router.refresh();
        }}
      />

      <InviteSheet
        open={sheet === 'invite'}
        onDismiss={() => setSheet('none')}
        groupId={groupId}
        groupName={name}
        memberCount={members.length}
        placeCount={placeCount}
        invites={invites}
      />

      <LeaveSheet
        open={sheet === 'leave'}
        onDismiss={() => setSheet('none')}
        groupId={groupId}
        meId={meId}
        name={name}
      />
    </Content>
  );
}

/* ── Rename ───────────────────────────────────────────────────────────────── */

function RenameSheet({
  open,
  onDismiss,
  groupId,
  current,
  onRenamed,
}: {
  open: boolean;
  onDismiss: () => void;
  groupId: string;
  current: string;
  onRenamed: (name: string) => void;
}) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || value.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const group = await apiFetch<Group>(`/groups/${groupId}`, {
        method: 'PATCH',
        body: { name: value.trim() },
      });
      setBusy(false);
      onRenamed(group.name);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  return (
    <ModalSheet open={open} onDismiss={onDismiss} title="이름 바꾸기">
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="rename" className="block text-secondary" style={{ font: 'var(--type-meta)' }}>
          그룹 이름
        </label>
        <input
          id="rename"
          name="name"
          required
          maxLength={120}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error !== null || undefined}
          aria-describedby="rename-error"
          style={{ font: 'var(--type-body)' }}
          className={
            'mt-[var(--space-8)] h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] ' +
            'px-[var(--space-11)] transition-colors duration-200 ' +
            (error ? 'bg-[var(--status-cancel-bg)]' : 'bg-surface-1')
          }
        />
        <p
          id="rename-error"
          role="status"
          aria-live="polite"
          className="mt-[var(--space-7)] min-h-[var(--caption-lh)] text-secondary"
          style={{ font: 'var(--type-caption)' }}
        >
          {error ?? ''}
        </p>
        <Button
          type="submit"
          variant="primary"
          className="mt-[var(--space-9)] w-full"
          disabled={busy || value.trim() === '' || value.trim() === current}
        >
          {busy ? '저장 중…' : '저장'}
        </Button>
      </form>
    </ModalSheet>
  );
}

/* ── Leave ────────────────────────────────────────────────────────────────── */

/**
 * Leaving is `DELETE /groups/{id}/members/{me}` — self is leave, someone else is
 * remove. The `last-owner` 409 is the interesting branch and is stated up front
 * rather than after the failure: an owner who is the last member out needs to
 * hand the room over first, and finding that out by being refused is finding it
 * out too late.
 */
function LeaveSheet({
  open,
  onDismiss,
  groupId,
  meId,
  name,
}: {
  open: boolean;
  onDismiss: () => void;
  groupId: string;
  meId: string;
  name: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLeave() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/groups/${groupId}/members/${meId}`, { method: 'DELETE' });
      router.replace('/groups');
      router.refresh();
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  return (
    <ModalSheet
      open={open}
      onDismiss={onDismiss}
      title="그룹에서 나갈까요?"
      description={`${name}에서 나가면 이 그룹에 저장한 곳을 더 이상 볼 수 없어요. 다시 들어오려면 초대 링크가 필요해요.`}
    >
      <p
        role="status"
        aria-live="polite"
        className="min-h-[var(--caption-lh)] text-secondary"
        style={{ font: 'var(--type-caption)' }}
      >
        {error ?? ''}
      </p>
      <div className="mt-[var(--space-9)] flex flex-col gap-[var(--space-7)]">
        <Button variant="primary" onClick={onLeave} disabled={busy}>
          {busy ? '나가는 중…' : '나가기'}
        </Button>
        <Button variant="quiet" onClick={onDismiss} disabled={busy}>
          그대로 있기
        </Button>
      </div>
    </ModalSheet>
  );
}
