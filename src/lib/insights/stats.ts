/**
 * The arithmetic behind Insights: percentiles, histogram bins, bucket filling
 * and the union of time intervals. Pure, so the worker and the server share it.
 */

/** The p-th percentile (0..1) of values, interpolated between the two nearest
 *  ranks. Null for no values. Sorts a copy. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function durations(values: readonly number[]): { count: number; p50: number | null; p90: number | null } {
  return { count: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

/** Upper edges of the turn-duration histogram; the last bin is open. */
export const TURN_DURATION_EDGES = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

export function histogram(
  values: readonly number[],
  edges: readonly number[],
): Array<{ fromMs: number; toMs: number | null; count: number }> {
  const bins = edges.map((toMs, i) => ({ fromMs: i === 0 ? 0 : edges[i - 1], toMs: toMs as number | null, count: 0 }));
  bins.push({ fromMs: edges[edges.length - 1] ?? 0, toMs: null, count: 0 });
  for (const v of values) {
    const i = edges.findIndex((edge) => v < edge);
    bins[i < 0 ? bins.length - 1 : i].count++;
  }
  return bins;
}

export function bucketStarts(since: number, until: number, bucketMs: number): number[] {
  const out: number[] = [];
  for (let t = since; t < until; t += bucketMs) out.push(t);
  return out;
}

/** The index of the bucket holding `t`, or -1 outside the range. */
export function bucketIndex(t: number, since: number, until: number, bucketMs: number): number {
  if (t < since || t >= until) return -1;
  return Math.floor((t - since) / bucketMs);
}

export type Interval = readonly [number, number];

/** Merge overlapping intervals, dropping empty ones. */
export function mergeIntervals(intervals: readonly Interval[]): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function unionLength(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, [a, b]) => sum + (b - a), 0);
}

/**
 * Where a turn's time went. Each category's time is what it covers that a
 * category before it does not, so a tool waiting on the user counts as
 * waiting and not also as running, and parallel tool calls count once. What
 * no category covers is `other`: the CLI between requests, hooks, rendering.
 */
export function turnBreakdown(
  start: number,
  end: number,
  categories: { waiting: readonly Interval[]; tools: readonly Interval[]; model: readonly Interval[] },
): { waitingMs: number; toolsMs: number; modelMs: number; otherMs: number } {
  const clip = (list: readonly Interval[]): Interval[] => list.map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as const);
  const waiting = clip(categories.waiting);
  const tools = clip(categories.tools);
  const model = clip(categories.model);
  const w = unionLength(waiting);
  const wt = unionLength([...waiting, ...tools]);
  const all = unionLength([...waiting, ...tools, ...model]);
  return { waitingMs: w, toolsMs: wt - w, modelMs: all - wt, otherMs: Math.max(0, end - start - all) };
}
