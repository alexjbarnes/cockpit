/**
 * OTLP over HTTP in its JSON encoding, as Claude Code's exporters send it,
 * flattened into one record per metric point, log record, span and span event.
 * Pure: no I/O, and malformed parts of a payload are counted, never thrown.
 *
 * Kept generic on purpose. Claude Code's telemetry is beta, and its names and
 * attributes change between versions, so nothing here knows what a particular
 * event means: it keeps everything and lets the reader decide.
 */

import type { TelemetrySignal } from "@/types";

export type OtlpKind = "metrics" | "logs" | "traces";

export interface SourceDesc {
  resource: Record<string, unknown>;
  scope: Record<string, unknown>;
}

export interface FlatRecord {
  signal: TelemetrySignal;
  name: string;
  timeMs: number;
  endMs?: number;
  value?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  promptId?: string;
  cliSessionId?: string;
  attrs: Record<string, unknown>;
  detail?: Record<string, unknown>;
  /** Index into the batch's sources. */
  source: number;
}

export interface ParsedBatch {
  sources: SourceDesc[];
  records: FlatRecord[];
  /** Parts of the payload that were not what OTLP says they should be. */
  skipped: number;
}

/** A log body worth using as the record's name: Claude Code puts its event
 *  name there ("claude_code.api_request"). Free text from anything else is
 *  not a name. */
const IDENTIFIER = /^[\w.-]{1,128}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** An int64 as OTLP/JSON may write it (a number or a decimal string): a number
 *  when it fits, the string when it would lose precision. */
function decodeInt(v: unknown): number | string | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || !/^-?\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
}

function decodeDouble(v: unknown): number | string | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/** An OTLP AnyValue as a plain value. An empty AnyValue is null. */
export function decodeAnyValue(v: unknown): unknown {
  if (!isObject(v)) return undefined;
  if ("stringValue" in v) return typeof v.stringValue === "string" ? v.stringValue : String(v.stringValue);
  if ("boolValue" in v) return v.boolValue === true;
  if ("intValue" in v) return decodeInt(v.intValue);
  if ("doubleValue" in v) return decodeDouble(v.doubleValue);
  if ("arrayValue" in v) return list(isObject(v.arrayValue) ? v.arrayValue.values : undefined).map(decodeAnyValue);
  if ("kvlistValue" in v) return decodeAttributes(isObject(v.kvlistValue) ? v.kvlistValue.values : undefined);
  if ("bytesValue" in v) return typeof v.bytesValue === "string" ? v.bytesValue : undefined;
  return null;
}

/** A list of OTLP KeyValues as an object. Entries without a string key are
 *  dropped; a repeated key keeps its last value. */
export function decodeAttributes(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of list(v)) {
    if (!isObject(entry) || typeof entry.key !== "string") continue;
    out[entry.key] = decodeAnyValue(entry.value);
  }
  return out;
}

/** Nanoseconds since the epoch (a decimal string or a number) to whole
 *  milliseconds. Zero, which OTLP uses for "not set", is undefined. */
export function nanosToMs(v: unknown): number | undefined {
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const ms = Number(BigInt(v) / 1_000_000n);
    return ms > 0 ? ms : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v / 1e6);
  return undefined;
}

/** A span's length in ms from its raw ns times, sub-millisecond intact. */
function durationMs(start: unknown, end: unknown): number | undefined {
  const s = nanosBig(start);
  const e = nanosBig(end);
  if (s === undefined || e === undefined || e < s) return undefined;
  return Number(e - s) / 1e6;
}

function nanosBig(v: unknown): bigint | undefined {
  if (typeof v === "string" && /^\d+$/.test(v) && v !== "0") return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  return undefined;
}

/** Keep only the keys that hold something, so a stored detail is not a list
 *  of empty fields. */
function compact(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (typeof v === "number" && v === 0 && /^dropped/.test(k)) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function correlation(attrs: Record<string, unknown>): Pick<FlatRecord, "promptId" | "cliSessionId"> {
  return { promptId: nonEmptyString(attrs["prompt.id"]), cliSessionId: nonEmptyString(attrs["session.id"]) };
}

function scopeOf(v: unknown): Record<string, unknown> {
  if (!isObject(v)) return {};
  return (
    compact({ name: v.name, version: v.version, attributes: isObject(v) && v.attributes ? decodeAttributes(v.attributes) : undefined }) ??
    {}
  );
}

interface Walk {
  batch: ParsedBatch;
  receivedMs: number;
}

export function parseOtlp(kind: OtlpKind, payload: unknown, receivedMs: number): ParsedBatch {
  const batch: ParsedBatch = { sources: [], records: [], skipped: 0 };
  if (!isObject(payload)) {
    batch.skipped++;
    return batch;
  }
  const w: Walk = { batch, receivedMs };
  const top = kind === "metrics" ? "resourceMetrics" : kind === "logs" ? "resourceLogs" : "resourceSpans";
  const scoped = kind === "metrics" ? "scopeMetrics" : kind === "logs" ? "scopeLogs" : "scopeSpans";
  for (const resourceBlock of list(payload[top])) {
    if (!isObject(resourceBlock)) {
      batch.skipped++;
      continue;
    }
    const resource = decodeAttributes(isObject(resourceBlock.resource) ? resourceBlock.resource.attributes : undefined);
    for (const scopeBlock of list(resourceBlock[scoped])) {
      if (!isObject(scopeBlock)) {
        batch.skipped++;
        continue;
      }
      const source = batch.sources.push({ resource, scope: scopeOf(scopeBlock.scope) }) - 1;
      if (kind === "metrics") for (const m of list(scopeBlock.metrics)) readMetric(w, m, source);
      else if (kind === "logs") for (const r of list(scopeBlock.logRecords)) readLog(w, r, source);
      else for (const s of list(scopeBlock.spans)) readSpan(w, s, source);
    }
  }
  // A scope block with nothing in it leaves a source no record points at.
  pruneUnusedSources(batch);
  return batch;
}

const METRIC_TYPES = ["sum", "gauge", "histogram", "exponentialHistogram", "summary"] as const;

function readMetric(w: Walk, m: unknown, source: number): void {
  const name = isObject(m) ? nonEmptyString(m.name) : undefined;
  const type = isObject(m) ? METRIC_TYPES.find((t) => isObject(m[t])) : undefined;
  if (!isObject(m) || !name || !type) {
    w.batch.skipped++;
    return;
  }
  const data = m[type] as Record<string, unknown>;
  for (const p of list(data.dataPoints)) {
    if (!isObject(p)) {
      w.batch.skipped++;
      continue;
    }
    const attrs = decodeAttributes(p.attributes);
    const raw = type === "sum" || type === "gauge" ? (p.asDouble ?? p.asInt) : p.sum;
    const decoded = typeof raw === "number" ? raw : raw === undefined ? undefined : Number(raw);
    const value = typeof decoded === "number" && Number.isFinite(decoded) ? decoded : undefined;
    w.batch.records.push({
      signal: "metric",
      name,
      timeMs: nanosToMs(p.timeUnixNano) ?? w.receivedMs,
      value,
      attrs,
      ...correlation(attrs),
      detail: compact({
        type,
        unit: m.unit,
        description: m.description,
        temporality: data.aggregationTemporality,
        monotonic: data.isMonotonic,
        startMs: nanosToMs(p.startTimeUnixNano),
        count: decodeInt(p.count),
        min: p.min,
        max: p.max,
        bucketCounts: Array.isArray(p.bucketCounts) ? p.bucketCounts.map(decodeInt) : undefined,
        explicitBounds: p.explicitBounds,
        scale: p.scale,
        zeroCount: p.zeroCount,
        positive: p.positive,
        negative: p.negative,
        quantileValues: p.quantileValues,
        flags: p.flags,
        exemplars: p.exemplars,
      }),
      source,
    });
  }
}

function readLog(w: Walk, r: unknown, source: number): void {
  if (!isObject(r)) {
    w.batch.skipped++;
    return;
  }
  const attrs = decodeAttributes(r.attributes);
  const body = decodeAnyValue(r.body);
  const name =
    nonEmptyString(r.eventName) ??
    (typeof body === "string" && IDENTIFIER.test(body) ? body : undefined) ??
    nonEmptyString(attrs["event.name"]) ??
    "log";
  w.batch.records.push({
    signal: "log",
    name,
    timeMs: nanosToMs(r.timeUnixNano) ?? nanosToMs(r.observedTimeUnixNano) ?? w.receivedMs,
    traceId: nonEmptyString(r.traceId),
    spanId: nonEmptyString(r.spanId),
    attrs,
    ...correlation(attrs),
    detail: compact({
      body,
      severityNumber: r.severityNumber,
      severityText: r.severityText,
      flags: r.flags,
      observedMs: nanosToMs(r.observedTimeUnixNano),
      droppedAttributesCount: r.droppedAttributesCount,
    }),
    source,
  });
}

function readSpan(w: Walk, s: unknown, source: number): void {
  const name = isObject(s) ? nonEmptyString(s.name) : undefined;
  if (!isObject(s) || !name) {
    w.batch.skipped++;
    return;
  }
  const attrs = decodeAttributes(s.attributes);
  const timeMs = nanosToMs(s.startTimeUnixNano) ?? w.receivedMs;
  const traceId = nonEmptyString(s.traceId);
  const spanId = nonEmptyString(s.spanId);
  const ids = correlation(attrs);
  const status = isObject(s.status) ? compact({ code: s.status.code, message: s.status.message }) : undefined;
  w.batch.records.push({
    signal: "span",
    name,
    timeMs,
    endMs: nanosToMs(s.endTimeUnixNano),
    value: durationMs(s.startTimeUnixNano, s.endTimeUnixNano),
    traceId,
    spanId,
    parentSpanId: nonEmptyString(s.parentSpanId),
    attrs,
    ...ids,
    detail: compact({
      kind: s.kind,
      status,
      traceState: s.traceState,
      flags: s.flags,
      startNs: s.startTimeUnixNano,
      endNs: s.endTimeUnixNano,
      links: list(s.links)
        .filter(isObject)
        .map((l) => compact({ traceId: l.traceId, spanId: l.spanId, attributes: decodeAttributes(l.attributes) })),
      droppedAttributesCount: s.droppedAttributesCount,
      droppedEventsCount: s.droppedEventsCount,
      droppedLinksCount: s.droppedLinksCount,
    }),
    source,
  });
  // An event on the span (a retry attempt, a tool's output) is a row of its
  // own, joined to the span by its ids, so it can be found without the span.
  for (const e of list(s.events)) {
    const eventName = isObject(e) ? nonEmptyString(e.name) : undefined;
    if (!isObject(e) || !eventName) {
      w.batch.skipped++;
      continue;
    }
    const eventAttrs = decodeAttributes(e.attributes);
    const eventIds = correlation(eventAttrs);
    w.batch.records.push({
      signal: "span_event",
      name: eventName,
      timeMs: nanosToMs(e.timeUnixNano) ?? timeMs,
      traceId,
      spanId,
      attrs: eventAttrs,
      promptId: eventIds.promptId ?? ids.promptId,
      cliSessionId: eventIds.cliSessionId ?? ids.cliSessionId,
      detail: compact({ timeNs: e.timeUnixNano, droppedAttributesCount: e.droppedAttributesCount }),
      source,
    });
  }
}

function pruneUnusedSources(batch: ParsedBatch): void {
  const used = new Set(batch.records.map((r) => r.source));
  if (used.size === batch.sources.length) return;
  const remap = new Map<number, number>();
  const kept: SourceDesc[] = [];
  batch.sources.forEach((s, i) => {
    if (!used.has(i)) return;
    remap.set(i, kept.length);
    kept.push(s);
  });
  batch.sources = kept;
  for (const r of batch.records) r.source = remap.get(r.source) as number;
}
