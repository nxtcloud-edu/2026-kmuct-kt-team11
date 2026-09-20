'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { MBTI_TYPES, mbtiImage, type MbtiType } from '@/lib/mbti';

/**
 * Onboarding, four steps.
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
 * Motion is opacity only. The system's budget has no transforms, so steps
 * cross-fade rather than slide.
 */

type Gender = 'female' | 'male' | 'undisclosed';
type AgeBand = '10s' | '20s' | '30s' | '40s' | '50plus';

type Draft = {
  display_name?: string;
  gender?: Gender;
  age_band?: AgeBand;
  mbti?: MbtiType;
  home_area?: string;
};

const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: '여성' },
  { value: 'male', label: '남성' },
  { value: 'undisclosed', label: '선택 안 함' },
];

const AGE_BANDS: { value: AgeBand; label: string }[] = [
  { value: '10s', label: '10대' },
  { value: '20s', label: '20대' },
  { value: '30s', label: '30대' },
  { value: '40s', label: '40대' },
  { value: '50plus', label: '50대+' },
];

const AREAS = ['성수', '연남', '한남', '강남', '을지로', '홍대', '압구정', '여의도', '잠실', '기타'];

const TOTAL = 4;

export function OnboardingSteps({ initialName }: { initialName: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const patch = (d: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...d }));

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
                <Pill key={g.value} selected={draft.gender === g.value} onClick={() => patch({ gender: g.value })}>
                  {g.label}
                </Pill>
              ))}
            </Group>
            <Group label="연령대">
              {AGE_BANDS.map((a) => (
                <Pill key={a.value} selected={draft.age_band === a.value} onClick={() => patch({ age_band: a.value })}>
                  {a.label}
                </Pill>
              ))}
            </Group>
          </Step>
        )}

        {step === 2 && (
          <Step heading="MBTI가 어떻게 되세요?">
            <div className="grid grid-cols-4 gap-[var(--space-8)]">
              {MBTI_TYPES.map((t) => {
                const selected = draft.mbti === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => patch({ mbti: t })}
                    aria-pressed={selected}
                    className={`flex flex-col items-center gap-[var(--space-4)] rounded-[var(--radius-md)] p-[var(--space-4)] transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
                      selected ? 'bg-ink' : 'bg-surface-2'
                    }`}
                  >
                    <Image
                      src={mbtiImage(t)}
                      alt=""
                      width={64}
                      height={64}
                      className="h-auto w-full rounded-[var(--radius-xs)]"
                    />
                    <span
                      className={selected ? 'text-on-ink' : 'text-secondary'}
                      style={{ font: 'var(--type-tag)', letterSpacing: 'var(--tag-ls)' }}
                    >
                      {t}
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => advance({ mbti: undefined })}
              className="mt-[var(--space-11)] h-[var(--tap-min)] w-full rounded-[var(--radius-lg)] bg-surface-1 text-secondary"
              style={{ font: 'var(--type-meta)' }}
            >
              잘 모르겠어요
            </button>
          </Step>
        )}

        {step === 3 && (
          <Step heading="주로 어디서 노세요?">
            <div className="flex flex-wrap gap-[var(--space-7)]">
              {AREAS.map((a) => (
                <Pill key={a} selected={draft.home_area === a} onClick={() => patch({ home_area: a })}>
                  {a}
                </Pill>
              ))}
            </div>
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
            disabled={(step === 0 && name.trim() === '') || saving}
            onClick={() => advance(step === 0 ? { display_name: name.trim() } : {})}
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

function Pill({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`flex h-[var(--tap-min)] items-center rounded-[var(--radius-pill)] px-[var(--space-11)] transition-opacity duration-200 active:opacity-[var(--press-opacity)] ${
        selected ? 'bg-ink text-on-ink' : 'bg-surface-2 text-secondary'
      }`}
      style={{ font: 'var(--type-meta)' }}
    >
      {children}
    </button>
  );
}
