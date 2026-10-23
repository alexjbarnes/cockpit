// The Insights API's answers: the worker's numbers for the seeded store
// (tests/fixtures/insights-seed.ts), priced by provider and labelled. The
// assembly runs with fake lookups; the real lookups run against a config dir
// holding the seed's providers and session prefs.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseInsightsQuery } from "@/lib/insights/query";
import { assembleInsights, defaultInsightsDeps, getInsights, type InsightsDeps } from "@/server/insights";
import { TelemetryDb } from "@/server/telemetry/db";
import type { RawInsights } from "@/server/telemetry/insights-sql";
import { loadSqlite } from "@/server/telemetry/sqlite";
import type {
  InsightsOverview,
  InsightsPayload,
  InsightsQuery,
  InsightsSpend,
  InsightsTools,
  InsightsTurn,
  InsightsTurns,
  InsightsView,
} from "@/types";
import { SEED, SEED_PREFS, SEED_PROVIDERS, seedInsightsDb } from "./fixtures/insights-seed";

const live = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; name: string; cwd: string }>,
  models: {} as Record<string, string>,
  telemetry: null as null | { insights: (q: unknown) => Promise<unknown> },
}));

vi.mock("@/server/singleton", () => ({
  getSessionManager: () => ({
    listKnownSessions: () => live.sessions,
    getSessionModel: (id: string) => live.models[id] ?? null,
  }),
  getTelemetry: () => live.telemetry,
}));

const configDir = mkdtempSync(join(tmpdir(), "cockpit-insights-config-"));
process.env.COCKPIT_CONFIG_DIR = configDir;

const { sqlite } = loadSqlite();
const NOW = Date.UTC(2026, 9, 21, 12);
const CHEAP = (100_000 * 1 + 400_000 * 0.1 + 2_000 * 2 + 100 * 1 + 10 * 2) / 1e6;

function query(view: InsightsView, extra: Record<string, string> = {}): InsightsQuery {
  const parsed = parseInsightsQuery(new URLSearchParams({ view, range: "7d", tz: "0", ...extra }), NOW);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.query;
}

const fakeDeps: InsightsDeps = {
  async nameSessions(ids) {
    const names: Record<string, string> = {
      [SEED.anthropic.id]: SEED.anthropic.name,
      [SEED.catalogue.id]: SEED.catalogue.name,
      [SEED.unpriced.id]: SEED.unpriced.name,
    };
    return new Map(ids.map((id) => [id, { id, name: names[id] ?? id, project: { key: "p", label: "cockpit" } }]));
  },
  providerFor: (row) => row.provider ?? (row.session === SEED.catalogue.id ? SEED.catalogue.provider : "anthropic"),
  priceSource: (provider) =>
    provider === "anthropic"
      ? { kind: "cli" }
      : provider === SEED.catalogue.provider
        ? { kind: "catalogue", pricing: SEED.pricing }
        : { kind: "none" },
};

describe.skipIf(!sqlite)("Insights payloads", () => {
  let dir: string;
  let db: TelemetryDb;
  const raw = (q: InsightsQuery) => db.insights(q) as RawInsights;
  const payload = async <T extends InsightsPayload>(view: InsightsView, extra: Record<string, string> = {}, deps = fakeDeps) => {
    const q = query(view, extra);
    return (await assembleInsights(raw(q), q, deps)) as T;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cockpit-insights-db-"));
    seedInsightsDb(join(dir, "telemetry.db"), sqlite as NonNullable<typeof sqlite>, NOW);
    db = TelemetryDb.open(join(dir, "telemetry.db"), sqlite as NonNullable<typeof sqlite>, { now: () => NOW });
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("prices each provider its own way: Anthropic at API prices, a catalogue's own prices, an unpriced model never as free", async () => {
    const o = await payload<InsightsOverview>("overview");
    expect(o.totals.spend.usd).toBeCloseTo(1.5 + CHEAP);
    expect(o.totals.spend.apiEquivalentUsd).toBeCloseTo(1.5);
    expect(o.totals.spend.unpricedRequests).toBe(1);
    expect(o.totals.requests).toBe(5);
    expect(o.totals.cacheHitRate).toBeCloseTo(419_000 / (103_150 + 419_000 + 1_000));
    expect(o.topSessions.map((s) => s.sessionId)).toEqual([SEED.anthropic.id, SEED.catalogue.id, SEED.unpriced.id]);
    expect(o.topSessions[1].spend.usd).toBeCloseTo(CHEAP);
    expect(o.sessions[SEED.catalogue.id]).toMatchObject({
      name: SEED.catalogue.name,
      providers: [SEED.catalogue.provider],
      models: [SEED.catalogue.model],
    });
    // Spend by model, bucket by bucket, adds back up to the total.
    const sum = o.spendByModel.flatMap((s) => s.values).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(sum).toBeCloseTo(1.5 + CHEAP);
    expect(o.buckets).toHaveLength(7);
  });

  it("names no top sessions when narrowed to one, but labels that one", async () => {
    const o = await payload<InsightsOverview>("overview", { session: SEED.anthropic.id });
    expect(o.topSessions).toEqual([]);
    expect(Object.keys(o.sessions)).toEqual([SEED.anthropic.id]);
    expect(o.sessions[SEED.anthropic.id]).toMatchObject({
      providers: ["anthropic"],
      firstMs: expect.any(Number),
      lastMs: expect.any(Number),
    });
  });

  it("splits spend by model, provider, purpose, effort, session, project and job, and ranks turns", async () => {
    const s = await payload<InsightsSpend>("spend");
    const total = (key: string, series: InsightsSpend["byModel"]) =>
      series.find((x) => x.key === key)?.values.reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total(SEED.anthropic.model, s.byModel)).toBeCloseTo(1.5);
    expect(total(SEED.catalogue.model, s.byModel)).toBeCloseTo(CHEAP);
    expect(s.byProvider.map((x) => x.key).sort()).toEqual(["anthropic", SEED.catalogue.provider, SEED.unpriced.provider].sort());
    expect(s.tokens.map((x) => x.key)).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
    expect(s.purposes.map((p) => p.label)).toEqual(["Conversation", "Session titles"]);
    expect(s.efforts.map((e) => e.label)).toEqual(["High", "Max", "Low"]);
    expect(s.rankedSessions.map((r) => [r.sessionId, r.turns])).toEqual([
      [SEED.anthropic.id, 1],
      [SEED.catalogue.id, 1],
      [SEED.unpriced.id, 1],
    ]);
    expect(s.rankedProjects).toEqual([expect.objectContaining({ key: "p", label: "cockpit", sessions: 3 })]);
    expect(s.rankedJobs).toEqual([]);
    expect(s.topTurns.map((t) => t.prompt)).toEqual(["Fix the login bug", "Summarise the inbox", "Hello"]);
    expect(s.topTurns[1].spend.usd).toBeCloseTo(CHEAP);
    expect(s.unpricedModels).toEqual([SEED.unpriced.model]);
    // Two days had requests: the day-old session, and the two from today.
    expect(s.cacheHitRate.filter((v) => v !== null)).toHaveLength(2);
  });

  it("passes the other views through with the sessions they name", async () => {
    const tools = await payload<InsightsTools>("tools");
    expect(Object.keys(tools.sessions)).toEqual([SEED.anthropic.id]);
    const health = await payload("health");
    expect(health.view === "health" && health.errorsByBucket[0].key).toBe(SEED.anthropic.model);
    const activity = await payload("activity");
    expect(activity.view === "activity" && activity.linesTotal).toEqual({ added: 30, removed: 5 });
    const speed = await payload("speed");
    expect(speed.view === "speed" && speed.ttftTrend.map((t) => t.label)).toContain(SEED.anthropic.model);
    const context = await payload("context", { session: SEED.anthropic.id });
    expect(context.view === "context" && context.points).toHaveLength(2);
  });

  it("prices each turn and each request in a turn's timeline", async () => {
    const turns = await payload<InsightsTurns>("turns", { session: SEED.catalogue.id });
    expect(turns.turns[0].spend.usd).toBeCloseTo(CHEAP);
    const turn = await payload<InsightsTurn>("turn", { session: SEED.anthropic.id, turn: SEED.anthropic.trace });
    expect(turn.turn?.spend).toMatchObject({ usd: 1.5, apiEquivalentUsd: 1.5 });
    expect(turn.turn?.rows.filter((r) => r.kind === "request").map((r) => r.spend?.usd)).toEqual([0.5, 1]);
    expect(turn.turn?.rows.some((r) => "usage" in r)).toBe(false);
    const missing = await payload<InsightsTurn>("turn", { session: SEED.anthropic.id, turn: "e".repeat(32) });
    expect(missing.turn).toBeNull();
  });

  it("looks sessions, providers and prices up in cockpit's own config", async () => {
    writeFileSync(join(configDir, "providers.json"), JSON.stringify(SEED_PROVIDERS));
    writeFileSync(join(configDir, "session-prefs.json"), JSON.stringify(SEED_PREFS));
    live.sessions = [{ id: SEED.anthropic.id, name: "live name", cwd: "/home/dev/repos/cockpit-CK-9" }];
    const deps = defaultInsightsDeps();

    // Stamped, from prefs, from the live session's model, Anthropic's own, a catalogue's guess.
    expect(deps.providerFor({ session: "x", model: "m", provider: "zen-go" })).toBe("zen-go");
    expect(deps.providerFor({ session: SEED.catalogue.id, model: SEED.catalogue.model, provider: null })).toBe(SEED.catalogue.provider);
    live.models["live-1"] = `${SEED.unpriced.provider}:${SEED.unpriced.model}`;
    expect(deps.providerFor({ session: "live-1", model: SEED.unpriced.model, provider: null })).toBe(SEED.unpriced.provider);
    expect(deps.providerFor({ session: "nobody", model: "some-unlisted-model", provider: null })).toBe("anthropic");
    expect(deps.providerFor({ session: "nobody", model: SEED.catalogue.model, provider: null })).toBe(SEED.catalogue.provider);

    expect(deps.priceSource("anthropic", "claude-opus-5-5")).toEqual({ kind: "cli" });
    expect(deps.priceSource(SEED.catalogue.provider, SEED.catalogue.model)).toEqual({ kind: "catalogue", pricing: SEED.pricing });
    expect(deps.priceSource(SEED.unpriced.provider, SEED.unpriced.model)).toEqual({ kind: "none" });
    expect(deps.priceSource("gone", "m")).toEqual({ kind: "none" });

    const names = await deps.nameSessions([SEED.anthropic.id, SEED.catalogue.id, "unknown-session-1"]);
    // Prefs name first; the cwd from the live session; a worktree's repo as its project.
    expect(names.get(SEED.anthropic.id)).toMatchObject({
      name: SEED.anthropic.name,
      cwd: "/home/dev/repos/cockpit-CK-9",
      project: { label: "cockpit" },
    });
    expect(names.get(SEED.catalogue.id)).toMatchObject({ name: SEED.catalogue.name });
    expect(names.get("unknown-session-1")).toMatchObject({ name: "Session unknown-" });
    // Cached: a second call answers without the live session list.
    live.sessions = [];
    expect((await deps.nameSessions([SEED.anthropic.id])).get(SEED.anthropic.id)?.cwd).toBe("/home/dev/repos/cockpit-CK-9");
  });

  it("answers the route through the telemetry service, or not at all without one", async () => {
    live.telemetry = null;
    expect(await getInsights(query("overview"), fakeDeps)).toBeNull();
    live.telemetry = { insights: async (q) => db.insights(q as InsightsQuery) };
    const o = (await getInsights(query("overview"), fakeDeps)) as InsightsOverview;
    expect(o.totals.turns).toBe(3);
  });
});
