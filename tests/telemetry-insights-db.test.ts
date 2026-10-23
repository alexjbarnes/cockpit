// The Insights views against Node's real SQLite, on a seeded store whose
// numbers are all known (tests/fixtures/insights-seed.ts), and on a real
// protobuf capture from the CLI. Skipped on a Node without SQLite.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseInsightsQuery } from "@/lib/insights/query";
import { TelemetryDb } from "@/server/telemetry/db";
import type { RawInsights } from "@/server/telemetry/insights-sql";
import { parseOtlp } from "@/server/telemetry/otlp";
import { decodeOtlpProtobuf } from "@/server/telemetry/otlp-proto";
import { loadSqlite } from "@/server/telemetry/sqlite";
import type { InsightsView } from "@/types";
import { SEED, seedInsightsDb, seedTimes } from "./fixtures/insights-seed";

const { sqlite } = loadSqlite();
// Noon UTC, so the seed's day-old session sits outside a 24-hour range.
const NOW = Date.UTC(2026, 9, 21, 12);

describe.skipIf(!sqlite)("Insights views", () => {
  let dir: string;
  let db: TelemetryDb;

  const view = <V extends RawInsights["view"]>(v: V, extra: Record<string, string> = {}): Extract<RawInsights, { view: V }> => {
    const parsed = parseInsightsQuery(new URLSearchParams({ view: v, range: "7d", tz: "0", ...extra }), NOW);
    if ("error" in parsed) throw new Error(parsed.error);
    return db.insights(parsed.query) as Extract<RawInsights, { view: V }>;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-insights-"));
    const file = join(dir, "telemetry.db");
    seedInsightsDb(file, sqlite as NonNullable<typeof sqlite>, NOW);
    db = TelemetryDb.open(file, sqlite as NonNullable<typeof sqlite>, { now: () => NOW });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("totals a range, with who answered and what the spawns named", () => {
    const o = view("overview");
    expect(o).toMatchObject({
      turns: 3,
      medianTurnMs: 20_000,
      toolCalls: 3,
      toolFailures: 1,
      waitingMs: 8_000,
      waits: 1,
      apiErrors: 1,
      retries: 1,
      linesAdded: 30,
      linesRemoved: 5,
      prompts: 3,
      turnsBySession: { [SEED.anthropic.id]: 1, [SEED.catalogue.id]: 1, [SEED.unpriced.id]: 1 },
    });
    const bySession = Object.fromEntries(o.seen.map((r) => [r.session, r]));
    expect(bySession[SEED.anthropic.id]).toMatchObject({ provider: "anthropic", model: SEED.anthropic.model, requests: 2, cliCost: 1.5 });
    expect(bySession[SEED.anthropic.id].tokens).toEqual({ input: 3_000, output: 1_500, cacheRead: 19_000, cacheWrite: 1_000 });
    // Not stamped: the server finds its provider from the session's settings.
    expect(bySession[SEED.catalogue.id]).toMatchObject({ provider: null, requests: 2 });
    expect(bySession[SEED.unpriced.id]).toMatchObject({ provider: "seed-noprice", requests: 1 });
    // Each request lands in the day it was made, on the viewer's clock.
    const day = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;
    const times = seedTimes(NOW);
    expect(o.usage.find((r) => r.session === SEED.catalogue.id)?.bucket).toBe(day(times.catalogue));
    expect(o.usage.find((r) => r.session === SEED.anthropic.id)?.bucket).toBe(day(times.anthropic));
  });

  it("keeps a day-old session out of the last 24 hours", () => {
    const o = view("overview", { range: "24h" });
    expect(o.turns).toBe(2);
    expect(o.seen.map((r) => r.session).sort()).toEqual([SEED.anthropic.id, SEED.unpriced.id].sort());
    expect(view("overview", { session: SEED.catalogue.id }).turns).toBe(1);
  });

  it("breaks spend down by purpose and effort, and by turn with its prompt", () => {
    const s = view("spend");
    const title = s.usage.find((r) => r.purpose === "generate_session_title");
    expect(title).toMatchObject({ session: SEED.catalogue.id, effort: "max", requests: 1, cliCost: 0.001 });
    const turns = Object.fromEntries(s.turns.map((t) => [t.promptId, t]));
    expect(turns["p-a1"]).toMatchObject({ prompt: "Fix the login bug", traceId: SEED.anthropic.trace, requests: 2, cliCost: 1.5 });
    expect(turns["p-b1"]).toMatchObject({ prompt: "Summarise the inbox", requests: 2 });
    expect(turns["p-c1"]).toMatchObject({ prompt: "Hello", provider: "seed-noprice" });
  });

  it("measures each model and where turns' time went, counting a wait once and parallel tools once", () => {
    const s = view("speed");
    const opus = s.models.find((m) => m.model === SEED.anthropic.model);
    expect(opus).toMatchObject({ requests: 2, errors: 1, providers: ["anthropic"] });
    expect(opus?.ttft).toEqual({ count: 2, p50: 2_500, p90: 2_900 });
    expect(opus?.response.p50).toBe(19_000);
    expect(opus?.outputTps).toBeCloseTo((62.5 + 40) / 2);
    expect(s.models.map((m) => m.model)).toContain(SEED.unpriced.model);
    expect(s.turnTime).toEqual({ turns: 3, waitingMs: 8_090, toolsMs: 11_910, modelMs: 46_000, otherMs: 24_000 });
    expect(s.turnDurations.map((b) => b.count)).toEqual([0, 2, 0, 1, 0, 0, 0, 0]);
    expect(s.ttftTrend.find((t) => t.model === SEED.anthropic.model)?.values.filter((v) => v !== null)).toEqual([2_500]);
  });

  it("ranks tools, programs, MCP servers and files, and says who answered", () => {
    const t = view("tools");
    expect(Object.fromEntries(t.tools.map((x) => [x.name, [x.calls, x.failures]]))).toEqual({
      Bash: [1, 1],
      Read: [1, 0],
      mcp__gmail__read_email: [1, 0],
    });
    expect(t.programs).toEqual([{ name: "npm", calls: 1, failures: 1, p90Ms: 18_000, totalMs: 18_000 }]);
    expect(t.slowestCommands[0]).toMatchObject({ command: "npm test", durationMs: 18_000, sessionId: SEED.anthropic.id, success: false });
    expect(t.mcpServers).toEqual([{ server: "gmail", calls: 1, failures: 0, totalMs: 1_000, tools: [{ name: "read_email", calls: 1 }] }]);
    expect(t.files).toEqual([{ path: "/repo/src/app.ts", touches: 1, edits: 0 }]);
    expect(t.waiting).toEqual({
      byTool: [{ tool: "Bash", waits: 1, totalMs: 8_000, p50Ms: 8_000 }],
      answeredBy: { you: 1, bypass: 1 },
      allowed: 1,
      denied: 0,
      totalMs: 8_000,
      rulesApproved: 1,
    });
  });

  it("lists errors, retries, failing tools, MCP connections and hook time", () => {
    const h = view("health");
    expect(h.apiErrors).toEqual([
      { model: SEED.anthropic.model, status: "529", count: 1, lastMessage: "Overloaded", lastMs: seedTimes(NOW).anthropic + 31_000 },
    ]);
    expect(h.errorsByBucket).toHaveLength(1);
    expect(h.errorsByBucket[0].values.reduce((a, b) => a + b, 0)).toBe(1);
    expect(h.retries).toEqual([{ model: SEED.anthropic.model, retries: 1, requests: 2 }]);
    expect(h.toolFailures).toMatchObject([
      { tool: "Bash", failures: 1, calls: 1, recent: [{ detail: "npm test", sessionId: SEED.anthropic.id }] },
    ]);
    expect(h.mcpServers.map((m) => [m.server, m.attempts, m.failures, m.lastStatus])).toEqual([
      ["broken", 1, 1, "failed"],
      ["gmail", 1, 0, "connected"],
    ]);
    expect(h.hooks).toEqual([{ event: "PreToolUse", runs: 1, totalMs: 50, p90Ms: 50, maxMs: 50, blocking: 0, errors: 0 }]);
  });

  it("counts lines, edits by language, commits and prompts by weekday and hour", () => {
    const a = view("activity");
    expect(a.lines.added.reduce((x, y) => x + y, 0)).toBe(30);
    expect(a.lines.removed.reduce((x, y) => x + y, 0)).toBe(5);
    expect(a.editsByLanguage).toEqual([{ language: "TypeScript", accepted: 2, rejected: 1 }]);
    expect(a.commits).toBe(1);
    expect(a.pullRequests).toBe(0);
    expect(a.prompts.reduce((x, y) => x + y, 0)).toBe(3);
    // 2026-10-21 is a Wednesday: two sessions prompted in the 10:00 hour,
    // the third the day before at noon.
    expect(a.heatmap[2][10]).toBe(2);
    expect(a.heatmap[1][12]).toBe(1);
    expect(a.heatmap.flat().reduce((x, y) => x + y, 0)).toBe(3);
  });

  it("lists a session's turns with where each one's time went", () => {
    const t = view("turns", { session: SEED.anthropic.id });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({
      traceId: SEED.anthropic.trace,
      durationMs: 60_000,
      prompt: "Fix the login bug",
      requests: 2,
      toolCalls: 1,
      errors: 2,
      waitingMs: 8_000,
      toolsMs: 10_000,
      modelMs: 38_000,
      otherMs: 4_000,
    });
    expect(t.turns[0].usage).toMatchObject([{ model: SEED.anthropic.model, requests: 2, cliCost: 1.5 }]);
  });

  it("lays one turn out request by request, pairing each with Claude Code's cost for it", () => {
    const { turn } = view("turn", { session: SEED.anthropic.id, turn: SEED.anthropic.trace });
    expect(turn?.rows.map((r) => [r.kind, r.label])).toEqual([
      ["request", SEED.anthropic.model],
      ["tool", "Bash"],
      ["hook", "PreToolUse"],
      ["request", SEED.anthropic.model],
    ]);
    const [first, tool, , second] = turn?.rows ?? [];
    expect(first.usage?.cliCost).toBe(0.5);
    expect(second.usage?.cliCost).toBe(1);
    expect(second.attempt).toBe(2);
    expect(tool).toMatchObject({ detail: "npm test", success: false });
    expect(tool.segments.map((s) => [s.kind, s.endMs - s.startMs])).toEqual([
      ["waiting", 8_000],
      ["running", 10_000],
    ]);
    expect(view("turn", { session: SEED.anthropic.id, turn: "f".repeat(32) }).turn).toBeNull();
  });

  it("follows a session's context request by request", () => {
    const c = view("context", { session: SEED.anthropic.id });
    expect(c.points.map((p) => [p.tokens, p.compaction])).toEqual([
      [10_000, false],
      [13_000, false],
    ]);
  });

  it("reads every view from a real CLI capture without tripping on its shapes", () => {
    const capture = JSON.parse(readFileSync(join(__dirname, "fixtures/otlp-protobuf-capture.json"), "utf8")) as Record<string, string>;
    const now = Date.now();
    for (const kind of ["traces", "logs", "metrics"] as const) {
      const payload = decodeOtlpProtobuf(kind, Buffer.from(capture[kind], "base64"));
      db.ingest({ sessionId: "capture", spawnId: "capture-spawn", receivedMs: now }, parseOtlp(kind, payload, now));
    }
    const parsed = parseInsightsQuery(new URLSearchParams({ view: "overview", range: "30d", session: "capture" }), now);
    if ("error" in parsed) throw new Error(parsed.error);
    const views: InsightsView[] = ["overview", "spend", "speed", "tools", "health", "activity", "turns", "context"];
    for (const v of views) expect(() => db.insights({ ...parsed.query, view: v })).not.toThrow();
    const overview = db.insights({ ...parsed.query, view: "overview" }) as Extract<RawInsights, { view: "overview" }>;
    expect(overview.turns).toBeGreaterThan(0);
    expect(overview.seen[0]?.requests).toBeGreaterThan(0);
    const tools = db.insights({ ...parsed.query, view: "tools" }) as Extract<RawInsights, { view: "tools" }>;
    expect(tools.tools.map((t) => t.name)).toContain("Bash");
  });
});
