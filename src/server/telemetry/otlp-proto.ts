/**
 * OTLP's protobuf encoding (application/x-protobuf), decoded into the shape of
 * its JSON encoding, so parseOtlp reads both the same way.
 *
 * Needed because managed settings can choose the protocol: when they set
 * OTEL_EXPORTER_OTLP_PROTOCOL, Claude Code removes every per-signal protocol
 * set below them, cockpit's included, so every batch arrives in the one they
 * chose, and http/protobuf is OTel's default.
 *
 * A reader for the protobuf wire format and the OTLP v1 messages only, from
 * opentelemetry-proto: field numbers below are that schema's. Unknown fields
 * are skipped, as protobuf requires, so a newer exporter's additions do not
 * break it. The output follows the JSON encoding: 64-bit integers as decimal
 * strings (numbers when they fit, for int values), ids as lowercase hex, bytes
 * as base64.
 */

import type { OtlpKind } from "./otlp";

type Json = Record<string, unknown>;

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

class Reader {
  pos: number;
  private readonly view: DataView;

  constructor(
    private readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  more(): boolean {
    return this.pos < this.end;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new Error("truncated protobuf message");
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      this.need(1);
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      if (shift >= 63n) throw new Error("varint longer than 64 bits");
    }
  }

  uint(): number {
    return Number(BigInt.asUintN(64, this.varint()));
  }

  fixed64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  sfixed64(): bigint {
    return BigInt.asIntN(64, this.fixed64());
  }

  fixed32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** A length-delimited field's bounds, leaving the reader after it. */
  span(): [number, number] {
    const len = this.uint();
    this.need(len);
    const start = this.pos;
    this.pos += len;
    return [start, this.pos];
  }

  bytes(): Uint8Array {
    const [start, end] = this.span();
    return this.buf.subarray(start, end);
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  sub(): Reader {
    const [start, end] = this.span();
    return new Reader(this.buf, start, end);
  }

  private advance(n: number): void {
    this.need(n);
    this.pos += n;
  }

  skip(wire: number): void {
    if (wire === VARINT) this.varint();
    else if (wire === FIXED64) this.advance(8);
    else if (wire === LENGTH) this.span();
    else if (wire === FIXED32) this.advance(4);
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

/** Walk a message's fields; the visitor returns false for a field it does not
 *  read, which is then skipped. */
function each(r: Reader, visit: (field: number, wire: number) => boolean | undefined): void {
  while (r.more()) {
    const tag = r.uint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new Error("protobuf field number 0");
    if (visit(field, wire) !== true) r.skip(wire);
  }
}

/** A repeated scalar, packed (one length-delimited run, proto3's default) or
 *  one element per field. */
function repeated<T>(r: Reader, wire: number, one: (r: Reader) => T, out: T[]): void {
  if (wire === LENGTH) {
    const inner = r.sub();
    while (inner.more()) out.push(one(inner));
  } else out.push(one(r));
}

/** Append to a repeated field that is only present once it has a value. */
function append(out: Json, key: string, value: Json): void {
  const list = out[key];
  if (Array.isArray(list)) list.push(value);
  else out[key] = [value];
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function int64(v: bigint): number | string {
  const signed = BigInt.asIntN(64, v);
  return signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(signed) : signed.toString();
}

function zigzag32(v: bigint): number {
  const n = Number(BigInt.asUintN(32, v));
  return (n >>> 1) ^ -(n & 1);
}

function anyValue(r: Reader): Json {
  let out: Json = {};
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) out = { stringValue: r.string() };
    else if (field === 2 && wire === VARINT) out = { boolValue: r.varint() !== 0n };
    else if (field === 3 && wire === VARINT) out = { intValue: int64(r.varint()) };
    else if (field === 4 && wire === FIXED64) out = { doubleValue: r.double() };
    else if (field === 5 && wire === LENGTH) out = { arrayValue: { values: valueList(r.sub(), anyValue) } };
    else if (field === 6 && wire === LENGTH) out = { kvlistValue: { values: valueList(r.sub(), keyValue) } };
    else if (field === 7 && wire === LENGTH) out = { bytesValue: Buffer.from(r.bytes()).toString("base64") };
    else return false;
    return true;
  });
  return out;
}

/** ArrayValue and KeyValueList: `repeated <message> values = 1`. */
function valueList(r: Reader, item: (r: Reader) => Json): Json[] {
  const values: Json[] = [];
  each(r, (field, wire) => {
    if (field !== 1 || wire !== LENGTH) return false;
    values.push(item(r.sub()));
    return true;
  });
  return values;
}

function keyValue(r: Reader): Json {
  const out: Json = { key: "" };
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) out.key = r.string();
    else if (field === 2 && wire === LENGTH) out.value = anyValue(r.sub());
    else return false;
    return true;
  });
  return out;
}

/** Resource and InstrumentationScope share the attribute and dropped-count
 *  fields at different numbers. */
function resource(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 2 && wire === VARINT) out.droppedAttributesCount = r.uint();
    else return false;
    return true;
  });
  return out;
}

function scope(r: Reader): Json {
  const out: Json = {};
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) out.name = r.string();
    else if (field === 2 && wire === LENGTH) out.version = r.string();
    else if (field === 3 && wire === LENGTH) append(out, "attributes", keyValue(r.sub()));
    else if (field === 4 && wire === VARINT) out.droppedAttributesCount = r.uint();
    else return false;
    return true;
  });
  return out;
}

export function decodeOtlpProtobuf(kind: OtlpKind, body: Uint8Array): Json {
  const r = new Reader(body);
  if (kind === "logs") return decodeEnvelope(r, "resourceLogs", "scopeLogs", "logRecords", logRecord);
  if (kind === "traces") return decodeEnvelope(r, "resourceSpans", "scopeSpans", "spans", span);
  return decodeEnvelope(r, "resourceMetrics", "scopeMetrics", "metrics", metric);
}

/** The envelope every signal shares: the request's resource blocks (field 1),
 *  each with its resource and scope blocks, each with its scope and items. */
function decodeEnvelope(r: Reader, resources: string, scopes: string, items: string, item: (r: Reader) => Json): Json {
  const blocks: Json[] = [];
  each(r, (field, wire) => {
    if (field !== 1 || wire !== LENGTH) return false;
    const rr = r.sub();
    const block: Json = { [scopes]: [] };
    each(rr, (f, w) => {
      if (f === 1 && w === LENGTH) block.resource = resource(rr.sub());
      else if (f === 2 && w === LENGTH) {
        const sr = rr.sub();
        const scoped: Json = { [items]: [] };
        each(sr, (sf, sw) => {
          if (sf === 1 && sw === LENGTH) scoped.scope = scope(sr.sub());
          else if (sf === 2 && sw === LENGTH) (scoped[items] as Json[]).push(item(sr.sub()));
          else if (sf === 3 && sw === LENGTH) scoped.schemaUrl = sr.string();
          else return false;
          return true;
        });
        (block[scopes] as Json[]).push(scoped);
      } else if (f === 3 && w === LENGTH) block.schemaUrl = rr.string();
      else return false;
      return true;
    });
    blocks.push(block);
    return true;
  });
  return { [resources]: blocks };
}

function logRecord(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 1 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 11 && wire === FIXED64) out.observedTimeUnixNano = r.fixed64().toString();
    else if (field === 2 && wire === VARINT) out.severityNumber = r.uint();
    else if (field === 3 && wire === LENGTH) out.severityText = r.string();
    else if (field === 5 && wire === LENGTH) out.body = anyValue(r.sub());
    else if (field === 6 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 7 && wire === VARINT) out.droppedAttributesCount = r.uint();
    else if (field === 8 && wire === FIXED32) out.flags = r.fixed32();
    else if (field === 9 && wire === LENGTH) out.traceId = hex(r.bytes());
    else if (field === 10 && wire === LENGTH) out.spanId = hex(r.bytes());
    else if (field === 12 && wire === LENGTH) out.eventName = r.string();
    else return false;
    return true;
  });
  return out;
}

function span(r: Reader): Json {
  const out: Json = { attributes: [], events: [], links: [] };
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) out.traceId = hex(r.bytes());
    else if (field === 2 && wire === LENGTH) out.spanId = hex(r.bytes());
    else if (field === 3 && wire === LENGTH) out.traceState = r.string();
    else if (field === 4 && wire === LENGTH) out.parentSpanId = hex(r.bytes());
    else if (field === 16 && wire === FIXED32) out.flags = r.fixed32();
    else if (field === 5 && wire === LENGTH) out.name = r.string();
    else if (field === 6 && wire === VARINT) out.kind = r.uint();
    else if (field === 7 && wire === FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 8 && wire === FIXED64) out.endTimeUnixNano = r.fixed64().toString();
    else if (field === 9 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 10 && wire === VARINT) out.droppedAttributesCount = r.uint();
    else if (field === 11 && wire === LENGTH) (out.events as Json[]).push(spanEvent(r.sub()));
    else if (field === 12 && wire === VARINT) out.droppedEventsCount = r.uint();
    else if (field === 13 && wire === LENGTH) (out.links as Json[]).push(spanLink(r.sub()));
    else if (field === 14 && wire === VARINT) out.droppedLinksCount = r.uint();
    else if (field === 15 && wire === LENGTH) out.status = status(r.sub());
    else return false;
    return true;
  });
  return out;
}

function spanEvent(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 1 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 2 && wire === LENGTH) out.name = r.string();
    else if (field === 3 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 4 && wire === VARINT) out.droppedAttributesCount = r.uint();
    else return false;
    return true;
  });
  return out;
}

function spanLink(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) out.traceId = hex(r.bytes());
    else if (field === 2 && wire === LENGTH) out.spanId = hex(r.bytes());
    else if (field === 3 && wire === LENGTH) out.traceState = r.string();
    else if (field === 4 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 5 && wire === VARINT) out.droppedAttributesCount = r.uint();
    else if (field === 6 && wire === FIXED32) out.flags = r.fixed32();
    else return false;
    return true;
  });
  return out;
}

function status(r: Reader): Json {
  const out: Json = {};
  each(r, (field, wire) => {
    if (field === 2 && wire === LENGTH) out.message = r.string();
    else if (field === 3 && wire === VARINT) out.code = r.uint();
    else return false;
    return true;
  });
  return out;
}

const METRIC_DATA: Record<number, string> = { 5: "gauge", 7: "sum", 9: "histogram", 10: "exponentialHistogram", 11: "summary" };

function metric(r: Reader): Json {
  const out: Json = {};
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) out.name = r.string();
    else if (field === 2 && wire === LENGTH) out.description = r.string();
    else if (field === 3 && wire === LENGTH) out.unit = r.string();
    else if (field in METRIC_DATA && wire === LENGTH) out[METRIC_DATA[field]] = metricData(r.sub(), METRIC_DATA[field]);
    else if (field === 12 && wire === LENGTH) append(out, "metadata", keyValue(r.sub()));
    else return false;
    return true;
  });
  return out;
}

/** Gauge, Sum, Histogram, ExponentialHistogram and Summary: their points at
 *  field 1, and for some the temporality and monotonic flag. */
function metricData(r: Reader, type: string): Json {
  const out: Json = { dataPoints: [] };
  const point =
    type === "histogram"
      ? histogramPoint
      : type === "exponentialHistogram"
        ? exponentialPoint
        : type === "summary"
          ? summaryPoint
          : numberPoint;
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) (out.dataPoints as Json[]).push(point(r.sub()));
    else if (field === 2 && wire === VARINT && type !== "gauge" && type !== "summary") out.aggregationTemporality = r.uint();
    else if (field === 3 && wire === VARINT && type === "sum") out.isMonotonic = r.varint() !== 0n;
    else return false;
    return true;
  });
  return out;
}

function numberPoint(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 7 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 2 && wire === FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === FIXED64) out.asDouble = r.double();
    else if (field === 6 && wire === FIXED64) out.asInt = int64(r.sfixed64());
    else if (field === 5 && wire === LENGTH) append(out, "exemplars", exemplar(r.sub()));
    else if (field === 8 && wire === VARINT) out.flags = r.uint();
    else return false;
    return true;
  });
  return out;
}

function histogramPoint(r: Reader): Json {
  const out: Json = { attributes: [] };
  const buckets: string[] = [];
  const bounds: number[] = [];
  each(r, (field, wire) => {
    if (field === 9 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 2 && wire === FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === FIXED64) out.count = r.fixed64().toString();
    else if (field === 5 && wire === FIXED64) out.sum = r.double();
    else if (field === 6 && (wire === LENGTH || wire === FIXED64)) repeated(r, wire, (x) => x.fixed64().toString(), buckets);
    else if (field === 7 && (wire === LENGTH || wire === FIXED64)) repeated(r, wire, (x) => x.double(), bounds);
    else if (field === 8 && wire === LENGTH) append(out, "exemplars", exemplar(r.sub()));
    else if (field === 10 && wire === VARINT) out.flags = r.uint();
    else if (field === 11 && wire === FIXED64) out.min = r.double();
    else if (field === 12 && wire === FIXED64) out.max = r.double();
    else return false;
    return true;
  });
  if (buckets.length) out.bucketCounts = buckets;
  if (bounds.length) out.explicitBounds = bounds;
  return out;
}

function exponentialPoint(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 1 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 2 && wire === FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === FIXED64) out.count = r.fixed64().toString();
    else if (field === 5 && wire === FIXED64) out.sum = r.double();
    else if (field === 6 && wire === VARINT) out.scale = zigzag32(r.varint());
    else if (field === 7 && wire === FIXED64) out.zeroCount = r.fixed64().toString();
    else if (field === 8 && wire === LENGTH) out.positive = expBuckets(r.sub());
    else if (field === 9 && wire === LENGTH) out.negative = expBuckets(r.sub());
    else if (field === 10 && wire === VARINT) out.flags = r.uint();
    else if (field === 11 && wire === LENGTH) append(out, "exemplars", exemplar(r.sub()));
    else if (field === 12 && wire === FIXED64) out.min = r.double();
    else if (field === 13 && wire === FIXED64) out.max = r.double();
    else if (field === 14 && wire === FIXED64) out.zeroThreshold = r.double();
    else return false;
    return true;
  });
  return out;
}

function expBuckets(r: Reader): Json {
  const out: Json = {};
  const counts: string[] = [];
  each(r, (field, wire) => {
    if (field === 1 && wire === VARINT) out.offset = zigzag32(r.varint());
    else if (field === 2 && (wire === LENGTH || wire === VARINT))
      repeated(r, wire, (x) => BigInt.asUintN(64, x.varint()).toString(), counts);
    else return false;
    return true;
  });
  out.bucketCounts = counts;
  return out;
}

function summaryPoint(r: Reader): Json {
  const out: Json = { attributes: [] };
  each(r, (field, wire) => {
    if (field === 7 && wire === LENGTH) (out.attributes as Json[]).push(keyValue(r.sub()));
    else if (field === 2 && wire === FIXED64) out.startTimeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 4 && wire === FIXED64) out.count = r.fixed64().toString();
    else if (field === 5 && wire === FIXED64) out.sum = r.double();
    else if (field === 6 && wire === LENGTH) {
      const q = r.sub();
      const value: Json = {};
      each(q, (f, w) => {
        if (f === 1 && w === FIXED64) value.quantile = q.double();
        else if (f === 2 && w === FIXED64) value.value = q.double();
        else return false;
        return true;
      });
      append(out, "quantileValues", value);
    } else if (field === 8 && wire === VARINT) out.flags = r.uint();
    else return false;
    return true;
  });
  return out;
}

function exemplar(r: Reader): Json {
  const out: Json = {};
  each(r, (field, wire) => {
    if (field === 7 && wire === LENGTH) append(out, "filteredAttributes", keyValue(r.sub()));
    else if (field === 2 && wire === FIXED64) out.timeUnixNano = r.fixed64().toString();
    else if (field === 3 && wire === FIXED64) out.asDouble = r.double();
    else if (field === 6 && wire === FIXED64) out.asInt = int64(r.sfixed64());
    else if (field === 4 && wire === LENGTH) out.spanId = hex(r.bytes());
    else if (field === 5 && wire === LENGTH) out.traceId = hex(r.bytes());
    else return false;
    return true;
  });
  return out;
}
