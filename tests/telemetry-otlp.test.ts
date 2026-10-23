// OTLP/JSON as Claude Code sends it, flattened into stored records. Fixtures
// follow the shapes captured from CLI 2.1.296, with made-up ids.
import { describe, expect, it } from "vitest";
import { decodeAnyValue, decodeAttributes, nanosToMs, parseOtlp } from "@/server/telemetry/otlp";

const RECEIVED = 1_700_000_000_000;
const resource = {
  attributes: [
    { key: "cockpit.session_id", value: { stringValue: "sess-1" } },
    { key: "service.name", value: { stringValue: "claude-code" } },
  ],
};
const kv = (key: string, value: Record<string, unknown>) => ({ key, value });

describe("decodeAnyValue", () => {
  it("turns every OTLP value kind into a plain value", () => {
    expect(decodeAnyValue({ stringValue: "x" })).toBe("x");
    expect(decodeAnyValue({ boolValue: true })).toBe(true);
    expect(decodeAnyValue({ boolValue: "yes" })).toBe(false);
    expect(decodeAnyValue({ intValue: 42 })).toBe(42);
    expect(decodeAnyValue({ intValue: "42" })).toBe(42);
    // Past what a double holds exactly: kept as the string it arrived as.
    expect(decodeAnyValue({ intValue: "9223372036854775807" })).toBe("9223372036854775807");
    expect(decodeAnyValue({ intValue: "4.5" })).toBeUndefined();
    expect(decodeAnyValue({ intValue: Number.NaN })).toBeUndefined();
    expect(decodeAnyValue({ doubleValue: 0.25 })).toBe(0.25);
    expect(decodeAnyValue({ doubleValue: "1.5" })).toBe(1.5);
    expect(decodeAnyValue({ doubleValue: "NaN" })).toBe("NaN");
    expect(decodeAnyValue({ doubleValue: true })).toBeUndefined();
    expect(decodeAnyValue({ arrayValue: { values: [{ stringValue: "a" }, { intValue: 1 }] } })).toEqual(["a", 1]);
    expect(decodeAnyValue({ arrayValue: {} })).toEqual([]);
    expect(decodeAnyValue({ kvlistValue: { values: [kv("k", { stringValue: "v" })] } })).toEqual({ k: "v" });
    expect(decodeAnyValue({ kvlistValue: null })).toEqual({});
    expect(decodeAnyValue({ bytesValue: "AAEC" })).toBe("AAEC");
    expect(decodeAnyValue({ bytesValue: 5 })).toBeUndefined();
    expect(decodeAnyValue({ stringValue: 7 })).toBe("7");
    expect(decodeAnyValue({})).toBeNull();
    expect(decodeAnyValue("raw")).toBeUndefined();
  });

  it("drops attribute entries without a key, and a repeated key keeps its last value", () => {
    expect(
      decodeAttributes([kv("a", { stringValue: "1" }), { value: { stringValue: "x" } }, "junk", kv("a", { stringValue: "2" })]),
    ).toEqual({ a: "2" });
    expect(decodeAttributes(undefined)).toEqual({});
  });
});

describe("nanosToMs", () => {
  it("reads decimal strings and numbers, and treats zero as unset", () => {
    expect(nanosToMs("1792358964879000000")).toBe(1792358964879);
    expect(nanosToMs(1_500_000_000)).toBe(1500);
    expect(nanosToMs("0")).toBeUndefined();
    expect(nanosToMs(0)).toBeUndefined();
    expect(nanosToMs("12ab")).toBeUndefined();
    expect(nanosToMs(undefined)).toBeUndefined();
  });
});

describe("parseOtlp metrics", () => {
  it("makes one record per data point, of every metric type", () => {
    const point = (extra: Record<string, unknown>) => ({
      attributes: [kv("type", { stringValue: "input" }), kv("session.id", { stringValue: "cli-1" })],
      startTimeUnixNano: "1792358964000000000",
      timeUnixNano: "1792358965000000000",
      ...extra,
    });
    const batch = parseOtlp(
      "metrics",
      {
        resourceMetrics: [
          {
            resource,
            scopeMetrics: [
              {
                scope: { name: "com.anthropic.claude_code", version: "2.1.296" },
                metrics: [
                  {
                    name: "claude_code.token.usage",
                    unit: "tokens",
                    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [point({ asDouble: 250 })] },
                  },
                  { name: "claude_code.gauge", gauge: { dataPoints: [point({ asInt: "7" })] } },
                  {
                    name: "claude_code.hist",
                    histogram: { dataPoints: [point({ sum: 12.5, count: "3", bucketCounts: ["1", "2"], explicitBounds: [10] })] },
                  },
                  { name: "claude_code.exp", exponentialHistogram: { dataPoints: [point({ sum: 1, scale: 2 })] } },
                  {
                    name: "claude_code.summary",
                    summary: { dataPoints: [point({ sum: 4, quantileValues: [{ quantile: 0.5, value: 2 }] })] },
                  },
                  { name: "claude_code.bad", sum: { dataPoints: [point({ asDouble: "lots" }), "junk"] } },
                ],
              },
            ],
          },
        ],
      },
      RECEIVED,
    );
    expect(batch.sources).toEqual([
      {
        resource: { "cockpit.session_id": "sess-1", "service.name": "claude-code" },
        scope: { name: "com.anthropic.claude_code", version: "2.1.296" },
      },
    ]);
    expect(batch.records.map((r) => [r.name, r.value])).toEqual([
      ["claude_code.token.usage", 250],
      ["claude_code.gauge", 7],
      ["claude_code.hist", 12.5],
      ["claude_code.exp", 1],
      ["claude_code.summary", 4],
      ["claude_code.bad", undefined],
    ]);
    const tokens = batch.records[0];
    expect(tokens).toMatchObject({ signal: "metric", timeMs: 1792358965000, cliSessionId: "cli-1", attrs: { type: "input" }, source: 0 });
    expect(tokens.detail).toEqual({ type: "sum", unit: "tokens", temporality: 1, monotonic: true, startMs: 1792358964000 });
    expect(batch.records[2].detail).toMatchObject({ type: "histogram", count: 3, bucketCounts: [1, 2], explicitBounds: [10] });
    expect(batch.skipped).toBe(1);
  });

  it("counts a metric with no name or no data rather than failing", () => {
    const batch = parseOtlp(
      "metrics",
      { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ sum: { dataPoints: [] } }, { name: "x" }, null] }] }] },
      RECEIVED,
    );
    expect(batch.records).toEqual([]);
    expect(batch.sources).toEqual([]);
    expect(batch.skipped).toBe(3);
  });
});

describe("parseOtlp logs", () => {
  const record = (extra: Record<string, unknown>) => ({
    timeUnixNano: "1792358964900000000",
    observedTimeUnixNano: "1792358964900000000",
    attributes: [
      kv("event.name", { stringValue: "api_request" }),
      kv("prompt.id", { stringValue: "p-1" }),
      kv("session.id", { stringValue: "cli-1" }),
    ],
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    flags: 1,
    ...extra,
  });
  const logs = (...records: unknown[]) => ({
    resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "events" }, logRecords: records }] }],
  });

  it("names an event from its body, keeping the body and the ids that join it to its turn", () => {
    const [r] = parseOtlp("logs", logs(record({ body: { stringValue: "claude_code.api_request" } })), RECEIVED).records;
    expect(r).toMatchObject({
      signal: "log",
      name: "claude_code.api_request",
      timeMs: 1792358964900,
      promptId: "p-1",
      cliSessionId: "cli-1",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
    });
    expect(r.detail).toEqual({ body: "claude_code.api_request", flags: 1, observedMs: 1792358964900 });
  });

  it("prefers eventName, falls back to the event.name attribute for a free-text body, and to 'log' with neither", () => {
    const names = parseOtlp(
      "logs",
      logs(
        record({ eventName: "claude_code.explicit", body: { stringValue: "claude_code.body" } }),
        record({ body: { stringValue: "Something happened, see the attached report." } }),
        { body: { stringValue: "free text with spaces" }, attributes: [] },
      ),
      RECEIVED,
    ).records.map((r) => r.name);
    expect(names).toEqual(["claude_code.explicit", "api_request", "log"]);
  });

  it("takes the observed time, then the time it arrived, when a record has no time of its own", () => {
    const [observed, none] = parseOtlp(
      "logs",
      logs(record({ timeUnixNano: "0", observedTimeUnixNano: "1792358960000000000" }), { attributes: [] }),
      RECEIVED,
    ).records;
    expect(observed.timeMs).toBe(1792358960000);
    expect(none.timeMs).toBe(RECEIVED);
  });
});

describe("parseOtlp traces", () => {
  it("stores each span with its duration, and each event on it as a row of its own", () => {
    const batch = parseOtlp(
      "traces",
      {
        resourceSpans: [
          {
            resource,
            scopeSpans: [
              {
                scope: { name: "tracing", version: "1.0.0" },
                spans: [
                  {
                    traceId: "t1",
                    spanId: "s2",
                    parentSpanId: "s1",
                    name: "claude_code.llm_request",
                    kind: 1,
                    startTimeUnixNano: "1792358964880000000",
                    endTimeUnixNano: "1792358964880750000",
                    attributes: [kv("prompt.id", { stringValue: "p-1" }), kv("session.id", { stringValue: "cli-1" })],
                    events: [
                      { name: "gen_ai.request.attempt", timeUnixNano: "1792358964880100000", attributes: [kv("attempt", { intValue: 1 })] },
                      { name: "", attributes: [] },
                    ],
                    status: { code: 2, message: "refused" },
                    links: [{ traceId: "t0", spanId: "s0", attributes: [] }],
                    droppedAttributesCount: 0,
                    flags: 257,
                  },
                  { name: "claude_code.interaction", traceId: "t1", spanId: "s1", attributes: [] },
                  { traceId: "t1" },
                ],
              },
            ],
          },
        ],
      },
      RECEIVED,
    );
    const [span, event, root] = batch.records;
    expect(span).toMatchObject({
      signal: "span",
      name: "claude_code.llm_request",
      timeMs: 1792358964880,
      endMs: 1792358964880,
      value: 0.75,
      traceId: "t1",
      spanId: "s2",
      parentSpanId: "s1",
      promptId: "p-1",
    });
    expect(span.detail).toMatchObject({
      kind: 1,
      status: { code: 2, message: "refused" },
      flags: 257,
      startNs: "1792358964880000000",
      links: [{ traceId: "t0", spanId: "s0" }],
    });
    expect(span.detail).not.toHaveProperty("droppedAttributesCount");
    // The event carries its span's ids, and the span's prompt and session when
    // it has none of its own.
    expect(event).toMatchObject({
      signal: "span_event",
      name: "gen_ai.request.attempt",
      traceId: "t1",
      spanId: "s2",
      promptId: "p-1",
      cliSessionId: "cli-1",
      attrs: { attempt: 1 },
    });
    expect(root).toMatchObject({ name: "claude_code.interaction", timeMs: RECEIVED, value: undefined });
    expect(batch.skipped).toBe(2);
  });
});

describe("parseOtlp, malformed", () => {
  it("never throws, and counts what it could not read", () => {
    expect(parseOtlp("logs", null, RECEIVED)).toEqual({ sources: [], records: [], skipped: 1 });
    expect(parseOtlp("logs", { resourceLogs: ["x", { scopeLogs: ["y", { logRecords: [null] }] }] }, RECEIVED).skipped).toBe(3);
    expect(parseOtlp("traces", { resourceSpans: "nope" }, RECEIVED)).toEqual({ sources: [], records: [], skipped: 0 });
  });

  it("drops scope blocks with no records, renumbering the rest", () => {
    const batch = parseOtlp(
      "logs",
      {
        resourceLogs: [
          {
            scopeLogs: [
              { scope: { name: "empty" }, logRecords: [] },
              { scope: { name: "full" }, logRecords: [{ body: { stringValue: "e" } }] },
            ],
          },
        ],
      },
      RECEIVED,
    );
    expect(batch.sources.map((s) => s.scope.name)).toEqual(["full"]);
    expect(batch.records[0].source).toBe(0);
  });
});
