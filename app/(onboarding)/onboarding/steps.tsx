'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { ChoicePill } from '@/components/surface';
import { MbtiPicker } from '@/components/mbti-picker';
import type { MbtiType } from '@/lib/mbti';
import { AGE_BANDS, AREAS, GENDERS } from '@/lib/profile';
import type { AgeBand, Gender } from '@/lib/session';

/**
 * Onboarding, five steps.
 *
 * Only the nickname is required. Everything else can be skipped, and skipping
 * writes nothing for that field while still completing the flow — skipping is an
 * answer, and being asked twice is not. That is why the whole draft is sent in a
 * single PATCH at the end rather than one request per step: a half-finished
 * profile with onboarded_at already set would be the worst of both.
 *
 * 연령대 rather than an exact age. It buckets identically for recommendation
 * purposes and is materially less invasive to ask of someone who has just
 * arrived. 성별 offers 선택 안 함 and MBTI offers 잘 모르겠어요 for the same
 * reason — a forced guess would poison the recommendations these questions exist
 * to feed.
 *
 * The last step asks for an Instagram handle. It is a HINT and nothing else: it
 * may narrow a lookup when a DM arrives from an igsid nobody recognises, and it
 * can never route that DM by itself — binding needs a signed webhook payload plus
 * a confirmation from inside a signed-in session. docs/gaja/instagram-binding.md
 * is the rule; the copy on the step is careful not to promise more than that,
 * because nothing downstream of it is built yet.
 *
 * Motion is opacity only. The system's budget has no transforms, so steps
 * cross-fade rather than slide.
 */

type Draft = {
  display_name?: string;
  gender?: Gender;
  age_band?: AgeBand;
  mbti?: MbtiType;
  home_area?: string;
  instagram_handle?: string;
};

const TOTAL = 5;

export function OnboardingSteps({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [name, setName] = useState(initialName);
  const [handle, setHandle] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const patch = (d: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...d }));

  // Derived during render, never written back into state by an effect. The field
  // holds exactly what was typed; what the server is sent is computed from it.
  // (Same normalisation as the zod schema in app/api/me/route.ts and the CHECK in
  // 20260920000006 — three places, one alphabet.)
  const normalisedHandle = handle.trim().replace(/^@+/, '').toLowerCase();
  const handleMalformed =
    normalisedHandle !== '' && !/^[a-z0-9._]{1,30}$/.test(normalisedHandle);

  // What this step contributes to the draft. An absent key means "leave it
  // alone" all the way to the SQL, so skipping never writes anything.
  function stepAnswer(): Partial<Draft> {
    if (step === 0) return { display_name: name.trim() };
    if (step === 4) return normalisedHandle === '' ? {} : { instagram_handle: normalisedHandle };
    return {};
  }

  async function finish(final: Draft) {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await apiFetch('/me', { method: 'PATCH', body: { ...final, onboarded: true } });
      router.replace('/home');
      // The (app) gate reads onboarded_at from a fresh server render; without
      // this the cached RSC payload still says "not onboarded" and bounces back.
      router.refresh();
    } catch (err) {
      setSaving(false);
      if (err instanceof ApiError) setFailure(err.problem.detail);
      else if (err instanceof NetworkError) setFailure(err.message);
      else setFailure('알 수 없는 오류가 생겼어요.');
    }
  }

  function advance(d: Partial<Draft>) {
    const next = { ...draft, ...d };
    setDraft(next);
    if (step === TOTAL - 1) void finish(next);
    else setStep(step + 1);
  }

  return (
    <main className="flex flex-1 flex-col py-[var(--space-19)]">
      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        {TOTAL}단계 중 {step + 1}
      </p>

      {/* key on step so React remounts and the fade replays */}
      <div key={step} className="mt-[var(--space-11)] flex flex-1 flex-col animate-[fade_var(--dur-fade)_var(--ease-fade)]">
        {step === 0 && (
          <Step heading="어떻게 부를까요?">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={20}
              aria-label="닉네임"
              className="h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] bg-surface-1 px-[var(--space-11)]"
              style={{ font: 'var(--type-body)' }}
            />
            <p className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-caption)' }}>
              그룹에서 이 이름으로 보여요
            </p>
          </Step>
        )}

        {step === 1 && (
          <Step heading="조금만 알려주세요">
            <p className="text-secondary" style={{ font: 'var(--type-meta)' }}>
              비슷한 사람들이 좋아한 곳을 찾는 데만 써요
            </p>
            <Group label="성별">
              {GENDERS.map((g) => (
                <ChoicePill key={g.value} selected={draft.gender === g.value} onClick={() => patch({ gender: g.value })}>
                  {g.label}
                </ChoicePill>
              ))}
            </Group>
            <Group label="연령대">
              {AGE_BANDS.map((a) => (
                <ChoicePill key={a.value} selected={draft.age_band === a.value} onClick={() => patch({ age_band: a.value })}>
                  {a.label}
                </ChoicePill>
              ))}
            </Group>
          </Step>
        )}

        {step === 2 && (
          <Step heading="MBTI가 어떻게 되세요?">
            {/* The tiles, the outline-not-fill selection and the note about the
                PNG colour chunks all live in components/mbti-picker.tsx — the
                account screen shows the same art back and edits it, so there is
                one copy. 잘 모르겠어요 means "move on without writing anything"
                here, which is why the picker takes it as its own callback. */}
            <MbtiPicker
              value={draft.mbti ?? null}
              onSelect={(t) => patch({ mbti: t })}
              onUnknown={() => advance({ mbti: undefined })}
            />
          </Step>
        )}

        {step === 3 && (
          <Step heading="주로 어디서 노세요?">
            <div className="flex flex-wrap gap-[var(--space-7)]">
              {AREAS.map((a) => (
                <ChoicePill key={a} selected={draft.home_area === a} onClick={() => patch({ home_area: a })}>
                  {a}
                </ChoicePill>
              ))}
            </div>
          </Step>
        )}

        {step === 4 && (
          <Step heading="인스타그램 아이디 알려주실래요?">
            {/* The copy changed on 2026-09-20 with the thing it describes. It
                used to promise a feature in preparation — 아직 준비 중인 기능
                — because `users.igsid` could only be written by a Meta webhook
                that was never built, so a typed handle really did nothing. It
                now binds the sender on their first share
                (lib/ingest/route-sender.ts), so the honest copy is an
                instruction, not a placeholder. */}
            <p className="text-secondary" style={{ font: 'var(--type-meta)' }}>
              가자 인스타그램으로 릴스를 보내면 이 계정에 모아둘게요. 이 아이디로 보낸
              릴스를 알아볼 수 있게 미리 받아둬요.
            </p>
            <div className="flex h-[var(--field-height)] w-full items-center rounded-[var(--radius-2xl)] bg-surface-1 px-[var(--space-11)]">
              <span className="text-secondary" style={{ font: 'var(--type-body)' }} aria-hidden>
                @
              </span>
              <input
                autoFocus
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                maxLength={31}
                aria-label="인스타그램 아이디"
                aria-invalid={handleMalformed}
                aria-describedby="handle-note"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                autoComplete="off"
                className="ml-[var(--space-4)] h-full min-w-0 flex-1 bg-transparent outline-none"
                style={{ font: 'var(--type-body)' }}
              />
            </div>
            <p id="handle-note" className="text-secondary" style={{ font: 'var(--type-caption)' }}>
              {handleMalformed
                ? '영문 소문자와 숫자, 마침표, 밑줄만 쓸 수 있어요.'
                : '이 아이디로 릴스를 한 번 보내면 연결돼요.'}
            </p>
          </Step>
        )}

        <div className="mt-auto flex flex-col gap-[var(--space-7)] pt-[var(--space-15)]">
          {failure ? (
            <p
              role="alert"
              className="rounded-[var(--radius-2xl)] bg-[var(--status-cancel-bg)] p-[var(--space-9)] text-ink"
              style={{ font: 'var(--type-meta)' }}
            >
              {failure}
            </p>
          ) : null}

          <button
            type="button"
            disabled={(step === 0 && name.trim() === '') || handleMalformed || saving}
            onClick={() => advance(stepAnswer())}
            className="flex h-[var(--field-height)] items-center justify-center rounded-[var(--radius-lg)] bg-ink text-on-ink transition-opacity duration-200 active:opacity-[var(--press-opacity)] disabled:opacity-40"
            style={{ font: 'var(--type-button)' }}
          >
            {saving ? '저장 중' : step === TOTAL - 1 ? '시작하기' : '다음'}
          </button>

          {/* Step 1 is the only required one — there is no skipping your own name. */}
          {step > 0 ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => advance({})}
              className="h-[var(--tap-min)] text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              건너뛰기
            </button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function Step({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <>
      <h1 style={{ font: '500 var(--heading-size)/1.3 var(--font-display-medium), var(--font-fallback-kr)', letterSpacing: 'var(--heading-ls)' }}>
        {heading}
      </h1>
      <div className="mt-[var(--space-15)] flex flex-col gap-[var(--space-11)]">{children}</div>
    </>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-secondary" style={{ font: 'var(--type-caption)' }}>
        {label}
      </p>
      <div className="mt-[var(--space-7)] flex flex-wrap gap-[var(--space-7)]">{children}</div>
    </div>
  );
}
