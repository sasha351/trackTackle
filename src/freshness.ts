/** How long a song has been sitting in Liked, as thirds of the library's own
 *  added-at span — so the ranking means the same thing whatever the library
 *  looks like. Banana colours in the UI; the labels below are what actually
 *  carries the meaning, since colour alone is not a signal. */
export type Freshness = 'unripe' | 'stable' | 'stale';

export interface FreshnessScale {
  /** ms since epoch of the oldest added-at in the library */
  oldest: number;
  /** (newest - oldest) / 3. Zero when every song was added at one instant. */
  interval: number;
}

export const FRESHNESS_LABEL: Record<Freshness, string> = {
  unripe: 'Recently liked',
  stable: 'Settled in',
  stale: 'Been in Liked the longest',
};

export function freshnessScale(addedAts: string[]): FreshnessScale | null {
  let oldest = Infinity;
  let newest = -Infinity;
  for (const s of addedAts) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) continue;
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  if (!Number.isFinite(oldest)) return null;
  return { oldest, interval: (newest - oldest) / 3 };
}

export function freshnessOf(addedAt: string, scale: FreshnessScale | null): Freshness {
  const t = Date.parse(addedAt);
  // No library, no spread to divide, or a date we can't read: there is no
  // ranking to make. Everything reads as the neutral middle bucket rather than
  // falling through all three comparisons into an arbitrary one.
  if (!scale || scale.interval === 0 || Number.isNaN(t)) return 'stable';
  if (t < scale.oldest + scale.interval) return 'stale';
  if (t < scale.oldest + 2 * scale.interval) return 'stable';
  return 'unripe';
}
