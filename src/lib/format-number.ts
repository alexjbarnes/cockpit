/**
 * Numbers as Insights shows them: token counts, dollars, shares and short
 * durations. Compact enough to sit in a tile or beside a bar on a phone.
 */

import { formatDuration } from "./format-time";

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}

/** "950" / "12.6k" / "126k" / "1.2M" / "3.4B". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1e6) return `${trim(n / 1e3, abs < 1e4 ? 1 : 0)}k`;
  if (abs < 1e9) return `${trim(n / 1e6, abs < 1e7 ? 1 : 0)}M`;
  return `${trim(n / 1e9, 1)}B`;
}

/** "$0" / "<$0.01" / "$4.28" / "$123" / "$12k". */
export function formatUSD(n: number): string {
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}<$0.01`;
  if (abs < 100) return `${sign}$${abs.toFixed(2)}`;
  if (abs < 10_000) return `${sign}$${Math.round(abs)}`;
  return `${sign}$${trim(abs / 1e3, 0)}k`;
}

/** A 0..1 share as "68%", with "<1%" for a share too small to round up. */
export function formatPercent(ratio: number): string {
  if (ratio > 0 && ratio < 0.005) return "<1%";
  return `${Math.round(ratio * 100)}%`;
}

/** "7" / "1,234" / "12.3k". */
export function formatCount(n: number): string {
  if (Math.abs(n) < 10_000) return Math.round(n).toLocaleString("en-GB");
  return formatTokens(n);
}

/** "850 ms" / "12.3 s" / "2m 5s": milliseconds stay visible below a second,
 *  where a latency lives. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trim(ms / 1000, ms < 10_000 ? 1 : 0)} s`;
  return formatDuration(ms);
}

/** "1 turn" / "3 turns": a count with its noun. */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(n)} ${n === 1 ? singular : plural}`;
}
