// The server's side of the telemetry worker, against a fake worker: starting,
// handing over batches without waiting, asking questions, and failing soft.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestMeta, WorkerRequest, WorkerResponse } from "@/server/telemetry/protocol";
import { TelemetryStoreClient, type WorkerLike } from "@/server/telemetry/store-client";

class FakeWorker extends EventEmitter implements WorkerLike {
  sent: { msg: WorkerRequest; transfer?: ArrayBuffer[] }[] = [];
  unref = vi.fn();
  postMessage(msg: WorkerRequest, transfer?: ArrayBuffer[]): void {
    this.sent.push({ msg, transfer });
  }
  reply(msg: WorkerResponse): void {
    this.emit("message", msg);
  }
}

const meta: IngestMeta = { sessionId: "s", spawnId: "sp", kind: "logs", receivedMs: 1, gzip: false, encoding: "json" };

async function started(opts: { queueLimitBytes?: number; requestTimeoutMs?: number } = {}) {
  const worker = new FakeWorker();
  const pending = TelemetryStoreClient.start({ file: "/x" }, { workerFactory: () => worker, ...opts });
  worker.reply({ type: "ready", available: true });
  return { worker, store: await pending };
}

describe("TelemetryStoreClient.start", () => {
  afterEach(() => vi.useRealTimers());

  it("is available once the worker says so, and never keeps the process alive", async () => {
    const { worker, store } = await started();
    expect(store.available).toBe(true);
    expect(store.reason).toBeUndefined();
    expect(worker.unref).toHaveBeenCalled();
  });

  it("is unavailable, with the reason, when the worker cannot store anything", async () => {
    const worker = new FakeWorker();
    const pending = TelemetryStoreClient.start({ file: "/x" }, { workerFactory: () => worker });
    worker.reply({ type: "ready", available: false, reason: "no sqlite" });
    const store = await pending;
    expect(store.available).toBe(false);
    expect(store.reason).toBe("no sqlite");
    expect(store.ingest(meta, new Uint8Array(1))).toBe("unavailable");
    await expect(store.query({})).rejects.toThrow("no sqlite");
  });

  it("fails soft when the worker cannot be made, errors, exits or never answers", async () => {
    const thrown = await TelemetryStoreClient.start(
      { file: "/x" },
      {
        workerFactory: () => {
          throw new Error("no threads");
        },
      },
    );
    expect(thrown.reason).toBe("telemetry worker could not start: no threads");

    const erroring = new FakeWorker();
    const e = TelemetryStoreClient.start({ file: "/x" }, { workerFactory: () => erroring });
    erroring.emit("error", new Error("bad module"));
    expect((await e).reason).toBe("telemetry worker failed: bad module");

    const exiting = new FakeWorker();
    const x = TelemetryStoreClient.start({ file: "/x" }, { workerFactory: () => exiting });
    exiting.emit("exit", 1);
    expect((await x).reason).toBe("telemetry worker exited (code 1)");

    vi.useFakeTimers();
    const silent = TelemetryStoreClient.start({ file: "/x" }, { workerFactory: () => new FakeWorker(), readyTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await silent).reason).toBe("telemetry worker did not start within 50 ms");
  });
});

describe("TelemetryStoreClient at work", () => {
  afterEach(() => vi.useRealTimers());

  it("hands a batch over by transfer and counts what the worker acknowledges", async () => {
    const { worker, store } = await started();
    const body = new Uint8Array(10);
    expect(store.ingest(meta, body)).toBe("queued");
    expect(store.pendingBytes).toBe(10);
    expect(worker.sent[0].msg).toEqual({ type: "ingest", meta, body });
    expect(worker.sent[0].transfer).toEqual([body.buffer]);

    worker.reply({ type: "ack", bytes: 10, records: 4, skipped: 1 });
    worker.reply({ type: "ack", bytes: 99, records: 0, skipped: 0, error: "bad json" });
    expect(store.pendingBytes).toBe(0);
    expect(store.counters).toEqual({ batches: 2, records: 4, skipped: 1, failed: 1, lastError: "bad json" });
  });

  it("says full rather than queueing past its limit", async () => {
    const { store } = await started({ queueLimitBytes: 15 });
    expect(store.ingest(meta, new Uint8Array(10))).toBe("queued");
    expect(store.ingest(meta, new Uint8Array(10))).toBe("full");
  });

  it("matches answers to questions, and passes an error on", async () => {
    const { worker, store } = await started();
    const page = store.query({ session: "s" });
    const stats = store.stats("s");
    const [q, st] = worker.sent.map((s) => s.msg) as Array<{ id: number }>;
    expect(worker.sent.map((s) => s.msg)).toEqual([
      { type: "query", id: q.id, query: { session: "s" } },
      { type: "stats", id: st.id, sessionId: "s" },
    ]);
    worker.reply({ type: "result", id: 999, result: undefined });
    worker.reply({ type: "result", id: st.id, error: "locked" });
    worker.reply({ type: "result", id: q.id, result: { records: [], sources: {}, nextCursor: null } });
    await expect(page).resolves.toEqual({ records: [], sources: {}, nextCursor: null });
    await expect(stats).rejects.toThrow("locked");
  });

  it("gives up on a question the worker never answers", async () => {
    vi.useFakeTimers();
    const { store } = await started({ requestTimeoutMs: 100 });
    const page = store.query({});
    const check = expect(page).rejects.toThrow("telemetry worker did not answer within 100 ms");
    await vi.advanceTimersByTimeAsync(100);
    await check;
  });

  it("fails everything waiting, and everything after, when the worker stops", async () => {
    const { worker, store } = await started();
    const page = store.query({});
    worker.emit("exit", 3);
    await expect(page).rejects.toThrow("telemetry worker exited (code 3)");
    expect(store.available).toBe(false);
    expect(store.ingest(meta, new Uint8Array(1))).toBe("unavailable");
  });
});
