/**
 * The telemetry worker's logic, kept apart from its thread bootstrap
 * (worker.ts) so it can be tested in-process.
 */

import { gunzipSync } from "node:zlib";
import { TelemetryDb, TelemetryDbError } from "./db";
import { parseOtlp } from "./otlp";
import { decodeOtlpProtobuf } from "./otlp-proto";
import type { WorkerInit, WorkerRequest, WorkerResponse } from "./protocol";
import { loadSqlite, type SqliteLoad } from "./sqlite";

const DEFAULT_PRUNE_EVERY_MS = 10 * 60 * 1000;
/** Ceiling on what a gzip body may inflate to. */
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

export function openStore(init: WorkerInit, load: () => SqliteLoad = () => loadSqlite()): { db: TelemetryDb } | { reason: string } {
  const loaded = load();
  if (!loaded.sqlite) return { reason: loaded.reason };
  try {
    return { db: TelemetryDb.open(init.file, loaded.sqlite, init.options) };
  } catch (err) {
    const why =
      err instanceof TelemetryDbError ? err.message : `could not open ${init.file}: ${err instanceof Error ? err.message : String(err)}`;
    return { reason: why };
  }
}

export interface WorkerCore {
  handle(msg: WorkerRequest): void;
  /** One full pruning pass, yielding between steps. */
  prune(): Promise<void>;
  /** Prune now and then on a timer. Returns a function that stops the timer. */
  startPruning(): () => void;
}

export function createWorkerCore(db: TelemetryDb, post: (r: WorkerResponse) => void, opts: { pruneEveryMs?: number } = {}): WorkerCore {
  let pruning: Promise<void> | null = null;

  const prune = (): Promise<void> => {
    if (pruning) return pruning;
    const pass = (async () => {
      try {
        while (!db.pruneStep().done) await new Promise((resolve) => setImmediate(resolve));
      } catch (err) {
        console.error("[telemetry] pruning failed:", err instanceof Error ? err.message : err);
      }
    })();
    // Cleared in a callback rather than inside the pass: a pass with nothing
    // to do finishes before `pruning` is even assigned, and clearing it there
    // would leave the finished pass in place, so no pass ever ran again.
    pruning = pass.finally(() => {
      pruning = null;
    });
    return pruning;
  };

  const handle = (msg: WorkerRequest): void => {
    if (msg.type === "ingest") {
      const bytes = msg.body.byteLength;
      try {
        let raw = Buffer.from(msg.body.buffer, msg.body.byteOffset, msg.body.byteLength);
        if (msg.meta.gzip) raw = gunzipSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
        const payload = msg.meta.encoding === "protobuf" ? decodeOtlpProtobuf(msg.meta.kind, raw) : JSON.parse(raw.toString("utf8"));
        const batch = parseOtlp(msg.meta.kind, payload, msg.meta.receivedMs);
        const records = db.ingest({ sessionId: msg.meta.sessionId, spawnId: msg.meta.spawnId, receivedMs: msg.meta.receivedMs }, batch);
        post({ type: "ack", bytes, records, skipped: batch.skipped });
      } catch (err) {
        post({ type: "ack", bytes, records: 0, skipped: 0, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    try {
      const result = msg.type === "query" ? db.query(msg.query) : db.stats(msg.sessionId);
      post({ type: "result", id: msg.id, result });
    } catch (err) {
      post({ type: "result", id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const startPruning = (): (() => void) => {
    void prune();
    const timer = setInterval(() => void prune(), opts.pruneEveryMs ?? DEFAULT_PRUNE_EVERY_MS);
    return () => clearInterval(timer);
  };

  return { handle, prune, startPruning };
}
