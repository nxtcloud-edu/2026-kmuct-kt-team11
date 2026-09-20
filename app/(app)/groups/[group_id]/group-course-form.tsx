'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Button, Card, Chip } from '@/components/surface';
import { ApiError, apiFetch, newIdempotencyKey } from '@/lib/api/client';
import type { GroupCourseRun } from '@/features/group-date-course/types';

export type GroupMemberOption = {
  user_id: string;
  display_name: string;
  mbti: string | null;
  profile_visible_in_groups: boolean;
};

function defaultDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
const fieldClass =
  'mt-2 h-[var(--field-height)] w-full rounded-[var(--radius-2xl)] bg-surface-1 px-4';

export function GroupCourseForm({
  groupId,
  members,
}: {
  groupId: string;
  members: GroupMemberOption[];
}) {
  const [selected, setSelected] = useState(() => members.slice(0, 8).map((member) => member.user_id));
  const [date, setDate] = useState(defaultDate);
  const [timeRange, setTimeRange] = useState('14:00-19:00');
  const [region, setRegion] = useState('');
  const [startStation, setStartStation] = useState('');
  const [budget, setBudget] = useState('50000');
  const [vegetarian, setVegetarian] = useState(false);
  const [noSpicy, setNoSpicy] = useState(false);
  const [limitedWalking, setLimitedWalking] = useState(false);
  const [allowTaxi, setAllowTaxi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GroupCourseRun | null>(null);

  const canSubmit = selected.length > 0 && date !== '' && timeRange !== '' && (region.trim() !== '' || startStation.trim() !== '');
  const coverageByPlace = useMemo(
    () => new Map(result?.group_match.stopAttributions.map((item) => [item.placeId, item]) ?? []),
    [result],
  );

  function toggleMember(userId: string) {
    setError('');
    setSelected((current) => {
      if (current.includes(userId)) return current.filter((id) => id !== userId);
      if (current.length >= 8) {
        setError('한 코스에는 최대 8명까지 참여할 수 있어요.');
        return current;
      }
      return [...current, userId];
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const created = await apiFetch<GroupCourseRun>(`/groups/${groupId}/itineraries`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: {
          member_ids: selected,
          date,
          time_range: timeRange,
          region: region.trim() || undefined,
          start_station: startStation.trim() || undefined,
          budget_per_person: budget === '' ? undefined : Number(budget),
          hard_constraints: {
            vegetarian,
            no_spicy: noSpicy,
            limited_walking: limitedWalking,
            allow_taxi: allowTaxi,
          },
        },
      });
      setResult(created);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '서버에 연결하지 못했어요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
        그룹 코스 만들기
      </h3>
      <form onSubmit={submit} className="mt-4" noValidate>
        <fieldset>
          <legend className="text-secondary" style={{ font: 'var(--type-meta)' }}>
            참여 멤버
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {members.map((member) => {
              const checked = selected.includes(member.user_id);
              return (
                <label
                  key={member.user_id}
                  className={`flex min-h-[var(--tap-min)] items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 ${checked ? 'bg-ink text-on-ink' : 'bg-surface-1 text-ink'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleMember(member.user_id)}
                    className="h-4 w-4 shrink-0 accent-[var(--success)]"
                  />
                  <span className="min-w-0 truncate">{member.display_name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <label className="block text-secondary" style={{ font: 'var(--type-meta)' }}>
            날짜
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className={fieldClass}
              style={{ font: 'var(--type-body)' }}
              required
            />
          </label>
          <label className="block text-secondary" style={{ font: 'var(--type-meta)' }}>
            시간
            <input
              value={timeRange}
              onChange={(event) => setTimeRange(event.target.value)}
              placeholder="14:00-19:00"
              className={fieldClass}
              style={{ font: 'var(--type-body)' }}
              required
            />
          </label>
        </div>

        <label className="mt-4 block text-secondary" style={{ font: 'var(--type-meta)' }}>
          지역
          <input
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            placeholder="예: 성수"
            className={fieldClass}
            style={{ font: 'var(--type-body)' }}
          />
        </label>
        <label className="mt-4 block text-secondary" style={{ font: 'var(--type-meta)' }}>
          출발역
          <input
            value={startStation}
            onChange={(event) => setStartStation(event.target.value)}
            placeholder="예: 성수역"
            className={fieldClass}
            style={{ font: 'var(--type-body)' }}
          />
        </label>
        <label className="mt-4 block text-secondary" style={{ font: 'var(--type-meta)' }}>
          1인 예산
          <input
            type="number"
            min="0"
            step="1000"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            className={fieldClass}
            style={{ font: 'var(--type-body)' }}
          />
        </label>

        <fieldset className="mt-5">
          <legend className="text-secondary" style={{ font: 'var(--type-meta)' }}>
            꼭 지킬 조건
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              ['채식 메뉴', vegetarian, setVegetarian],
              ['맵지 않게', noSpicy, setNoSpicy],
              ['걷기 적게', limitedWalking, setLimitedWalking],
              ['택시 허용', allowTaxi, setAllowTaxi],
            ].map(([label, checked, setter]) => (
              <label key={String(label)} className="flex min-h-[var(--tap-min)] items-center gap-2 rounded-[var(--radius-lg)] bg-surface-1 px-3">
                <input
                  type="checkbox"
                  checked={checked as boolean}
                  onChange={(event) => (setter as (value: boolean) => void)(event.target.checked)}
                  className="h-4 w-4 accent-[var(--success)]"
                />
                <span>{String(label)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <p role="status" aria-live="polite" className="mt-3 min-h-[var(--caption-lh)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          {error}
        </p>
        <Button type="submit" variant="primary" className="mt-2 w-full" disabled={!canSubmit || busy}>
          {busy ? '취향을 맞추는 중…' : '그룹 코스 생성'}
        </Button>
      </form>

      {result ? (
        <section className="mt-[var(--section-gap-wide)]" aria-live="polite">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 style={{ font: 'var(--type-section)', letterSpacing: 'var(--section-ls)' }}>
                {result.course.courseTitle}
              </h3>
              <p className="mt-1 text-secondary">{result.course.courseSummary}</p>
            </div>
            <Chip>{Math.round(result.group_match.fairnessScore * 100)}% 균형</Chip>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Chip>{result.course.totalDurationMin}분</Chip>
            <Chip>
              {result.course.estimatedBudgetPerPerson === null
                ? '예산 확인 필요'
                : `1인 ${result.course.estimatedBudgetPerPerson.toLocaleString()}원`}
            </Chip>
            <Chip>{result.representative_mbti} 구성</Chip>
          </div>

          <ol className="mt-5 flex list-none flex-col gap-3 p-0">
            {result.course.stops.map((stop) => {
              const attribution = coverageByPlace.get(stop.placeId);
              return (
                <Card as="li" key={stop.placeId} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-circle)] bg-ink text-on-ink">
                      {stop.order}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium [overflow-wrap:anywhere]">{stop.name}</p>
                      <p className="mt-1 text-secondary" style={{ font: 'var(--type-caption)' }}>
                        {stop.startTime}–{stop.endTime}
                        {stop.estimatedCostPerPerson === null
                          ? ''
                          : ` · ${stop.estimatedCostPerPerson.toLocaleString()}원`}
                      </p>
                      <p className="mt-2 text-secondary">{stop.why.tasteEvidence.join(' · ')}</p>
                      {attribution?.memberNames.length ? (
                        <p className="mt-2" style={{ font: 'var(--type-caption)' }}>
                          {attribution.memberNames.join(', ')}님의 취향과 잘 맞아요.
                        </p>
                      ) : null}
                    </div>
                  </div>
                </Card>
              );
            })}
          </ol>

          {result.group_match.memberCoverage.length ? (
            <div className="mt-5">
              <p className="text-secondary" style={{ font: 'var(--type-meta)' }}>멤버별 반영</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {result.group_match.memberCoverage.map((member) => (
                  <Chip key={member.userId} tone={member.covered ? 'neutral' : 'danger'}>
                    {member.displayName} {Math.round(member.bestScore * 100)}%
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
