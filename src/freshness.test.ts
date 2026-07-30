import { expect, it } from 'vitest';
import { freshnessOf, freshnessScale } from './freshness';

// Jan 1 → Apr 1 2024, a 91-day span: thirds land at ~Jan 31 and ~Mar 1.
const dates = ['2024-01-01T00:00:00Z', '2024-02-15T00:00:00Z', '2024-04-01T00:00:00Z'];

it('sorts songs into stale / stable / unripe thirds of the library span', () => {
  const scale = freshnessScale(dates);
  expect(freshnessOf('2024-01-01T00:00:00Z', scale)).toBe('stale');
  expect(freshnessOf('2024-02-15T00:00:00Z', scale)).toBe('stable');
  expect(freshnessOf('2024-04-01T00:00:00Z', scale)).toBe('unripe');
});

it('puts a boundary date in the later bucket, never in both', () => {
  const scale = freshnessScale(dates)!;
  const firstBoundary = new Date(scale.oldest + scale.interval).toISOString();
  const secondBoundary = new Date(scale.oldest + 2 * scale.interval).toISOString();
  expect(freshnessOf(firstBoundary, scale)).toBe('stable');
  expect(freshnessOf(secondBoundary, scale)).toBe('unripe');
});

// The degenerate case the formula hides: interval is 0, so every comparison
// against `oldest + n * interval` is false and a naive implementation either
// divides by zero or falls through all three buckets.
it('lands in one bucket when every song was added at the same instant', () => {
  const scale = freshnessScale(['2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z']);
  expect(scale!.interval).toBe(0);
  expect(freshnessOf('2024-01-01T00:00:00Z', scale)).toBe('stable');
});

it('returns the neutral bucket for an empty library or an unparseable date', () => {
  expect(freshnessScale([])).toBeNull();
  expect(freshnessOf('2024-01-01T00:00:00Z', null)).toBe('stable');
  expect(freshnessOf('not a date', freshnessScale(dates))).toBe('stable');
});
