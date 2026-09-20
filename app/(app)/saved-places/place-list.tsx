'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import { Chip } from '@/components/surface';
import { Icon, type IconName } from '@/components/icons';
import { categoryLabel } from '@/lib/categories';
import { reelThumb } from '@/lib/reel-thumb';
import type { SavedPlace } from '@/lib/api/types';
import type { PlaceGroup } from './model';

/**
 * The list half of the screen.
 *
 * LAW OF UNIFORM CONNECTEDNESS is the whole design of this file: a pin and its
 * row have to read as one object, so the row carries the same mark the map does
 * — the same ink puck, the same category glyph, growing the same way when it is
 * selected — and selecting either one marks the other. The row is where the
 * detail opens too, rather than in a separate panel above the list, because a
 * panel would be a second drawing of a thing that is already on screen and the
 * user would have to work out that the two are the same place.
 *
 * SERIAL POSITION decides what is at the top of a row. The screen this replaced
 * led with a save date; the name and its mark lead here, and the date has moved
 * into the detail, which is the only place anyone goes looking for it.
 */

export function PlaceList({
  groups,
  selectedId,
  onSelect,
}: {
  groups: PlaceGroup[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selectedRef = useRef<HTMLLIElement | null>(null);

  // A pin tapped on the map has to bring its row into view, or the sheet expands
  // onto a list that is scrolled somewhere else entirely.
  useEffect(() => {
    if (!selectedId) return;
    selectedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <div className="flex flex-col gap-[var(--space-15)]">
      {groups.map((group) => (
        <section key={group.key}>
          {/* Sticky, and opaque `--canvas` rather than translucent: the rows
              scrolling underneath would otherwise show through the 구 name. */}
          <h2
            className="sticky top-0 z-10 bg-canvas py-[var(--space-5)] text-secondary"
            style={{ font: 'var(--type-meta)' }}
          >
            {group.label}
            <span className="tabular-nums"> · {group.rows.length}곳</span>
          </h2>

          <ul className="flex list-none flex-col gap-[var(--space-4)] p-0">
            {group.rows.map((row) => {
              const selected = row.id === selectedId;
              return (
                <li key={row.id} ref={selected ? selectedRef : undefined}>
                  <div
                    className="rounded-[var(--radius-2xl)]"
                    // The selected row is a surface step, not a border and not a
                    // shadow: the record groups by tint, and the depth budget is
                    // already spent on the sheet this list sits inside.
                    style={selected ? { background: 'var(--surface-2)' } : undefined}
                  >
                    <button
                      type="button"
                      aria-expanded={selected}
                      onClick={() => onSelect(selected ? null : row.id)}
                      className="flex w-full items-center gap-[var(--space-9)] p-[var(--space-8)]
                                 text-left transition-opacity duration-200
                                 active:opacity-[var(--press-opacity-strong)]"
                    >
                      <RowMark category={row.place?.category} selected={selected} />

                      <span className="min-w-0 flex-1">
                        <span
                          className="block [overflow-wrap:anywhere]"
                          style={{ font: 'var(--type-card-title)' }}
                        >
                          {row.place?.name ?? '장소를 확인하는 중이에요'}
                        </span>
                        {row.place ? (
                          <span
                            className="mt-[var(--space-1)] block text-secondary"
                            style={{ font: 'var(--type-caption)' }}
                          >
                            {row.place.area} · {categoryLabel(row.place.category)}
                          </span>
                        ) : null}
                      </span>

                      {row.status === 'needs_review' ? <Chip tone="danger">확인 필요</Chip> : null}
                    </button>

                    {selected ? <Detail row={row} /> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The row's half of the pin. Same puck, same glyph, same size step on selection
 * as `Pin` in `places-map.tsx` — deliberately, because two marks that differ are
 * two objects. They are separate components rather than one shared one because
 * the map's version needs a 44px hit box around it and this one is inside a
 * button that is already 44px tall; sharing would mean a prop that only ever
 * means "which screen am I on".
 */
function RowMark({ category, selected }: { category?: string; selected: boolean }) {
  const size = selected ? 36 : 30;
  if (!category) {
    // No category means no place yet, and therefore no pin on the map for this
    // row to match. An empty tinted disc says that without inventing a glyph.
    return (
      <span
        className="shrink-0 rounded-[var(--radius-pill)] bg-surface-2"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-ink text-on-ink"
      style={{ width: size, height: size }}
    >
      <Icon name={category as IconName} size={selected ? 18 : 16} />
    </span>
  );
}

/**
 * What a selected row opens into. Everything here is either too long for a row
 * or only wanted once — which is the test for what belongs in a detail rather
 * than in a list.
 */
function Detail({ row }: { row: SavedPlace }) {
  return (
    <div className="flex gap-[var(--space-9)] px-[var(--space-8)] pb-[var(--space-8)]">
      {/* The reel's real cover frame when we captured one, the stock still
          otherwise — see lib/reel-thumb.ts. Portrait, because a reel is
          portrait and a landscape crop would misrepresent the frame the
          creator chose. */}
      <div className="relative h-[92px] w-[74px] shrink-0 overflow-hidden rounded-[var(--radius-md)] bg-surface-1">
        <Image
          src={row.thumb_url ?? reelThumb(row.id)}
          alt=""
          fill
          sizes="74px"
          className="object-cover"
        />
      </div>

      <div className="min-w-0 flex-1">
        {row.place?.address ? (
          <p className="[overflow-wrap:anywhere]" style={{ font: 'var(--type-caption)' }}>
            {row.place.address}
          </p>
        ) : null}

        {row.hook ? (
          <p
            className="mt-[var(--space-4)] text-secondary [overflow-wrap:anywhere]"
            style={{ font: 'var(--type-caption)' }}
          >
            {row.hook}
          </p>
        ) : null}

        <p className="mt-[var(--space-4)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          <time dateTime={row.saved_at} className="tabular-nums">
            {new Date(row.saved_at).toLocaleDateString('ko-KR', {
              year: 'numeric',
              month: 'numeric',
              day: 'numeric',
            })}
          </time>
          {' 저장'}
        </p>

        {row.source_url ? (
          // `noreferrer` as well as `noopener`: the destination is Instagram and
          // it has no business being told which of our screens sent the reader.
          <a
            href={row.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-[var(--space-7)] inline-flex h-[var(--tap-min)] items-center text-secondary"
            style={{ font: 'var(--type-meta)' }}
          >
            릴스 보기 ›
          </a>
        ) : null}
      </div>
    </div>
  );
}
