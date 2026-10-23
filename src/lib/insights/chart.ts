/**
 * Axis arithmetic for Insights' charts, kept apart from the components so it
 * can be tested without a browser.
 */

/** Indexes worth a tick label when `count` buckets share `width` pixels,
 *  at least `minGap` pixels apart. */
export function tickIndexes(count: number, width: number, minGap = 52): number[] {
  if (count === 0 || width <= 0) return [];
  const step = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / minGap))));
  const out: number[] = [];
  for (let i = 0; i < count; i += step) out.push(i);
  return out;
}

/** A round number at or above `max`, for an axis top: 1, 2, 2.5 or 5 times a
 *  power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5]) if (m * power >= max) return m * power;
  return 10 * power;
}

/** The index of the slot under `x` when `count` slots share `width`, clamped. */
export function slotAt(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** The index of the value in sorted `xs` nearest to `x`. */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x) ? lo - 1 : lo;
}
