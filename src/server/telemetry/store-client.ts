/**
 * The server's handle on the telemetry worker: starts it, hands it OTLP
 * batches without waiting, and asks it questions. If the worker cannot start
 * or stops, the store reports itself unavailable with the reason and every
 * call fails soft.
 */

import path from "node:path";
import { Worker } from "node:worker_threads";
import type { TelemetryPage, TelemetryQuery, TelemetryStoreStats } from "@/types";
import type { IngestMeta, WorkerInit, WorkerRequest, WorkerResponse } from "./protocol";

export interface WorkerLike {
  postMessage(msg: WorkerRequest, transfer?: ArrayBuffer[]): void;
  on(event: "message", cb: (msg: WorkerResponse) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "exit", cb: (code: number) => void): unknown;
  unref?(): void;
}

export type WorkerFactory = (init: WorkerInit) => WorkerLike;

export type IngestResult = "queued" | "full" | "unavailable";

export interface IngestCounters {
  batches: number;
  records: number;
  skipped: number;
  failed: number;
  lastError?: string;
}

/** What the telemetry service needs from a store. */
export interface StoreLike {
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly pendingBytes: number;
  readonly counters: IngestCounters;
  ingest(meta: IngestMeta, body: Uint8Array): IngestResult;
  query(q: TelemetryQuery): Promise<TelemetryPage>;
  stats(sessionId?: string): Promise<TelemetryStoreStats>;
}

export interface StoreClientOptions {
  workerFactory?: WorkerFactory;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Bytes handed to the worker and not yet stored, past which ingest says "full". */
  queueLimitBytes?: number;
}

/** The worker's own file beside this one: worker.js from dist, or worker.ts
 *  when the server runs from source under tsx (the dev server). A worker does
 *  not get tsx's loader from its parent, and Node's own type stripping loads
 *  worker.ts but none of its extensionless imports, so from source the worker
 *  registers tsx itself before loading it. */
function defaultWorkerFactory(init: WorkerInit): WorkerLike {
  if (__filename.endsWith(".ts")) {
    const tsx = require.resolve("tsx/cjs/api");
    const entry = path.join(__dirname, "worker.ts");
    return new Worker(`require(${JSON.stringify(tsx)}).register(); require(${JSON.stringify(entry)});`, { eval: true, workerData: init });
  }
  return new Worker(path.join(__dirname, "worker.js"), { workerData: init });
}

interface Pending {
  resolve: (v: never) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TelemetryStoreClient implements StoreLike {
  private _available = false;
  private _reason: string | undefined;
  private _pendingBytes = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly counters: IngestCounters = { batches: 0, records: 0, skipped: 0, failed: 0 };
  private readonly requestTimeoutMs: number;
  private readonly queueLimitBytes: number;

  private constructor(
    private readonly worker: WorkerLike,
    opts: StoreClientOptions,
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.queueLimitBytes = opts.queueLimitBytes ?? 256 * 1024 * 1024;
  }

  get available(): boolean {
    return this._available;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  get pendingBytes(): number {
    return this._pendingBytes;
  }

  /** Start the worker and wait for it to say whether it can store anything.
   *  Never rejects: a worker that fails gives an unavailable store. */
  static start(init: WorkerInit, opts: StoreClientOptions = {}): Promise<TelemetryStoreClient> {
    let worker: WorkerLike;
    try {
      worker = (opts.workerFactory ?? defaultWorkerFactory)(init);
    } catch (err) {
      const client = new TelemetryStoreClient({ postMessage() {}, on() {} }, opts);
      client.fail(`telemetry worker could not start: ${err instanceof Error ? err.message : String(err)}`);
      return Promise.resolve(client);
    }
    worker.unref?.();
    const client = new TelemetryStoreClient(worker, opts);
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(client);
      };
      const timer = setTimeout(() => {
        client.fail(`telemetry worker did not start within ${opts.readyTimeoutMs ?? 10_000} ms`);
        settle();
      }, opts.readyTimeoutMs ?? 10_000);
      worker.on("message", (msg) => {
        if (msg.type === "ready") {
          if (msg.available) client._available = true;
          else client.fail(msg.reason);
          settle();
          return;
        }
        client.onMessage(msg);
      });
      worker.on("error", (err) => {
        client.fail(`telemetry worker failed: ${err.message}`);
        settle();
      });
      worker.on("exit", (code) => {
        if (client._available || !settled) client.fail(`telemetry worker exited (code ${code})`);
        settle();
      });
    });
  }

  /** Stop accepting work and fail anything waiting on an answer. Keeps the
   *  first reason given, which is the one that explains the rest. */
  private fail(reason: string): void {
    this._available = false;
    this._reason ??= reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === "ack") {
      this._pendingBytes = Math.max(0, this._pendingBytes - msg.bytes);
      this.counters.batches++;
      this.counters.records += msg.records;
      this.counters.skipped += msg.skipped;
      if (msg.error) {
        this.counters.failed++;
        this.counters.lastError = msg.error;
      }
      return;
    }
    if (msg.type !== "result") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result as never);
  }

  /** Hand a batch to the worker without waiting for it to be stored. The
   *  body's buffer is transferred, so it must be the body's alone. */
  ingest(meta: IngestMeta, body: Uint8Array): IngestResult {
    if (!this._available) return "unavailable";
    if (this._pendingBytes + body.byteLength > this.queueLimitBytes) return "full";
    this._pendingBytes += body.byteLength;
    this.worker.postMessage({ type: "ingest", meta, body }, [body.buffer as ArrayBuffer]);
    return "queued";
  }

  private request<T>(msg: (id: number) => WorkerRequest): Promise<T> {
    if (!this._available) return Promise.reject(new Error(this._reason ?? "telemetry store unavailable"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`telemetry worker did not answer within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject, timer });
      this.worker.postMessage(msg(id));
    });
  }

  query(q: TelemetryQuery): Promise<TelemetryPage> {
    return this.request((id) => ({ type: "query", id, query: q }));
  }

  stats(sessionId?: string): Promise<TelemetryStoreStats> {
    return this.request((id) => ({ type: "stats", id, sessionId }));
  }
}
