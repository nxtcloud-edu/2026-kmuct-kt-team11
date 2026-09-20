import type { Metadata } from 'next';
import { Card, Chip, Content } from '@/components/surface';
import { Notice } from '@/components/states';
import { query, queryOne } from '@/lib/db';
import { requireSession } from '@/lib/require-session';
import { toMe } from '@/lib/session';
import { InstagramCard } from './instagram-card';
import { ProfileCard } from './profile-card';
import { SignOutButton } from './sign-out';

export const metadata: Metadata = { title: '계정' };

/**
 * The account screen.
 *
 * It used to be three label/value rows and a button on an otherwise empty
 * canvas, and it showed none of the five things onboarding had just asked for —
 * a product that interviews you and then never mentions the answers again reads
 * as unfinished, which by the aesthetic-usability effect is how the whole app
 * then reads. Everything the account genuinely knows is now on the screen, in
 * three groups that are each honest about what they are:
 *
 *   1. who you are here — name, the MBTI art as the avatar, and the four
 *      onboarding answers, labelled as inputs to recommendations
 *   2. 연결된 계정 — Instagram, which is a delivery address, not a credential
 *   3. 로그인 — the things that can actually produce a session
 *
 * and then, separated from all of it, 로그아웃. First and last are what get
 * remembered; identity takes the first slot and the destructive action the last.
 *
 * THE BUG THIS FIXES. The old screen put an `Instagram` chip under a heading
 * reading 로그인 수단. There is no Instagram OAuth in this app — `SOCIAL_PROVIDERS`
 * is `['google']` — and `instagram_linked` is derived from `users.igsid`, which
 * means "DMs from this Instagram account route to this Gaja account". Calling
 * that a login method claimed that whoever holds the Instagram account can sign
 * in as this user. See instagram-card.tsx and docs/gaja/instagram-binding.md.
 *
 * NOT HERE, AND WHY. There is no account-deletion route anywhere in `app/api/`
 * and no password-change route (`POST /auth/password` signs up and signs in; it
 * does not rotate a password held by a signed-in user). Both are on the account
 * checklist and both are deliberately absent from this screen rather than faked:
 * a 계정 삭제 button that opens nothing is worse than its absence.
 */
export default async function AccountPage() {
  const user = await requireSession();
  const me = toMe(user);

  // Two facts this screen needs that the session object does not carry, read
  // here rather than by widening `SessionUser` — the same thing
  // app/(app)/groups/page.tsx does. A password hash in particular has no
  // business riding along on every authenticated request.
  const [credential, socials] = await Promise.all([
    queryOne<{ has_password: boolean }>(
      `select password_hash is not null as has_password from users where id = $1`,
      [user.id],
    ),
    query<{ provider: string }>(
      `select provider from auth_identities where user_id = $1 order by provider`,
      [user.id],
    ),
  ]);

  return (
    <Content>
      <header className="mb-[var(--space-13)]">
        <span
          className="inline-flex items-center rounded-[var(--radius-sm)] bg-surface-1 px-[var(--space-7)] py-[var(--space-3)] text-secondary"
          style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
        >
          계정
        </span>
      </header>

      <ProfileCard
        initial={{
          display_name: user.display_name,
          gender: user.gender,
          age_band: user.age_band,
          mbti: user.mbti,
          home_area: user.home_area,
        }}
      />

      <Section title="연결된 계정">
        <InstagramCard handle={user.instagram_handle} linked={me.instagram_linked} />
      </Section>

      <Section title="로그인">
        <Card className="p-[var(--space-13)]">
          <dl className="flex flex-col gap-[var(--space-11)]">
            {/* The address is the credential: a magic link goes to it, and the
                password — when there is one — is checked against it. 인증됨 is
                shown when it is true and nothing is shown when it is not, because
                an unverified address still signs this account in and a warning
                nobody can act on is just a warning. */}
            <Line
              term="이메일"
              value={me.email ?? '연결되지 않음'}
              chip={me.email_verified ? '인증됨' : undefined}
            />
            <Line term="비밀번호" value={credential?.has_password ? '설정됨' : '설정 안 함'} />
            {socials.map((s) => (
              <Line key={s.provider} term={PROVIDER_LABEL[s.provider] ?? s.provider} value="연결됨" />
            ))}
          </dl>

          <p className="mt-[var(--space-13)] text-secondary" style={{ font: 'var(--type-caption)' }}>
            {me.email
              ? '이메일로 로그인 링크를 받거나 비밀번호로 들어올 수 있어요.'
              : '이메일을 연결하면 로그인 링크를 받을 수 있어요.'}
          </p>
        </Card>

        {/* The D3 constraint, as a sentence rather than a constraint violation.
            The same rule is why DELETE /api/me/email answers 409 instead of a
            validation error — see app/api/me/email/route.ts. */}
        {me.recovery_channels.length === 0 ? (
          <div className="mt-[var(--space-9)]">
            <Notice
              tone="danger"
              title="계정을 되찾을 방법이 없어요"
              body="이메일을 연결해 두면 기기를 바꾸거나 로그아웃해도 다시 들어올 수 있어요."
            />
          </div>
        ) : null}
      </Section>

      {/* Last, and past a rule. Signing out is not part of reading your own
          profile, so it is reachable without being on the way to anything. */}
      <div className="mt-[var(--space-19)] border-t border-divider pt-[var(--space-15)]">
        <SignOutButton />
      </div>
    </Content>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  kakao: '카카오',
  apple: 'Apple',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-[var(--section-gap)]">
      <h2 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>{title}</h2>
      <div className="mt-[var(--space-9)]">{children}</div>
    </section>
  );
}

function Line({ term, value, chip }: { term: string; value: string; chip?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-[var(--space-11)]">
      <dt className="shrink-0 text-secondary" style={{ font: 'var(--type-meta)' }}>
        {term}
      </dt>
      <dd className="m-0 flex min-w-0 items-baseline justify-end gap-[var(--space-7)] text-right">
        <span className="[overflow-wrap:anywhere]" style={{ font: 'var(--type-body)' }}>
          {value}
        </span>
        {chip ? <Chip>{chip}</Chip> : null}
      </dd>
    </div>
  );
}
