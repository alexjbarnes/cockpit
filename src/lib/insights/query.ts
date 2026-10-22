/**
 * The Insights API's query string, checked. Like the telemetry read API, a
 * value that is present but wrong is an error rather than ignored.
 *
 * The range ends at the end of the bucket holding `now` and starts a whole
 * number of buckets before, on the viewer's clock: hours for a day, local
 * days for a week or a month.
 */

import type { InsightsQuery, InsightsRangeKey, InsightsView } from "@/types";

export const INSIGHTS_VIEWS: readonly InsightsView[] = [
  "overview",
  "spend",
  "speed",
  "tools",
  "health",
  "activity",
  "turns",
  "turn",
  "context",
];
export const INSIGHTS_RANGES: readonly InsightsRangeKey[] = ["24h", "7d", "30d"];

/** Views that only make sense for one session. */
export const SESSION_VIEWS: readonly InsightsView[] = ["turns", "turn", "context"];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RANGES: Record<InsightsRangeKey, { bucketMs: number; buckets: number }> = {
  "24h": { bucketMs: HOUR, buckets: 24 },
  "7d": { bucketMs: DAY, buckets: 7 },
  "30d": { bucketMs: DAY, buckets: 30 },
};
/** UTC-12 to UTC+14, the clocks in use. */
const MAX_OFFSET_MIN = 14 * 60;

/** Start of the bucket holding `t`, on a clock `tzOffsetMin` ahead of UTC. */
export function bucketStart(t: number, bucketMs: number, tzOffsetMin: number): number {
  const offset = tzOffsetMin * 60_000;
  return Math.floor((t + offset) / bucketMs) * bucketMs - offset;
}

export function rangeBounds(
  range: InsightsRangeKey,
  now: number,
  tzOffsetMin: number,
): Pick<InsightsQuery, "since" | "until" | "bucketMs"> {
  const { bucketMs, buckets } = RANGES[range];
  const until = bucketStart(now, bucketMs, tzOffsetMin) + bucketMs;
  return { since: until - buckets * bucketMs, until, bucketMs };
}

export function parseInsightsQuery(params: URLSearchParams, now: number): { query: InsightsQuery } | { error: string } {
  const view = params.get("view");
  if (!view || !INSIGHTS_VIEWS.includes(view as InsightsView)) return { error: `view must be one of ${INSIGHTS_VIEWS.join(", ")}` };
  const range = params.get("range") || "7d";
  if (!INSIGHTS_RANGES.includes(range as InsightsRangeKey)) return { error: `range must be one of ${INSIGHTS_RANGES.join(", ")}` };
  const tzRaw = params.get("tz") || "0";
  if (!/^-?\d{1,4}$/.test(tzRaw) || Math.abs(Number(tzRaw)) > MAX_OFFSET_MIN) {
    return { error: "tz must be the viewer's offset from UTC in minutes" };
  }
  const tzOffsetMin = Number(tzRaw);
  const session = params.get("session") || undefined;
  if (session !== undefined && !/^[\w-]{1,128}$/.test(session)) return { error: "session must be a session id" };
  if (SESSION_VIEWS.includes(view as InsightsView) && !session) return { error: `the ${view} view needs a session` };
  const turn = params.get("turn") || undefined;
  if (turn !== undefined && !/^[0-9a-f]{32}$/.test(turn)) return { error: "turn must be a trace id" };
  if (view === "turn" && !turn) return { error: "the turn view needs a turn" };
  return {
    query: {
      view: view as InsightsView,
      range: range as InsightsRangeKey,
      ...rangeBounds(range as InsightsRangeKey, now, tzOffsetMin),
      tzOffsetMin,
      ...(session ? { session } : {}),
      ...(turn ? { turn } : {}),
    },
  };
}
