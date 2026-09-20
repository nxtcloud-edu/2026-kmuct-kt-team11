'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { Button, Card, ChoicePill } from '@/components/surface';
import { MbtiAvatar, MbtiPicker } from '@/components/mbti-picker';
import { AGE_BANDS, AREAS, GENDERS, UNSET, ageBandLabel, genderLabel } from '@/lib/profile';
import type { Me } from '@/lib/api/types';
import type { AgeBand, Gender } from '@/lib/session';

/**
 * Who the user is here, and the four answers the product asked for and then
 * never showed back.
 *
 * This is the first thing on the screen on purpose. The serial position effect
 * says the first and last items are the ones remembered, and the only reason to
 * open an account screen is to check what a product thinks you are — so identity
 * is first and the destructive action is last, with everything else between.
 *
 * The four facts are labelled as what they are: inputs to recommendations. They
 * are not trivia and they are not settings that do something on their own, and
 * the caption says so rather than leaving the user to infer it.
 *
 * WHY EDITABLE AT ALL. Every one of these questions is skippable in onboarding,
 * and onboarding is not re-enterable — `app/(onboarding)/layout.tsx` redirects
 * an onboarded user straight to /home. Without an editor here, a skipped answer
 * would be a blank the user could see and never fill. `PATCH /api/me` already
 * accepts all five fields, so this writes through the real route and nothing is
 * mocked.
 */

type Profile = {
  display_name: string;
  gender: Gender | null;
  age_band: AgeBand | null;
  mbti: string | null;
  home_area: string | null;
};

export function ProfileCard({ initial }: { initial: Profile }) {
  const router = useRouter();
  // The server render seeds this; after a save the PATCH response replaces it.
  // This component is the only writer, so a single local copy cannot go stale
  // against the page — and `router.refresh()` still runs so that /home, which
  // reads mbti and home_area, is not left holding the old answers.
  const [saved, setSaved] = useState<Profile>(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Profile>(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const current = editing ? draft : saved;
  const nameId = useId();
  const mbtiId = useId();
  const genderId = useId();
  const ageId = useId();
  const areaId = useId();

  const nameEmpty = draft.display_name.trim() === '';

  function open() {
    setDraft(saved);
    setFailure(null);
    setConfirmed(false);
    setEditing(true);
  }

  async function save() {
    if (busy || nameEmpty) return;
    setBusy(true);
    setFailure(null);
    try {
      // Every key is sent, including the nulls. `PATCH /api/me` reads presence
      // rather than value — `'mbti' in body` is what decides between "clear this"
      // and "leave it alone" — so an omitted key here would silently make
      // clearing an answer impossible.
      const me = await apiFetch<Me>('/me', {
        method: 'PATCH',
        body: {
          display_name: draft.display_name.trim(),
          gender: draft.gender,
          age_band: draft.age_band,
          mbti: draft.mbti,
          home_area: draft.home_area,
        },
      });
      setSaved({
        display_name: me.display_name,
        gender: me.gender,
        age_band: me.age_band,
        mbti: me.mbti,
        home_area: me.home_area,
      });
      setEditing(false);
      setConfirmed(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFailure(err.problem.detail);
      else if (err instanceof NetworkError) setFailure(err.message);
      else setFailure('알 수 없는 오류가 생겼어요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-[var(--space-13)]">
      {/* Identity. The art updates as the picker is used, so choosing a type in
          edit mode shows you the thing you are choosing rather than a label. */}
      <div className="flex items-center gap-[var(--space-11)]">
        <MbtiAvatar mbti={current.mbti} size={96} />
        <div className="min-w-0">
          <h1
            className="[overflow-wrap:anywhere]"
            style={{ font: 'var(--type-screen-title)', letterSpacing: 'var(--screen-title-ls)' }}
          >
            {saved.display_name}
          </h1>
          <p className="mt-[var(--space-4)] text-secondary" style={{ font: 'var(--type-caption)' }}>
            성격 유형
          </p>
          <p className="mt-[var(--space-1)]" style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
            {current.mbti ?? UNSET}
          </p>
        </div>
      </div>

      <hr className="my-[var(--space-13)] border-0 border-t border-divider" />

      {editing ? (
        <div className="flex flex-col gap-[var(--space-15)]">
          <Field label="이름" id={nameId}>
            <input
              id={nameId}
              value={draft.display_name}
              onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
              maxLength={20}
              aria-invalid={nameEmpty}
              className="h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] bg-surface-2 px-[var(--space-11)]"
              style={{ font: 'var(--type-body)' }}
            />
          </Field>

          <Field label="성격 유형" id={mbtiId} asGroup>
            <MbtiPicker
              value={draft.mbti}
              onSelect={(t) => setDraft({ ...draft, mbti: t })}
              onUnknown={() => setDraft({ ...draft, mbti: null })}
              unknownSelected={draft.mbti === null}
              labelledBy={mbtiId}
            />
          </Field>

          <Field label="성별" id={genderId} asGroup>
            <div role="group" aria-labelledby={genderId} className="flex flex-wrap gap-[var(--space-7)]">
              {GENDERS.map((g) => (
                <ChoicePill
                  key={g.value}
                  selected={draft.gender === g.value}
                  onClick={() => setDraft({ ...draft, gender: g.value })}
                >
                  {g.label}
                </ChoicePill>
              ))}
            </div>
          </Field>

          <Field label="연령대" id={ageId} asGroup>
            <div role="group" aria-labelledby={ageId} className="flex flex-wrap gap-[var(--space-7)]">
              {AGE_BANDS.map((a) => (
                <ChoicePill
                  key={a.value}
                  selected={draft.age_band === a.value}
                  onClick={() => setDraft({ ...draft, age_band: a.value })}
                >
                  {a.label}
                </ChoicePill>
              ))}
            </div>
          </Field>

          <Field label="주로 노는 곳" id={areaId} asGroup>
            <div role="group" aria-labelledby={areaId} className="flex flex-wrap gap-[var(--space-7)]">
              {AREAS.map((a) => (
                <ChoicePill
                  key={a}
                  selected={draft.home_area === a}
                  onClick={() => setDraft({ ...draft, home_area: a })}
                >
                  {a}
                </ChoicePill>
              ))}
            </div>
          </Field>

          {failure ? (
            <p
              role="alert"
              className="rounded-[var(--radius-2xl)] bg-[var(--status-cancel-bg)] p-[var(--space-9)] text-ink"
              style={{ font: 'var(--type-meta)' }}
            >
              {failure}
            </p>
          ) : null}

          <div className="flex gap-[var(--space-7)]">
            <Button variant="primary" className="flex-1" onClick={save} disabled={busy || nameEmpty}>
              {busy ? '저장 중' : '저장'}
            </Button>
            <Button variant="quiet" onClick={() => setEditing(false)} disabled={busy}>
              취소
            </Button>
          </div>
        </div>
      ) : (
        <>
          <dl className="flex flex-col gap-[var(--space-9)]">
            <Row term="성별" value={genderLabel(saved.gender)} />
            <Row term="연령대" value={ageBandLabel(saved.age_band)} />
            <Row term="주로 노는 곳" value={saved.home_area ?? UNSET} />
          </dl>

          <p className="mt-[var(--space-13)] text-secondary" style={{ font: 'var(--type-caption)' }}>
            비슷한 사람들이 좋아한 곳을 찾는 데만 써요. 그룹에는 이름만 보여요.
          </p>

          {/* The save confirmation the checklist asks for: inline, next to the
              thing that changed, and announced. There is no toast vocabulary in
              this system and inventing one for a single message would be a new
              component nobody else could use. */}
          {confirmed ? (
            <p role="status" className="mt-[var(--space-9)] text-secondary" style={{ font: 'var(--type-meta)' }}>
              저장했어요
            </p>
          ) : null}

          <Button className="mt-[var(--space-13)] w-full" onClick={open}>
            프로필 수정
          </Button>
        </>
      )}
    </Card>
  );
}

/** Label plus value. `--text-secondary` on `--surface-1` is 5.11:1; the record's
 *  contrast table forbids `--text-tertiary` for anything readable, and a skipped
 *  answer is something a user has to be able to read. */
function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-[var(--space-11)]">
      <dt className="text-secondary shrink-0" style={{ font: 'var(--type-meta)' }}>
        {term}
      </dt>
      <dd className="m-0 text-right [overflow-wrap:anywhere]" style={{ font: 'var(--type-body)' }}>
        {value}
      </dd>
    </div>
  );
}

/**
 * A labelled field in edit mode. `asGroup` swaps `<label>` for a plain element:
 * a label pointing at a group of buttons has nothing to focus, and screen
 * readers announce it through `aria-labelledby` on the group instead.
 */
function Field({
  label,
  id,
  asGroup = false,
  children,
}: {
  label: string;
  id: string;
  asGroup?: boolean;
  children: React.ReactNode;
}) {
  const Tag = asGroup ? 'p' : 'label';
  return (
    <div>
      <Tag
        id={id}
        {...(asGroup ? {} : { htmlFor: id })}
        className="block text-secondary"
        style={{ font: 'var(--type-caption)' }}
      >
        {label}
      </Tag>
      <div className="mt-[var(--space-7)]">{children}</div>
    </div>
  );
}
