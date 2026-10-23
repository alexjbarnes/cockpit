/**
 * The telemetry read API's query string, checked. A value that is present but
 * wrong is an error rather than ignored, so a typo in a filter cannot quietly
 * return everything.
 */

import type { TelemetryQuery, TelemetrySignal } from "@/types";

const SIGNALS: readonly TelemetrySignal[] = ["metric", "log", "span", "span_event"];
export const MAX_TELEMETRY_PAGE = 1000;

function wholeNumber(raw: string): number | undefined {
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
}

export function parseTelemetryQuery(params: URLSearchParams): { query: TelemetryQuery } | { error: string } {
  const query: TelemetryQuery = {};
  for (const key of ["session", "cliSession", "name"] as const) {
    const v = params.get(key);
    if (v) query[key] = v;
  }
  const signal = params.get("signal");
  if (signal) {
    if (!SIGNALS.includes(signal as TelemetrySignal)) return { error: `signal must be one of ${SIGNALS.join(", ")}` };
    query.signal = signal as TelemetrySignal;
  }
  for (const key of ["since", "until", "after", "limit"] as const) {
    const raw = params.get(key);
    if (raw === null || raw === "") continue;
    const n = wholeNumber(raw);
    if (n === undefined) return { error: `${key} must be a whole number` };
    query[key] = n;
  }
  if (query.limit !== undefined && (query.limit < 1 || query.limit > MAX_TELEMETRY_PAGE)) {
    return { error: `limit must be between 1 and ${MAX_TELEMETRY_PAGE}` };
  }
  const order = params.get("order");
  if (order) {
    if (order !== "time" && order !== "ingest") return { error: "order must be time or ingest" };
    query.order = order;
  }
  const cursor = params.get("cursor");
  if (cursor) {
    if (!/^\d+:\d+$/.test(cursor)) return { error: "cursor must be a nextCursor from an earlier page" };
    query.cursor = cursor;
  }
  const content = params.get("content");
  if (content) {
    if (content !== "refs" && content !== "inline") return { error: "content must be refs or inline" };
    query.content = content;
  }
  return { query };
}
