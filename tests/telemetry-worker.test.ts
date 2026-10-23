// The telemetry worker's logic, run in-process: what it does with a batch, a
// question, and a database it cannot open.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryDb } from "@/server/telemetry/db";
import type { WorkerResponse } from "@/server/telemetry/protocol";
import { loadSqlite } from "@/server/telemetry/sqlite";
import { createWorkerCore, openStore } from "@/server/telemetry/worker-core";

const { sqlite } = loadSqlite();
const logs = (body: string) => ({
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [{ scope: { name: "events" }, logRecords: [{ body: { stringValue: body }, attributes: [] }] }],
    },
  ],
});
const bytes = (v: unknown) => new Uint8Array(Buffer.from(JSON.stringify(v)));
const meta = { sessionId: "sess", spawnId: "spawn", kind: "logs" as const, receivedMs: 1_000, gzip: false, encoding: "json" as const };

describe("openStore", () => {
  it("says why when SQLite is missing", () => {
    expect(openStore({ file: "/nowhere" }, () => ({ sqlite: null, reason: "no sqlite here" }))).toEqual({ reason: "no sqlite here" });
  });

  it.skipIf(!sqlite)("says why when the database cannot be used", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-telworker-"));
    try {
      const file = join(dir, "telemetry.db");
      const raw = new (sqlite as NonNullable<typeof sqlite>).DatabaseSync(file);
      raw.exec("PRAGMA user_version = 7");
      raw.close();
      expect(openStore({ file })).toEqual({ reason: expect.stringMatching(/newer cockpit/) });
      // A directory where the file should be cannot be opened at all.
      expect(openStore({ file: dir })).toEqual({ reason: expect.stringMatching(/^could not open/) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!sqlite)("createWorkerCore", () => {
  let dir: string;
  let posted: WorkerResponse[];
  let core: ReturnType<typeof createWorkerCore>;
  let db: TelemetryDb;
  let close: () => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-telworker-"));
    const opened = openStore({ file: join(dir, "telemetry.db") });
    if ("reason" in opened) throw new Error(opened.reason);
    posted = [];
    db = opened.db;
    core = createWorkerCore(opened.db, (r) => posted.push(r), { pruneEveryMs: 60_000 });
    close = () => opened.db.close();
  });
  afterEach(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a batch, plain or gzipped, and acknowledges its bytes", () => {
    const plain = bytes(logs("claude_code.one"));
    core.handle({ type: "ingest", meta, body: plain });
    const zipped = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(logs("claude_code.two")))));
    core.handle({ type: "ingest", meta: { ...meta, gzip: true }, body: zipped });
    expect(posted).toEqual([
      { type: "ack", bytes: plain.byteLength, records: 1, skipped: 0 },
      { type: "ack", bytes: zipped.byteLength, records: 1, skipped: 0 },
    ]);
  });

  it("stores a protobuf batch, which is how managed settings may make the CLI send it", () => {
    const capture = JSON.parse(readFileSync(join(__dirname, "fixtures/otlp-protobuf-capture.json"), "utf8")) as Record<string, string>;
    const body = new Uint8Array(Buffer.from(capture.logs, "base64"));
    core.handle({ type: "ingest", meta: { ...meta, encoding: "protobuf" }, body });
    expect(posted[0]).toEqual({ type: "ack", bytes: body.byteLength, records: 11, skipped: 0 });
    expect(db.stats("sess").byName?.["claude_code.user_prompt"]).toBe(1);
  });

  it("acknowledges a batch it could not read, saying why", () => {
    core.handle({ type: "ingest", meta, body: new Uint8Array(Buffer.from("{not json")) });
    expect(posted[0]).toMatchObject({ type: "ack", records: 0, error: expect.any(String) });
  });

  it("answers queries and stats by id, and an error as an error", () => {
    core.handle({ type: "ingest", meta, body: bytes(logs("claude_code.one")) });
    core.handle({ type: "query", id: 7, query: { session: "sess" } });
    core.handle({ type: "stats", id: 8 });
    vi.spyOn(db, "query").mockImplementationOnce(() => {
      throw new Error("disk on fire");
    });
    core.handle({ type: "query", id: 9, query: {} });
    const [, query, stats, failed] = posted;
    expect(query).toMatchObject({ type: "result", id: 7, result: { records: [{ name: "claude_code.one" }] } });
    expect(stats).toMatchObject({ type: "result", id: 8, result: { records: 1 } });
    expect(failed).toEqual({ type: "result", id: 9, error: "disk on fire" });
  });

  it("stores cockpit's own records under the session, as cockpit's", () => {
    core.handle({
      type: "ingest-local",
      sessionId: "sess",
      receivedMs: 1_000,
      records: [{ name: "cockpit.permission_answer", timeMs: 900, endMs: 1_000, value: 100, attrs: { answered_by: "you" } }],
    });
    expect(posted).toEqual([{ type: "ack", bytes: 0, records: 1, skipped: 0 }]);
    const page = db.query({ session: "sess", name: "cockpit.permission_answer" });
    expect(page.records[0]).toMatchObject({ signal: "log", value: 100, attrs: { answered_by: "you" } });
    expect(Object.values(page.sources)[0]).toMatchObject({ spawnId: "cockpit", resource: { "service.name": "cockpit" } });

    vi.spyOn(db, "ingest").mockImplementationOnce(() => {
      throw new Error("locked");
    });
    core.handle({ type: "ingest-local", sessionId: "sess", receivedMs: 1, records: [] });
    expect(posted[1]).toEqual({ type: "ack", bytes: 0, records: 0, skipped: 0, error: "locked" });
  });

  it("answers an Insights view by id", () => {
    core.handle({ type: "ingest", meta, body: bytes(logs("claude_code.user_prompt")) });
    core.handle({
      type: "insights",
      id: 3,
      query: { view: "activity", range: "24h", since: 0, until: 3_600_000, bucketMs: 3_600_000, tzOffsetMin: 0 },
    });
    // The prompt has no time of its own, so it is filed at its arrival, in the first hour.
    expect(posted[1]).toMatchObject({ type: "result", id: 3, result: { view: "activity", prompts: [1] } });
  });

  it("prunes on start and on a timer, one pass at a time", async () => {
    const steps = vi.spyOn(db, "pruneStep");
    // A pass already running is joined, not started twice.
    const first = core.prune();
    expect(core.prune()).toBe(first);
    await first;
    expect(steps).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      const stop = core.startPruning();
      await vi.advanceTimersByTimeAsync(0);
      expect(steps).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(steps).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(steps).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a pruning failure instead of crashing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    close();
    close = () => {};
    await core.prune();
    expect(error).toHaveBeenCalledWith("[telemetry] pruning failed:", expect.any(String));
    error.mockRestore();
  });
});
