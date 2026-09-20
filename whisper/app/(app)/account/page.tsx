import type { Metadata } from 'next';
import { Card, Chip, Content, PageHeader } from '@/components/surface';
import { toMe } from '@/lib/session';
import { requireSession } from '@/lib/require-session';
import { SignOutButton } from './sign-out';

export const metadata: Metadata = { title: '계정' };

/**
 * SCAFFOLD. Read-only apart from sign-out. Editing the display name, changing
 * or removing the email, and linking Instagram all have API routes
 * (`PATCH /api/me`, `PUT|DELETE /api/me/email`) and no screens yet.
 *
 * Note for whoever builds those: removing the last recovery channel is a 409
 * (`recovery-channel-required`), not a validation error. It needs a real
 * explanation in the UI, not a red field.
 */
export default async function AccountPage() {
  const me = toMe(await requireSession());

  return (
    <Content>
      <PageHeader title="계정" />

      <Card className="flex flex-col gap-4 p-6">
        <Field label="이름" value={me.display_name} />
        <Field label="이메일" value={me.email ?? '연결되지 않음'} />

        <div>
          <p className="text-secondary">로그인 수단</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {me.instagram_linked ? <Chip>Instagram</Chip> : null}
            {me.email_verified ? <Chip>이메일</Chip> : null}
            {me.recovery_channels.length === 0 ? <Chip tone="danger">없음</Chip> : null}
          </div>
        </div>
      </Card>

      <div className="mt-6">
        <SignOutButton />
      </div>
    </Content>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-secondary">{label}</p>
      <p className="mt-0.5 [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}
