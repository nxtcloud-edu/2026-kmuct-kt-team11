'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Chip } from '@/components/surface';
import { ModalSheet } from '@/components/modal-sheet';
import { apiFetch, newIdempotencyKey } from '@/lib/api/client';
import type { GroupInvite } from '@/lib/api/types';
import { messageFor } from '../screen';

/**
 * The invite sheet.
 *
 * WHAT THIS SCREEN CAN AND CANNOT DO, because the shape of it is dictated by the
 * storage decision and not by taste. Only `token_hash` is kept, so there is no
 * endpoint that re-shows a link and there cannot be one without storing the
 * token in a readable form — see the comment at the top of
 * `app/api/groups/[group_id]/invites/route.ts`. A link is therefore visible
 * exactly once, in the response that mints it. Every older invite appears in the
 * list below as something you can *manage* — when it dies, how many people came
 * through it, whether it is still open — and never as something you can re-copy.
 * Saying so on the screen is the only alternative to a user tapping an old row
 * and finding nothing.
 *
 * THE UX CHECKLIST (Invite Mobile), item by item:
 *  · shareable invite link — the primary action, and the only thing above the fold.
 *  · pending invites + actions — every issued link with its status and a revoke
 *    control. This is what makes a reusable link safe to hand out at all: expiry
 *    is a seven-day window you cannot close early.
 *  · access scope summary — stated before the link is minted, not after, because
 *    it is the thing the sharer is deciding about.
 *  · role/permission selection — DELIBERATELY NOT OFFERED. The schema has exactly
 *    two roles and `group_members_one_owner_idx` is a partial unique index that
 *    permits one owner per group, so "invite as owner" is not a thing the data
 *    model can express. A picker with one legal value is a decision-shaped
 *    control that makes no decision; the scope block states the grant instead.
 *  · SKIPPED, and said plainly: email invite, contact picker, bulk invite, seat
 *    limits. None has a backend — there is no invite-by-address endpoint, no
 *    contacts permission, and no seat concept anywhere in the schema — and a
 *    control with nothing behind it is worse than its absence.
 */

type Minted = { id: string; url: string; expires_at: string };

export function InviteSheet({
  open,
  onDismiss,
  groupId,
  groupName,
  memberCount,
  placeCount,
  invites,
}: {
  open: boolean;
  onDismiss: () => void;
  groupId: string;
  groupName: string;
  memberCount: number;
  placeCount: number;
  invites: GroupInvite[];
}) {
  const router = useRouter();
  // The one thing the server cannot re-send. Held here for as long as the sheet
  // is mounted and deliberately not persisted: a token in localStorage is a
  // token in every tab on the device.
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function mint() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ id: string; token: string; url: string; expires_at: string }>(
        `/groups/${groupId}/invites`,
        { method: 'POST', idempotencyKey: newIdempotencyKey() },
      );
      setMinted({ id: res.id, url: res.url, expires_at: res.expires_at });
      setBusy(false);
      router.refresh();
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (revoking) return;
    setRevoking(id);
    setError(null);
    try {
      await apiFetch(`/groups/${groupId}/invites/${id}`, { method: 'DELETE' });
      // The link we are holding is the one that just died. Drop it, or the sheet
      // keeps offering a copy button for a door that is now shut.
      if (minted?.id === id) setMinted(null);
      router.refresh();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setRevoking(null);
    }
  }

  const live = invites.filter((i) => i.status === 'live');

  return (
    <ModalSheet
      open={open}
      onDismiss={onDismiss}
      title="초대하기"
      description={`${groupName}에 들어올 수 있는 링크를 만들어요.`}
    >
      {/* Access scope, before the link. Common Region: the grant and the caveat
          are one tinted block, so they are read as one statement. */}
      <Card className="p-[var(--space-13)]">
        <p style={{ font: 'var(--type-card-title)' }}>링크를 받은 사람이 볼 수 있는 것</p>
        <ul
          className="mt-[var(--space-7)] flex list-none flex-col gap-[var(--space-4)] p-0 text-secondary"
          style={{ font: 'var(--type-meta)' }}
        >
          <li>
            이 그룹에 저장한 곳{' '}
            <span className="tabular-nums">{placeCount}</span>곳과 멤버{' '}
            <span className="tabular-nums">{memberCount}</span>명의 이름
          </li>
          <li>이 그룹에 새 장소를 추가하고, 다른 사람을 초대하는 것</li>
          <li>내가 개인적으로 저장한 곳은 보이지 않아요</li>
        </ul>
        <p className="mt-[var(--space-8)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          들어온 사람은 모두 멤버예요. 관리자는 그룹마다 한 명이라 초대할 때 고를 게 없어요.
        </p>
      </Card>

      {/* The link. */}
      <div className="mt-[var(--space-13)]">
        {minted ? (
          <LinkBlock url={minted.url} expiresAt={minted.expires_at} />
        ) : (
          <Button variant="primary" className="w-full" onClick={mint} disabled={busy}>
            {busy ? '만드는 중…' : live.length > 0 ? '새 초대 링크 만들기' : '초대 링크 만들기'}
          </Button>
        )}
      </div>

      <p
        role="status"
        aria-live="polite"
        className="mt-[var(--space-7)] min-h-[var(--caption-lh)] text-secondary"
        style={{ font: 'var(--type-caption)' }}
      >
        {error ?? ''}
      </p>

      {/* Issued links. */}
      {invites.length > 0 ? (
        <section className="mt-[var(--space-15)]">
          <h3 style={{ font: 'var(--type-card-title)' }}>만든 링크</h3>
          <p className="mt-[var(--space-4)] text-secondary" style={{ font: 'var(--type-caption)' }}>
            보안을 위해 주소는 만들 때 한 번만 보여요. 잃어버렸다면 새로 만들고, 예전 링크는
            사용 중지해 주세요.
          </p>
          <Card className="mt-[var(--space-9)]">
            <ul className="flex list-none flex-col p-0">
              {invites.map((invite, i) => (
                <li
                  key={invite.id}
                  className={
                    'flex items-center gap-[var(--space-9)] px-[var(--space-11)] py-[var(--space-10)] ' +
                    (i > 0 ? 'border-t border-hairline' : '')
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-[var(--space-5)]">
                      <StatusChip status={invite.status} />
                      <span className="text-secondary" style={{ font: 'var(--type-caption)' }}>
                        {invite.created_by.display_name}
                      </span>
                    </div>
                    <p
                      className="mt-[var(--space-4)] text-secondary"
                      style={{ font: 'var(--type-caption)' }}
                    >
                      <span className="tabular-nums">{invite.use_count}</span>명 참여
                      {' · '}
                      {invite.status === 'revoked'
                        ? `${isoDate(invite.revoked_at)} 중지`
                        : invite.status === 'expired'
                          ? `${isoDate(invite.expires_at)} 만료됨`
                          : `${isoDate(invite.expires_at)}까지`}
                    </p>
                  </div>
                  {invite.status === 'live' ? (
                    <button
                      type="button"
                      onClick={() => revoke(invite.id)}
                      disabled={revoking !== null}
                      className="flex h-[var(--tap-min)] shrink-0 items-center
                                 rounded-[var(--radius-lg)] px-[var(--space-8)] text-ink
                                 transition-opacity duration-200
                                 active:opacity-[var(--press-opacity)] disabled:opacity-40"
                      style={{ font: 'var(--type-caption)' }}
                    >
                      {revoking === invite.id ? '중지 중…' : '사용 중지'}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </ModalSheet>
  );
}

/* ── The link and its copy button ─────────────────────────────────────────── */

/**
 * `navigator.clipboard.writeText` needs a secure context — localhost and HTTPS
 * only — and rejects on a denied permission or a document that is not focused.
 * So it is wrapped, its failure is a stated outcome rather than a silent no-op,
 * and the URL is `select-all` text above the button in every case: copying is an
 * accelerator here, never the only way to get the link out of the screen.
 *
 * The confirmation is visible AND announced. A button whose label changed but
 * whose change was never announced is a confirmation only for people watching
 * that exact pixel.
 */
function LinkBlock({ url, expiresAt }: { url: string; expiresAt: string }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function onCopy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopy('copied');
      window.setTimeout(() => setCopy('idle'), 2400);
    } catch {
      setCopy('failed');
    }
  }

  return (
    <Card className="p-[var(--space-13)]">
      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        초대 링크 · <span className="tabular-nums">{isoDate(expiresAt)}</span>까지
      </p>
      {/* `select-all` so one tap selects the whole URL, and `break-all` because a
          token does not contain a break opportunity and would otherwise push the
          sheet sideways. */}
      <p
        className="mt-[var(--space-7)] rounded-[var(--radius-md)] bg-surface-2
                   px-[var(--space-8)] py-[var(--space-7)] [overflow-wrap:anywhere] select-all"
        style={{ font: 'var(--type-caption)' }}
      >
        {url}
      </p>
      <Button variant="primary" className="mt-[var(--space-9)] w-full" onClick={onCopy}>
        {copy === 'copied' ? '복사했어요' : '링크 복사'}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className="mt-[var(--space-6)] min-h-[var(--caption-lh)] text-secondary"
        style={{ font: 'var(--type-caption)' }}
      >
        {copy === 'copied'
          ? '링크를 복사했어요.'
          : copy === 'failed'
            ? '복사할 수 없는 환경이에요. 위 주소를 길게 눌러 직접 복사해 주세요.'
            : ''}
      </p>
    </Card>
  );
}

/* ── Bits ─────────────────────────────────────────────────────────────────── */

function StatusChip({ status }: { status: GroupInvite['status'] }) {
  if (status === 'live') return <Chip>사용 중</Chip>;
  // `danger` renders the red as a 2px rule with the words in ink, which is the
  // only combination in the record's contrast table that passes.
  if (status === 'revoked') return <Chip tone="danger">사용 중지됨</Chip>;
  return <Chip>만료됨</Chip>;
}

/**
 * Deliberately not `Intl.DateTimeFormat`. This component server-renders inside
 * the group page and then hydrates, and a formatter that reads the host's time
 * zone produces one string on the server and another in Seoul — a hydration
 * mismatch on a date that nobody would think to look at. Slicing the ISO string
 * is the same answer in both places.
 */
function isoDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}
