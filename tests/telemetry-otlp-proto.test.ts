// OTLP's protobuf encoding, decoded into its JSON shape: against a real CLI
// capture, and against hand-built messages for every field the decoder reads.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseOtlp } from "@/server/telemetry/otlp";
import { decodeOtlpProtobuf } from "@/server/telemetry/otlp-proto";

/** Just enough of a protobuf writer to build test messages. */
class W {
  private parts: number[] = [];
  private raw(bytes: Iterable<number>): this {
    for (const b of bytes) this.parts.push(b);
    return this;
  }
  private varintBytes(v: bigint): number[] {
    let n = BigInt.asUintN(64, v);
    const out: number[] = [];
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) b |= 0x80;
      out.push(b);
    } while (n > 0n);
    return out;
  }
  private tag(field: number, wire: number): this {
    return this.raw(this.varintBytes(BigInt(field * 8 + wire)));
  }
  varint(field: number, v: bigint | number | boolean): this {
    return this.tag(field, 0).raw(this.varintBytes(BigInt(typeof v === "boolean" ? Number(v) : v)));
  }
  fixed64(field: number, v: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt.asUintN(64, v));
    return this.tag(field, 1).raw(b);
  }
  double(field: number, v: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return this.tag(field, 1).raw(b);
  }
  fixed32(field: number, v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return this.tag(field, 5).raw(b);
  }
  bytes(field: number, v: Uint8Array): this {
    return this.tag(field, 2)
      .raw(this.varintBytes(BigInt(v.length)))
      .raw(v);
  }
  string(field: number, v: string): this {
    return this.bytes(field, Buffer.from(v));
  }
  msg(field: number, m: W): this {
    return this.bytes(field, m.done());
  }
  packedFixed64(field: number, vs: bigint[]): this {
    const b = Buffer.alloc(8 * vs.length);
    for (const [i, v] of vs.entries()) b.writeBigUInt64LE(v, i * 8);
    return this.bytes(field, b);
  }
  packedDouble(field: number, vs: number[]): this {
    const b = Buffer.alloc(8 * vs.length);
    for (const [i, v] of vs.entries()) b.writeDoubleLE(v, i * 8);
    return this.bytes(field, b);
  }
  packedVarint(field: number, vs: bigint[]): this {
    return this.bytes(field, Uint8Array.from(vs.flatMap((v) => this.varintBytes(v))));
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

const kv = (key: string, value: W) => new W().string(1, key).msg(2, value);
const str = (s: string) => new W().string(1, s);
const T0 = 1792358964000000000n;

/** A request for one signal: one resource block with one scope block. */
function request(itemField: number, items: W[], scope = new W().string(1, "scope").string(2, "1.0")): Uint8Array {
  const scoped = new W().msg(1, scope);
  for (const item of items) scoped.msg(2, item);
  scoped.string(3, "https://schema/scope");
  const resource = new W().msg(1, kv("service.name", str("claude-code"))).varint(2, 1);
  return new W()
    .msg(
      1,
      new W()
        .msg(1, resource)
        .msg(itemField === 2 ? 2 : 2, scoped)
        .string(3, "https://schema/resource"),
    )
    .done();
}

describe("decodeOtlpProtobuf on a real CLI capture", () => {
  const capture = JSON.parse(readFileSync(path.join(__dirname, "fixtures/otlp-protobuf-capture.json"), "utf8")) as Record<string, string>;
  const decoded = (kind: "logs" | "traces" | "metrics") =>
    parseOtlp(kind, decodeOtlpProtobuf(kind, new Uint8Array(Buffer.from(capture[kind], "base64"))), 1);

  it("reads every event of the turn, with its ids and attributes", () => {
    const logs = decoded("logs");
    expect(logs.skipped).toBe(0);
    expect(new Set(logs.records.map((r) => r.name))).toEqual(
      new Set([
        "claude_code.managed_settings_resolved",
        "claude_code.plugin_loaded",
        "claude_code.user_prompt",
        "claude_code.tool_decision",
        "claude_code.api_request",
        "claude_code.assistant_response",
        "claude_code.tool_result",
      ]),
    );
    const prompt = logs.records.find((r) => r.name === "claude_code.user_prompt");
    expect(prompt?.attrs.prompt).toBe("run the probe command");
    expect(prompt?.promptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(prompt?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(prompt?.timeMs).toBeGreaterThan(1_700_000_000_000);
    expect(logs.sources[0].resource).toMatchObject({ "cockpit.session_id": "session-abc", "service.name": "claude-code" });
    const request = logs.records.find((r) => r.name === "claude_code.api_request");
    expect(typeof request?.attrs.input_tokens).toBe("number");
    expect(typeof request?.attrs.cost_usd).toBe("number");
  });

  it("reads the spans with their parents, durations and events", () => {
    const traces = decoded("traces");
    const names = traces.records.map((r) => `${r.signal}:${r.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "span:claude_code.interaction",
        "span:claude_code.llm_request",
        "span:claude_code.tool",
        "span_event:tool.output",
      ]),
    );
    const tool = traces.records.find((r) => r.name === "claude_code.tool");
    const interaction = traces.records.find((r) => r.name === "claude_code.interaction");
    expect(tool?.parentSpanId).toBe(interaction?.spanId);
    expect(tool?.value).toBeGreaterThan(0);
  });

  it("reads the metric points with their values", () => {
    const metrics = decoded("metrics");
    const tokens = metrics.records.filter((r) => r.name === "claude_code.token.usage");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((r) => typeof r.value === "number")).toBe(true);
    expect(tokens[0].detail).toMatchObject({ type: "sum", temporality: 1, monotonic: true });
  });
});

describe("decodeOtlpProtobuf, field by field", () => {
  it("decodes every kind of attribute value", () => {
    const record = new W()
      .fixed64(1, T0)
      .fixed64(11, T0 + 1n)
      .varint(2, 9)
      .string(3, "INFO")
      .msg(5, str("claude_code.event"))
      .msg(6, kv("s", str("text")))
      .msg(6, kv("b", new W().varint(2, true)))
      .msg(6, kv("i", new W().varint(3, 42)))
      .msg(6, kv("neg", new W().varint(3, -5n)))
      .msg(6, kv("big", new W().varint(3, 9007199254740993n)))
      .msg(6, kv("d", new W().double(4, 0.5)))
      .msg(6, kv("arr", new W().msg(5, new W().msg(1, str("a")).msg(1, new W().varint(3, 1)))))
      .msg(6, kv("kv", new W().msg(6, new W().msg(1, kv("k", str("v"))))))
      .msg(6, kv("raw", new W().bytes(7, Uint8Array.from([0, 1, 2]))))
      .msg(6, kv("empty", new W()))
      .varint(7, 3)
      .fixed32(8, 1)
      .bytes(9, Uint8Array.from([0xab, 0xcd]))
      .bytes(10, Uint8Array.from([0x01]))
      .string(12, "claude_code.named")
      // A field this decoder does not know, of each wire type, skipped.
      .varint(99, 1)
      .fixed64(98, 1n)
      .fixed32(97, 1)
      .string(96, "future");
    const decoded = decodeOtlpProtobuf("logs", request(2, [record])) as { resourceLogs: Array<Record<string, unknown>> };
    const block = decoded.resourceLogs[0];
    expect(block.resource).toEqual({
      attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
      droppedAttributesCount: 1,
    });
    expect(block.schemaUrl).toBe("https://schema/resource");
    const scoped = (block.scopeLogs as Array<Record<string, unknown>>)[0];
    expect(scoped.scope).toEqual({ name: "scope", version: "1.0" });
    expect(scoped.schemaUrl).toBe("https://schema/scope");
    const [log] = scoped.logRecords as Array<Record<string, unknown>>;
    expect(log).toMatchObject({
      timeUnixNano: T0.toString(),
      observedTimeUnixNano: (T0 + 1n).toString(),
      severityNumber: 9,
      severityText: "INFO",
      body: { stringValue: "claude_code.event" },
      droppedAttributesCount: 3,
      flags: 1,
      traceId: "abcd",
      spanId: "01",
      eventName: "claude_code.named",
    });
    const parsed = parseOtlp("logs", decoded, 1).records[0];
    expect(parsed.name).toBe("claude_code.named");
    expect(parsed.attrs).toEqual({
      s: "text",
      b: true,
      i: 42,
      neg: -5,
      big: "9007199254740993",
      d: 0.5,
      arr: ["a", 1],
      kv: { k: "v" },
      raw: "AAEC",
      empty: null,
    });
  });

  it("decodes spans with events, links and status", () => {
    const sp = new W()
      .bytes(1, Uint8Array.from([1, 2]))
      .bytes(2, Uint8Array.from([3]))
      .string(3, "state")
      .bytes(4, Uint8Array.from([4]))
      .fixed32(16, 257)
      .string(5, "claude_code.tool")
      .varint(6, 1)
      .fixed64(7, T0)
      .fixed64(8, T0 + 1_500_000n)
      .msg(9, kv("tool_name", str("Bash")))
      .varint(10, 0)
      .msg(
        11,
        new W()
          .fixed64(1, T0 + 1000n)
          .string(2, "tool.output")
          .msg(3, kv("output", str("ok")))
          .varint(4, 0),
      )
      .varint(12, 2)
      .msg(
        13,
        new W()
          .bytes(1, Uint8Array.from([9]))
          .bytes(2, Uint8Array.from([8]))
          .string(3, "s")
          .msg(4, kv("l", str("x")))
          .varint(5, 0)
          .fixed32(6, 1),
      )
      .varint(14, 0)
      .msg(15, new W().string(2, "refused").varint(3, 2));
    const decoded = decodeOtlpProtobuf("traces", request(2, [sp])) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    };
    const span = decoded.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span).toMatchObject({
      traceId: "0102",
      spanId: "03",
      traceState: "state",
      parentSpanId: "04",
      flags: 257,
      name: "claude_code.tool",
      kind: 1,
      droppedEventsCount: 2,
      status: { message: "refused", code: 2 },
      links: [{ traceId: "09", spanId: "08", traceState: "s", flags: 1 }],
    });
    const records = parseOtlp("traces", decoded, 1).records;
    expect(records[0]).toMatchObject({ signal: "span", value: 1.5 });
    expect(records[1]).toMatchObject({ signal: "span_event", name: "tool.output", attrs: { output: "ok" }, spanId: "03" });
  });

  it("decodes every metric type, with packed and unpacked repeated fields", () => {
    const attrs = (w: W, field: number) => w.msg(field, kv("type", str("input")));
    const exemplar = new W()
      .msg(7, kv("f", str("x")))
      .fixed64(2, T0)
      .double(3, 1.5)
      .bytes(4, Uint8Array.from([7]))
      .bytes(5, Uint8Array.from([6]));
    const exemplarInt = new W().fixed64(6, 5n);
    const sum = new W()
      .string(1, "claude_code.token.usage")
      .string(2, "tokens used")
      .string(3, "tokens")
      .msg(
        7,
        new W()
          .msg(
            1,
            attrs(new W(), 7)
              .fixed64(2, T0)
              .fixed64(3, T0 + 1n)
              .double(4, 250)
              .msg(5, exemplar)
              .varint(8, 0),
          )
          .varint(2, 1)
          .varint(3, true),
      )
      .msg(12, kv("meta", str("m")));
    const gauge = new W().string(1, "g").msg(5, new W().msg(1, new W().fixed64(3, T0).fixed64(6, -3n).msg(5, exemplarInt)));
    const histogram = new W().string(1, "h").msg(
      9,
      new W()
        .msg(
          1,
          attrs(new W(), 9)
            .fixed64(3, T0)
            .fixed64(4, 3n)
            .double(5, 12.5)
            .packedFixed64(6, [1n, 2n])
            .packedDouble(7, [10])
            .double(11, 1)
            .double(12, 9)
            .varint(10, 0)
            .msg(8, exemplar),
        )
        .msg(1, new W().fixed64(3, T0).fixed64(6, 4n).double(7, 20))
        .varint(2, 2),
    );
    const exponential = new W().string(1, "e").msg(
      10,
      new W()
        .msg(
          1,
          attrs(new W(), 1)
            .fixed64(3, T0)
            .fixed64(4, 2n)
            .double(5, 3)
            .varint(6, 3n)
            .fixed64(7, 1n)
            .msg(8, new W().varint(1, 3n).packedVarint(2, [1n, 1n]))
            .msg(9, new W().varint(1, 1n).varint(2, 4n))
            .varint(10, 0)
            .msg(11, exemplar)
            .double(12, 0.5)
            .double(13, 2.5)
            .double(14, 0.001),
        )
        .varint(2, 1),
    );
    const summary = new W()
      .string(1, "s")
      .msg(
        11,
        new W().msg(
          1,
          attrs(new W(), 7).fixed64(3, T0).fixed64(4, 3n).double(5, 6).msg(6, new W().double(1, 0.5).double(2, 2)).varint(8, 0),
        ),
      );
    const decoded = decodeOtlpProtobuf("metrics", request(2, [sum, gauge, histogram, exponential, summary])) as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<Record<string, Record<string, unknown>>> }> }>;
    };
    const [s, g, h, e, q] = decoded.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(s.sum).toMatchObject({ aggregationTemporality: 1, isMonotonic: true });
    expect((s.sum.dataPoints as Array<Record<string, unknown>>)[0]).toMatchObject({
      startTimeUnixNano: T0.toString(),
      asDouble: 250,
      exemplars: [{ timeUnixNano: T0.toString(), asDouble: 1.5, spanId: "07", traceId: "06" }],
    });
    expect(s.metadata).toEqual([{ key: "meta", value: { stringValue: "m" } }]);
    expect((g.gauge.dataPoints as Array<Record<string, unknown>>)[0]).toMatchObject({ asInt: -3, exemplars: [{ asInt: 5 }] });
    expect(h.histogram).toMatchObject({ aggregationTemporality: 2 });
    expect((h.histogram.dataPoints as Array<Record<string, unknown>>)[0]).toMatchObject({
      count: "3",
      sum: 12.5,
      bucketCounts: ["1", "2"],
      explicitBounds: [10],
      min: 1,
      max: 9,
    });
    // One element per field, the encoding before proto3 packed them.
    expect((h.histogram.dataPoints as Array<Record<string, unknown>>)[1]).toMatchObject({ bucketCounts: ["4"], explicitBounds: [20] });
    expect((e.exponentialHistogram.dataPoints as Array<Record<string, unknown>>)[0]).toMatchObject({
      scale: -2,
      zeroCount: "1",
      positive: { offset: -2, bucketCounts: ["1", "1"] },
      negative: { offset: -1, bucketCounts: ["4"] },
      min: 0.5,
      max: 2.5,
      zeroThreshold: 0.001,
    });
    expect((q.summary.dataPoints as Array<Record<string, unknown>>)[0]).toMatchObject({
      count: "3",
      sum: 6,
      quantileValues: [{ quantile: 0.5, value: 2 }],
    });

    const records = parseOtlp("metrics", decoded, 1).records;
    expect(records.map((r) => [r.name, r.value])).toEqual([
      ["claude_code.token.usage", 250],
      ["g", -3],
      ["h", 12.5],
      ["h", undefined],
      ["e", 3],
      ["s", 6],
    ]);
  });

  it("refuses what is not a protobuf message", () => {
    expect(() => decodeOtlpProtobuf("logs", Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow(/truncated/);
    expect(() => decodeOtlpProtobuf("logs", Uint8Array.from([0x0b]))).toThrow(/wire type 3/);
    expect(() => decodeOtlpProtobuf("logs", Uint8Array.from([0x02, 0x00]))).toThrow(/field number 0/);
    expect(() => decodeOtlpProtobuf("logs", Uint8Array.from([0x08, ...Array(10).fill(0xff), 0x01]))).toThrow(/64 bits/);
    expect(() => decodeOtlpProtobuf("logs", Uint8Array.from([0x09, 0x01]))).toThrow(/truncated/);
    expect(decodeOtlpProtobuf("traces", new Uint8Array())).toEqual({ resourceSpans: [] });
  });
});
