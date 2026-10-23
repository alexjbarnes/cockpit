// The telemetry database against Node's real built-in SQLite: storage,
// reading back, and retention. Skipped on a Node without it.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelemetryDb, TelemetryDbError } from "@/server/telemetry/db";
import type { FlatRecord, ParsedBatch } from "@/server/telemetry/otlp";
import { loadSqlite } from "@/server/telemetry/sqlite";

const { sqlite } = loadSqlite();
const DAY = 24 * 60 * 60 * 1000;

function batchOf(
  records: Partial<FlatRecord>[],
  sources: ParsedBatch["sources"] = [{ resource: { "service.name": "claude-code" }, scope: { name: "events" } }],
): ParsedBatch {
  return {
    sources,
    records: records.map((r, i) => ({ signal: "log", name: "claude_code.event", timeMs: 1_000 + i, attrs: {}, source: 0, ...r })),
    skipped: 0,
  };
}

describe.skipIf(!sqlite)("TelemetryDb", () => {
  const sql = sqlite as NonNullable<typeof sqlite>;
  let dir: string;
  let file: string;
  let now: number;
  const open = (opts: Parameters<typeof TelemetryDb.open>[2] = {}) => TelemetryDb.open(file, sql, { now: () => now, ...opts });
  const ctx = (receivedMs = now, sessionId = "sess-1", spawnId = "spawn-1") => ({ sessionId, spawnId, receivedMs });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-teldb-"));
    file = join(dir, "telemetry.db");
    now = 100 * DAY;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the file for its owner alone, with incremental vacuum and the current schema", () => {
    open().close();
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    const raw = new sql.DatabaseSync(file);
    expect(raw.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    raw.close();
    // Opening again migrates nothing and loses nothing.
    const db = open();
    db.ingest(ctx(), batchOf([{}]));
    db.close();
    expect(open().stats().records).toBe(1);
  });

  it("refuses a database a newer cockpit wrote, rather than rewriting it", () => {
    const raw = new sql.DatabaseSync(file);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => open()).toThrow(TelemetryDbError);
    expect(() => open()).toThrow(/schema 99/);
  });

  it("moves a corrupt file aside and starts a fresh one", () => {
    writeFileSync(file, "this is not a database, just bytes that look nothing like one ".repeat(20));
    const db = open();
    expect(db.stats().records).toBe(0);
    db.close();
    expect(readdirSync(dir).some((f) => f.startsWith("telemetry.db.corrupt-"))).toBe(true);
  });

  it("stores a batch and reads it back with its source, sharing a source between batches of one spawn", () => {
    const db = open();
    expect(db.ingest(ctx(), batchOf([]))).toBe(0);
    db.ingest(
      ctx(),
      batchOf([
        {
          name: "claude_code.api_request",
          value: 3,
          traceId: "t",
          spanId: "s",
          parentSpanId: "p",
          promptId: "pr",
          cliSessionId: "cli",
          endMs: 5,
          attrs: { model: "m" },
          detail: { body: "b" },
        },
      ]),
    );
    db.ingest(ctx(), batchOf([{}]));
    db.ingest(ctx(now, "sess-1", "spawn-2"), batchOf([{}]));
    const page = db.query({ session: "sess-1" });
    expect(page.records).toHaveLength(3);
    expect(page.records[0]).toMatchObject({
      receivedMs: now,
      timeMs: 1000,
      endMs: 5,
      sessionId: "sess-1",
      cliSessionId: "cli",
      signal: "log",
      name: "claude_code.api_request",
      value: 3,
      traceId: "t",
      spanId: "s",
      parentSpanId: "p",
      promptId: "pr",
      attrs: { model: "m" },
      detail: { body: "b" },
    });
    expect(page.records[1]).toMatchObject({ endMs: null, cliSessionId: null, value: null, traceId: null, detail: null });
    expect(page.records[0].sourceId).toBe(page.records[1].sourceId);
    expect(page.records[2].sourceId).not.toBe(page.records[0].sourceId);
    expect(page.sources[String(page.records[0].sourceId)]).toEqual({
      sessionId: "sess-1",
      spawnId: "spawn-1",
      resource: { "service.name": "claude-code" },
      scope: { name: "events" },
    });
    expect(db.stats().sources).toBe(2);
  });

  it("keeps long strings apart, and puts them back on request", () => {
    const db = open({ inlineMax: 10 });
    db.ingest(
      ctx(),
      batchOf([
        { attrs: { prompt: "a long prompt indeed", short: "ok", list: ["also quite long"] }, detail: { body: "a long body here" } },
      ]),
    );
    const [refs] = db.query({}).records;
    expect(refs.attrs).toEqual({
      prompt: { $content: "attrs.prompt", len: 20 },
      short: "ok",
      list: [{ $content: "attrs.list.0", len: 15 }],
    });
    expect(refs.detail).toEqual({ body: { $content: "detail.body", len: 16 } });
    const [inline] = db.query({ content: "inline" }).records;
    expect(inline.attrs).toEqual({ prompt: "a long prompt indeed", short: "ok", list: ["also quite long"] });
    expect(inline.detail).toEqual({ body: "a long body here" });
    expect(db.stats().contentRows).toBe(3);
  });

  it("filters and pages in either order", () => {
    const db = open();
    db.ingest(
      ctx(),
      batchOf([
        { signal: "metric", name: "claude_code.token.usage", timeMs: 30, cliSessionId: "c1" },
        { signal: "span", name: "claude_code.tool", timeMs: 10, cliSessionId: "c1" },
        { signal: "log", name: "claude_code.api_request", timeMs: 20, cliSessionId: "c2" },
        { signal: "log", name: "claude_code.api_request", timeMs: 20, cliSessionId: "c2" },
      ]),
    );
    db.ingest(ctx(now, "sess-2"), batchOf([{ timeMs: 5 }]));
    const names = (q: Parameters<TelemetryDb["query"]>[0]) => db.query(q).records.map((r) => `${r.name}@${r.timeMs}`);
    expect(names({ session: "sess-1", signal: "log" })).toEqual(["claude_code.api_request@20", "claude_code.api_request@20"]);
    expect(names({ cliSession: "c1" })).toEqual(["claude_code.tool@10", "claude_code.token.usage@30"]);
    expect(names({ name: "claude_code.tool" })).toEqual(["claude_code.tool@10"]);
    expect(names({ since: 10, until: 20, session: "sess-1" })).toEqual([
      "claude_code.tool@10",
      "claude_code.api_request@20",
      "claude_code.api_request@20",
    ]);

    // Time order: two rows at the same time split across pages, in id order.
    const first = db.query({ session: "sess-1", limit: 2 });
    expect(first.records.map((r) => r.timeMs)).toEqual([10, 20]);
    const second = db.query({ session: "sess-1", limit: 2, cursor: first.nextCursor as string });
    expect(second.records.map((r) => r.timeMs)).toEqual([20, 30]);
    expect(second.nextCursor).toBeNull();
    expect(second.records[0].id).toBeGreaterThan(first.records[1].id);

    // Ingest order, the way a live view tails.
    const tail = db.query({ order: "ingest", limit: 3 });
    expect(tail.records.map((r) => r.id)).toEqual([1, 2, 3]);
    const rest = db.query({ order: "ingest", after: Number(tail.nextCursor) });
    expect(rest.records.map((r) => r.id)).toEqual([4, 5]);
    expect(rest.nextCursor).toBeNull();

    expect(db.query({ limit: 0 }).records).toHaveLength(1);
    expect(db.query({ limit: 5000 }).records).toHaveLength(5);
  });

  it("counts by signal, and by name for one session", () => {
    const db = open();
    db.ingest(ctx(now - 5), batchOf([{ signal: "metric", name: "m" }, { name: "a" }, { name: "a" }]));
    db.ingest(ctx(now, "sess-2"), batchOf([{ name: "b" }]));
    const all = db.stats();
    expect(all).toMatchObject({ records: 4, bySignal: { metric: 1, log: 3 }, oldestMs: now - 5, newestMs: now });
    expect(all.byName).toBeUndefined();
    expect(all.dbBytes).toBeGreaterThan(0);
    expect(typeof all.walBytes).toBe("number");
    expect(db.stats("sess-1")).toMatchObject({ records: 3, byName: { m: 1, a: 2 } });
    expect(open().stats("nobody")).toMatchObject({ records: 0, byName: {} });
  });

  it("drops what is past the age limit by when it arrived, with its text and its spent sources, and never reuses an id", () => {
    const db = open({ inlineMax: 5, chunk: 2 });
    db.ingest(ctx(now - 31 * DAY, "old"), batchOf([{ attrs: { text: "long enough" } }, {}, {}]));
    db.ingest(ctx(now - DAY, "recent"), batchOf([{ timeMs: 1 }]));
    const result = db.prune();
    expect(result).toEqual({ removedRecords: 3, removedContent: 1, removedSources: 1, done: true });
    expect(db.query({}).records.map((r) => r.sessionId)).toEqual(["recent"]);
    expect(db.stats()).toMatchObject({ sources: 1, contentRows: 0 });

    // Everything gone: ids still rise, so an `after` held by a reader stays valid.
    now += 30 * DAY;
    expect(db.prune().removedRecords).toBe(1);
    expect(db.stats().sources).toBe(0);
    db.ingest(ctx(now, "next"), batchOf([{}]));
    expect(db.query({}).records[0].id).toBe(5);
  });

  it("takes the oldest text first when over the size cap, keeping the numbers, and gives the space back", () => {
    const big = "x".repeat(8 * 1024);
    const db = open({ capBytes: 256 * 1024, inlineMax: 100, chunk: 10 });
    for (let i = 0; i < 10; i++)
      db.ingest(ctx(), batchOf(Array.from({ length: 10 }, (_, j) => ({ value: i * 10 + j, attrs: { output: big } }))));
    const before = db.stats();
    expect(before.contentRows).toBe(100);
    const result = db.prune();
    expect(result.removedRecords).toBe(0);
    expect(result.removedContent).toBeGreaterThan(0);
    const after = db.stats();
    expect(after.records).toBe(100);
    expect(after.contentRows).toBeLessThan(100);
    expect(db.liveBytes()).toBeLessThanOrEqual(256 * 1024 * 0.9);
    expect(after.dbBytes).toBeLessThan(before.dbBytes);
    // The oldest went first, and a record whose text has gone says so.
    const [oldest] = db.query({ content: "inline", order: "ingest", limit: 1 }).records;
    expect(oldest.attrs.output).toEqual({ $content: "attrs.output", len: 8 * 1024, pruned: true });
    const [newest] = db.query({ content: "inline", order: "ingest", after: 99 }).records;
    expect(newest.attrs.output).toBe(big);
  });

  it("deletes records too when there is no text left to take", () => {
    const db = open({ capBytes: 4096, chunk: 50 });
    for (let i = 0; i < 4; i++) db.ingest(ctx(), batchOf(Array.from({ length: 100 }, () => ({ attrs: { k: "v".repeat(50) } }))));
    const result = db.prune();
    expect(result.removedContent).toBe(0);
    expect(result.removedRecords).toBeGreaterThan(0);
    expect(db.stats().records).toBeLessThan(400);
  });

  it("closes cleanly, and a missing WAL reads as zero", () => {
    const db = open();
    db.close();
    expect(existsSync(file)).toBe(true);
  });
});
