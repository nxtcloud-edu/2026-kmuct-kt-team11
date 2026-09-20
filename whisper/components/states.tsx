/**
 * The non-happy-path states, built once so no screen has to reinvent them and
 * none can quietly ship with only the ideal state.
 *
 * Every list screen in Gaja is expected to render each of these:
 *   loading · empty · error · permission-denied · offline
 * Partial and overloaded are handled by cursor pagination, not by a component.
 *
 * Copy is Korean because `users.locale` defaults to `ko` and the product is
 * Seoul-first. Strings are inline rather than in a message catalogue: i18n is
 * not in slice 1 and a catalogue with one locale is overhead that hides text.
 */
import type { ReactNode } from 'react';
import { Card } from './surface';

/* ── Notice ───────────────────────────────────────────────────────────────── */

/**
 * `danger` is a whole tinted surface — `--status-cancel-bg` — rather than a rule
 * down the left edge. `--status-cancel-fg` on that background measures 2.97:1
 * and fails even the 3:1 UI threshold, so the words stay in `--ink` (14.85:1)
 * and the pastel does the signalling. See the record's contrast table.
 *
 * The background is set as an inline style, not a utility: `Card` already emits
 * a `background-color` utility and two utilities of the same family have no
 * guaranteed order in the generated stylesheet.
 */
export function Notice({
  title,
  body,
  action,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  action?: ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <Card
      className="p-6"
      style={tone === 'danger' ? { background: 'var(--status-cancel-bg)' } : undefined}
      role={tone === 'danger' ? 'alert' : undefined}
    >
      <p style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>{title}</p>
      <p className="mt-1.5 text-secondary" style={{ font: 'var(--type-body)' }}>
        {body}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </Card>
  );
}

/* ── Loading ──────────────────────────────────────────────────────────────── */

/**
 * Shapes match the real card so nothing jumps when data lands — a skeleton that
 * is the wrong height is worse than a spinner. Rows are staggered in width only;
 * the record's motion budget has no transforms, so this does not shimmer.
 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="불러오는 중">
      {Array.from({ length: rows }, (_, i) => (
        <Card key={i} className="flex items-center gap-3 p-4">
          <div className="h-3.5 w-11 rounded bg-surface-2" />
          <div className="flex-1">
            <div className="h-4 rounded bg-surface-2" style={{ width: `${45 + i * 12}%` }} />
            <div className="mt-2 h-3 w-[30%] rounded bg-surface-2" />
          </div>
          <div className="h-14 w-14 shrink-0 rounded-[var(--radius-md)] bg-surface-2" />
        </Card>
      ))}
    </div>
  );
}

/* ── Terminal states ──────────────────────────────────────────────────────── */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return <Notice title={title} body={body} action={action} />;
}

/**
 * `detail` comes from the RFC 9457 problem document, which is written to be
 * shown to a user — see the catalogue in `lib/problem.ts`. `request_id` is
 * rendered in `--text-secondary`, never `--text-tertiary`: it is text a user may
 * have to read aloud to support, so it cannot sit at 2.81:1.
 */
export function ErrorState({
  detail,
  requestId,
  action,
}: {
  detail: string;
  requestId?: string | null;
  action?: ReactNode;
}) {
  return (
    <Notice
      tone="danger"
      title="불러오지 못했어요"
      body={detail}
      action={
        <div className="flex flex-col gap-3">
          {action}
          {requestId ? (
            <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
              문의 시 이 번호를 알려주세요: <span className="tabular-nums">{requestId}</span>
            </p>
          ) : null}
        </div>
      }
    />
  );
}

/** 403, not 401. A signed-in user who may not see this thing. */
export function NotAllowedState({ body }: { body?: string }) {
  return (
    <Notice
      title="볼 수 없는 페이지예요"
      body={body ?? '이 그룹의 멤버만 볼 수 있어요. 초대를 받아 참여해 주세요.'}
    />
  );
}

export function OfflineState({ action }: { action?: ReactNode }) {
  return (
    <Notice
      tone="danger"
      title="서버에 연결하지 못했어요"
      body="네트워크 연결을 확인한 뒤 다시 시도해 주세요."
      action={action}
    />
  );
}
