'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Chip, Content } from '@/components/surface';
import { EmptyState } from '@/components/states';
import { ModalSheet } from '@/components/modal-sheet';
import { ApiError, NetworkError, apiFetch, newIdempotencyKey } from '@/lib/api/client';
import type { Group, GroupSummary } from '@/lib/api/types';

export type GroupRow = GroupSummary & { thumbs: string[] };

/**
 * 방 리스트.
 *
 * LAW OF COMMON REGION does the work here. A group's name, its member count, its
 * role badge and the pictures of what is inside it sit on one `--surface-1`
 * tile, so the four facts read as one object rather than four lines that happen
 * to be adjacent; nothing is separated by a rule, because a rule between them
 * would say they are different things.
 *
 * CHUNKING is why the thumbnails are capped at three and the count is not
 * repeated next to them. Three squares is a glance; a full grid of everything in
 * the group would turn a list row into a second screen and the name would stop
 * being what you read first.
 */
export function GroupsScreen({ groups }: { groups: GroupRow[] }) {
  const [creating, setCreating] = useState(false);

  return (
    <Content>
      <header className="mb-[var(--space-15)] flex items-center gap-[var(--space-9)]">
        <h2
          className="min-w-0 flex-1"
          style={{ font: 'var(--type-tab-header)', letterSpacing: 'var(--tab-header-ls)' }}
        >
          그룹
        </h2>
        <button
          type="button"
          onClick={() => setCreating(true)}
          aria-label="그룹 만들기"
          className="flex size-[var(--tap-min)] shrink-0 items-center justify-center
                     rounded-[var(--radius-pill)] bg-surface-2 text-ink
                     transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      {groups.length === 0 ? (
        <EmptyState
          title="아직 그룹이 없어요"
          body="그룹을 만들면 저장한 곳을 함께 모으고 같이 일정을 짤 수 있어요. 만든 뒤 초대 링크를 보내면 친구가 바로 들어와요."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              첫 그룹 만들기
            </Button>
          }
        />
      ) : (
        <ul className="flex list-none flex-col gap-[var(--space-9)] p-0">
          {groups.map((g) => (
            <Card as="li" key={g.id}>
              {/* The whole tile is the target. A row with a tappable name and an
                  untappable picture beside it is one object with two rules. */}
              <Link
                href={`/groups/${g.id}`}
                className="flex items-center gap-[var(--space-11)] p-[var(--space-11)]
                           transition-opacity duration-200 active:opacity-[var(--press-opacity)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-[var(--space-7)]">
                    <p
                      className="min-w-0 [overflow-wrap:anywhere]"
                      style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}
                    >
                      {g.name}
                    </p>
                    {g.role === 'owner' ? <Chip>관리자</Chip> : null}
                  </div>
                  <p
                    className="mt-[var(--space-4)] text-secondary"
                    style={{ font: 'var(--type-meta)' }}
                  >
                    멤버 <span className="tabular-nums">{g.member_count}</span>명
                  </p>
                </div>

                {g.thumbs.length > 0 ? (
                  <div aria-hidden className="flex shrink-0 gap-[var(--space-2)]">
                    {g.thumbs.map((src, i) => (
                      <div
                        key={i}
                        className="relative size-[var(--space-19)] overflow-hidden
                                   rounded-[var(--radius-sm)] bg-surface-2"
                      >
                        <Image src={src} alt="" fill sizes="48px" className="object-cover" />
                      </div>
                    ))}
                  </div>
                ) : null}
              </Link>
            </Card>
          ))}
        </ul>
      )}

      <CreateGroupSheet open={creating} onDismiss={() => setCreating(false)} />
    </Content>
  );
}

/* ── Create ───────────────────────────────────────────────────────────────── */

/**
 * One field, one button, no wizard. The API takes a name and nothing else, so a
 * step count would be describing ceremony rather than work — and everything a
 * group needs after it exists (members, links, a rename) is on the screen this
 * navigates to.
 */
function CreateGroupSheet({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || name.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const group = await apiFetch<Group>('/groups', {
        method: 'POST',
        body: { name: name.trim() },
        // One key per intent, minted here rather than per retry: a double
        // submit must not leave two identically named rooms behind.
        idempotencyKey: newIdempotencyKey(),
      });
      setName('');
      onDismiss();
      router.push(`/groups/${group.id}`);
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
      title="그룹 만들기"
      description="이름만 정하면 끝이에요. 만든 사람이 관리자가 되고, 나중에 이름을 바꿀 수 있어요."
    >
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="group-name" className="block text-secondary" style={{ font: 'var(--type-meta)' }}>
          그룹 이름
        </label>
        <input
          id="group-name"
          name="name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error !== null || undefined}
          aria-describedby="group-name-error"
          placeholder="예) 성수 투어"
          style={{ font: 'var(--type-body)' }}
          className={
            'mt-[var(--space-8)] h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] ' +
            'px-[var(--space-11)] transition-colors duration-200 ' +
            (error ? 'bg-[var(--status-cancel-bg)]' : 'bg-surface-1')
          }
        />
        <p
          id="group-name-error"
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
          disabled={busy || name.trim() === ''}
        >
          {busy ? '만드는 중…' : '만들기'}
        </Button>
      </form>
    </ModalSheet>
  );
}

/**
 * Problem type → Korean. Branches on `is()`, never on `detail`; `detail` is only
 * ever read as a string to show. Half the catalogue's details are still English
 * (lib/problem.ts), so anything we can name, we name here instead.
 */
export function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.is('validation-error')) {
      return err.problem.errors?.[0]?.message ?? '입력을 다시 확인해 주세요.';
    }
    if (err.is('forbidden') || err.is('not-group-member')) return '권한이 없어요.';
    if (err.is('not-found')) return '이미 없어진 항목이에요.';
    if (err.is('last-owner')) return '나가기 전에 다른 멤버를 관리자로 지정해 주세요.';
    if (err.is('invite-already-member')) return '이미 이 그룹의 멤버예요.';
    return err.problem.detail;
  }
  if (err instanceof NetworkError) return err.message;
  return '알 수 없는 오류가 생겼어요.';
}
