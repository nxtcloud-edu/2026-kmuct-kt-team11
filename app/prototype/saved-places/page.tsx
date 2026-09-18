import { Suspense } from 'react';
import '../tokens.css';
import { Prototype } from './client';

export const metadata = { title: 'Gaja — saved places (prototype)' };

/**
 * PROTOTYPE — throwaway. Sub-shape B per prototype/UI.md.
 *
 * Uncertainty: does luma's "agenda, not catalog" survive saved places?
 * luma's agenda groups by a date that MEANS something — the event happens then.
 * A saved place's date is when you happened to save it, which tells you nothing
 * about planning. Three variants disagree about the organising fact:
 *   A  save date   (luma faithful)
 *   B  area        (the axis you plan along)
 *   C  none        (null hypothesis — grouping does not earn its keep)
 *
 * ?variant=A|B|C   ?state=loading|empty|error
 */
export default function Page() {
  return (
    <div className="proto">
      <Suspense fallback={null}>
        <Prototype />
      </Suspense>
    </div>
  );
}
