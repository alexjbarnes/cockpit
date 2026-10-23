/**
 * The Insights API's answers: the telemetry worker's numbers for a view
 * (telemetry/insights-sql.ts), priced by the provider that served each
 * request and given the names cockpit knows its sessions by.
 *
 * Pricing happens here and not in the worker because prices are the
 * providers' current catalogue, read at request time and never stored, the
 * same rule cockpit's usage meter follows.
 */

import { effortLabel, projectForSession, purposeKey, purposeLabel } from "@/lib/insights/labels";
import { addMoney, cacheHitRate, emptyMoney, type PriceSource, priceUsage, totalTokens } from "@/lib/insights/pricing";
import { bucketIndex } from "@/lib/insights/stats";
import type {
  InsightsMoney,
  InsightsPayload,
  InsightsQuery,
  InsightsSeries,
  InsightsSessionLabel,
  InsightsSpend,
  InsightsSpendRow,
  InsightsTokens,
  InsightsTurnSummary,
  ModelSlots,
} from "@/types";

type InsightsTopTurn = InsightsSpend["topTurns"][number];
/** A payload before its session labels, view by view. */
type WithoutSessions<T> = T extends unknown ? Omit<T, "sessions"> : never;

import { loadProjects } from "./issue-storage";
import { loadJobs, loadRuns } from "./job-storage";
import { getProvider, modelRunsOnAnthropic, resolveProviderModel } from "./providers";
import { getSessionPrefs } from "./session-prefs";
import { getSessionManager, getTelemetry } from "./singleton";
import type { RawInsights, RawTurn, RawUsage } from "./telemetry/insights-sql";
import { scanSessionsByIds } from "./transcript";
import { TtlCache } from "./ttl-cache";

/** What a session is called and where it ran, before telemetry adds its models. */
export type SessionNaming = Pick<InsightsSessionLabel, "id" | "name" | "cwd" | "project" | "job">;

export interface InsightsDeps {
  nameSessions(ids: string[]): Promise<Map<string, SessionNaming>>;
  /** The provider that served a request: the one its spawn named, else the
   *  one the session's model settings point to, else the catalogue's guess. */
  providerFor(row: Pick<RawUsage, "session" | "model" | "provider">): string;
  priceSource(providerId: string, model: string): PriceSource;
}

function emptyTokens(): InsightsTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(into: InsightsTokens, more: InsightsTokens): InsightsTokens {
  into.input += more.input;
  into.output += more.output;
  into.cacheRead += more.cacheRead;
  into.cacheWrite += more.cacheWrite;
  return into;
}

class Assembler {
  readonly buckets: number[];
  private readonly unpriced = new Set<string>();

  constructor(
    private readonly q: InsightsQuery,
    private readonly deps: InsightsDeps,
  ) {
    this.buckets = [];
    for (let t = q.since; t < q.until; t += q.bucketMs) this.buckets.push(t);
  }

  price(row: RawUsage): InsightsMoney {
    const source = this.deps.priceSource(this.deps.providerFor(row), row.model);
    if (source.kind === "none") this.unpriced.add(row.model);
    return priceUsage(row.tokens, row.cliCost, row.requests, source);
  }

  unpricedModels(): string[] {
    return [...this.unpriced].sort();
  }

  bucketOf(t: number | undefined): number {
    return t === undefined ? -1 : bucketIndex(t, this.q.since, this.q.until, this.q.bucketMs);
  }

  /** Spend per bucket, a series per key, largest first. */
  spendSeries(rows: RawUsage[], key: (row: RawUsage) => string, label: (key: string) => string = (k) => k): InsightsSeries[] {
    const series = new Map<string, number[]>();
    for (const row of rows) {
      const i = this.bucketOf(row.bucket);
      if (i < 0) continue;
      const k = key(row);
      const values = series.get(k) ?? new Array(this.buckets.length).fill(0);
      values[i] += this.price(row).usd;
      series.set(k, values);
    }
    return [...series]
      .map(([k, values]) => ({ key: k, label: label(k), values: values as Array<number | null> }))
      .sort((a, b) => sum(b.values) - sum(a.values));
  }

  /** Spend, tokens and requests grouped by a key. */
  group(
    rows: RawUsage[],
    key: (row: RawUsage) => string | null,
  ): Map<string, { spend: InsightsMoney; tokens: InsightsTokens; requests: number; sessions: Set<string> }> {
    const out = new Map<string, { spend: InsightsMoney; tokens: InsightsTokens; requests: number; sessions: Set<string> }>();
    for (const row of rows) {
      const k = key(row);
      if (k === null) continue;
      const entry = out.get(k) ?? { spend: emptyMoney(), tokens: emptyTokens(), requests: 0, sessions: new Set<string>() };
      addMoney(entry.spend, this.price(row));
      addTokens(entry.tokens, row.tokens);
      entry.requests += row.requests;
      entry.sessions.add(row.session);
      out.set(k, entry);
    }
    return out;
  }

  turnSummary(turn: RawTurn): InsightsTurnSummary {
    const spend = emptyMoney();
    const tokens = emptyTokens();
    for (const row of turn.usage) {
      addMoney(spend, this.price(row));
      addTokens(tokens, row.tokens);
    }
    return {
      traceId: turn.traceId,
      startMs: turn.startMs,
      durationMs: turn.durationMs,
      prompt: turn.prompt,
      spend,
      tokens: totalTokens(tokens),
      requests: turn.requests,
      toolCalls: turn.toolCalls,
      errors: turn.errors,
      modelMs: turn.modelMs,
      toolsMs: turn.toolsMs,
      waitingMs: turn.waitingMs,
      otherMs: turn.otherMs,
    };
  }
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

function byMoney<T extends { spend: InsightsMoney; tokens: number }>(a: T, b: T): number {
  return b.spend.usd - a.spend.usd || b.tokens - a.tokens;
}

function spendRow(key: string, label: string, entry: { spend: InsightsMoney; tokens: InsightsTokens; requests: number }): InsightsSpendRow {
  return { key, label, spend: entry.spend, tokens: totalTokens(entry.tokens), requests: entry.requests };
}

/** Labels for the sessions a payload names: who they are (from cockpit) and
 *  what ran in them in range (from telemetry). */
async function labelSessions(ids: Iterable<string>, seen: RawUsage[], deps: InsightsDeps): Promise<Record<string, InsightsSessionLabel>> {
  const wanted = [...new Set(ids)];
  const names = await deps.nameSessions(wanted);
  const out: Record<string, InsightsSessionLabel> = {};
  for (const id of wanted) {
    const rows = seen.filter((row) => row.session === id);
    const naming = names.get(id) ?? { id, name: `Session ${id.slice(0, 8)}` };
    out[id] = {
      ...naming,
      models: [...new Set(rows.map((r) => r.model))].sort(),
      providers: [...new Set(rows.map((r) => deps.providerFor(r)))].sort(),
      ...(rows.length ? { firstMs: Math.min(...rows.map((r) => r.firstMs)), lastMs: Math.max(...rows.map((r) => r.lastMs)) } : {}),
    };
  }
  return out;
}

export async function assembleInsights(raw: RawInsights, q: InsightsQuery, deps: InsightsDeps): Promise<InsightsPayload> {
  const a = new Assembler(q, deps);
  const named = new Set<string>(q.session ? [q.session] : []);
  const base = { query: q, buckets: a.buckets };
  const finish = async (payload: WithoutSessions<InsightsPayload>): Promise<InsightsPayload> =>
    ({ ...payload, sessions: await labelSessions(named, raw.seen, deps) }) as InsightsPayload;

  switch (raw.view) {
    case "overview": {
      const spend = emptyMoney();
      const tokens = emptyTokens();
      let requests = 0;
      for (const row of raw.usage) {
        addMoney(spend, a.price(row));
        addTokens(tokens, row.tokens);
        requests += row.requests;
      }
      const topSessions = q.session
        ? []
        : [...a.group(raw.usage, (row) => row.session)]
            .map(([sessionId, e]) => ({
              sessionId,
              spend: e.spend,
              tokens: totalTokens(e.tokens),
              turns: raw.turnsBySession[sessionId] ?? 0,
            }))
            .sort(byMoney)
            .slice(0, 5);
      for (const s of topSessions) named.add(s.sessionId);
      return finish({
        ...base,
        view: "overview",
        totals: {
          spend,
          requests,
          tokens,
          cacheHitRate: cacheHitRate(tokens),
          turns: raw.turns,
          medianTurnMs: raw.medianTurnMs,
          toolCalls: raw.toolCalls,
          toolFailures: raw.toolFailures,
          waitingMs: raw.waitingMs,
          waits: raw.waits,
          apiErrors: raw.apiErrors,
          retries: raw.retries,
          linesAdded: raw.linesAdded,
          linesRemoved: raw.linesRemoved,
          prompts: raw.prompts,
        },
        spendByModel: a.spendSeries(raw.usage, (row) => row.model),
        topSessions,
      });
    }
    case "spend": {
      const tokenSeries: Record<keyof InsightsTokens, number[]> = {
        input: new Array(a.buckets.length).fill(0),
        output: new Array(a.buckets.length).fill(0),
        cacheRead: new Array(a.buckets.length).fill(0),
        cacheWrite: new Array(a.buckets.length).fill(0),
      };
      const perBucket = a.buckets.map(() => emptyTokens());
      for (const row of raw.usage) {
        const i = a.bucketOf(row.bucket);
        if (i < 0) continue;
        for (const k of Object.keys(tokenSeries) as Array<keyof InsightsTokens>) tokenSeries[k][i] += row.tokens[k];
        addTokens(perBucket[i], row.tokens);
      }
      const labels = await labelSessions(new Set(raw.usage.map((r) => r.session)), raw.seen, deps);
      const sessions = [...a.group(raw.usage, (row) => row.session)].map(([sessionId, e]) => ({
        ...spendRow(sessionId, labels[sessionId]?.name ?? sessionId, e),
        sessionId,
        turns: raw.turnsBySession[sessionId] ?? 0,
      }));
      const projects = [...a.group(raw.usage, (row) => labels[row.session]?.project?.key ?? null)].map(([key, e]) => ({
        ...spendRow(key, Object.values(labels).find((l) => l.project?.key === key)?.project?.label ?? key, e),
        sessions: e.sessions.size,
      }));
      const jobs = [...a.group(raw.usage, (row) => labels[row.session]?.job?.id ?? null)].map(([key, e]) => ({
        ...spendRow(key, Object.values(labels).find((l) => l.job?.id === key)?.job?.name ?? key, e),
        sessions: e.sessions.size,
      }));
      // A turn can use more than one model: its rows are summed by prompt.
      const turns = new Map<string, InsightsTopTurn>();
      for (const row of raw.turns) {
        const entry = turns.get(row.promptId) ?? {
          sessionId: row.session,
          traceId: row.traceId,
          timeMs: row.timeMs,
          prompt: row.prompt,
          spend: emptyMoney(),
          tokens: 0,
        };
        addMoney(entry.spend, a.price(row));
        entry.tokens += totalTokens(row.tokens);
        entry.timeMs = Math.min(entry.timeMs, row.timeMs);
        turns.set(row.promptId, entry);
      }
      const topTurns = [...turns.values()].sort(byMoney).slice(0, 10);
      for (const s of sessions) named.add(s.sessionId);
      for (const t of topTurns) named.add(t.sessionId);
      return finish({
        ...base,
        view: "spend",
        byModel: a.spendSeries(raw.usage, (row) => row.model),
        byProvider: a.spendSeries(
          raw.usage,
          (row) => deps.providerFor(row),
          (id) => getProviderName(id),
        ),
        tokens: [
          { key: "input", label: "Input", values: tokenSeries.input },
          { key: "output", label: "Output", values: tokenSeries.output },
          { key: "cacheRead", label: "Cache reads", values: tokenSeries.cacheRead },
          { key: "cacheWrite", label: "Cache writes", values: tokenSeries.cacheWrite },
        ],
        cacheHitRate: perBucket.map((t) => cacheHitRate(t)),
        purposes: [...a.group(raw.usage, (row) => purposeKey(row.purpose))]
          .map(([key, e]) => spendRow(key, purposeLabel(key), e))
          .sort(byMoney),
        efforts: [...a.group(raw.usage, (row) => row.effort ?? "default")]
          .map(([key, e]) => spendRow(key, effortLabel(key === "default" ? null : key), e))
          .sort(byMoney),
        rankedSessions: sessions.sort(byMoney),
        rankedProjects: projects.sort(byMoney),
        rankedJobs: jobs.sort(byMoney),
        topTurns,
        unpricedModels: a.unpricedModels(),
      });
    }
    case "speed":
      return finish({
        ...base,
        view: "speed",
        models: raw.models,
        ttftTrend: raw.ttftTrend.map((t) => ({ key: t.model, label: t.model, values: t.values })),
        turnDurations: raw.turnDurations,
        turnTime: raw.turnTime,
      });
    case "tools":
      for (const c of raw.slowestCommands) named.add(c.sessionId);
      return finish({
        ...base,
        view: "tools",
        tools: raw.tools,
        programs: raw.programs,
        slowestCommands: raw.slowestCommands,
        mcpServers: raw.mcpServers,
        files: raw.files,
        waiting: raw.waiting,
      });
    case "health":
      for (const f of raw.toolFailures) for (const r of f.recent) named.add(r.sessionId);
      return finish({
        ...base,
        view: "health",
        apiErrors: raw.apiErrors,
        errorsByBucket: raw.errorsByBucket.map((e) => ({ key: e.model, label: e.model, values: e.values })),
        retries: raw.retries,
        toolFailures: raw.toolFailures,
        mcpServers: raw.mcpServers,
        hooks: raw.hooks,
      });
    case "activity":
      return finish({
        ...base,
        view: "activity",
        lines: [
          { key: "added", label: "Added", values: raw.lines.added },
          { key: "removed", label: "Removed", values: raw.lines.removed },
        ],
        linesTotal: { added: sum(raw.lines.added), removed: sum(raw.lines.removed) },
        editsByLanguage: raw.editsByLanguage,
        commits: raw.commits,
        pullRequests: raw.pullRequests,
        prompts: [{ key: "prompts", label: "Prompts", values: raw.prompts }],
        heatmap: raw.heatmap,
      });
    case "turns":
      return finish({ ...base, view: "turns", turns: raw.turns.map((t) => a.turnSummary(t)) });
    case "turn":
      return finish({
        ...base,
        view: "turn",
        turn: raw.turn
          ? {
              ...a.turnSummary(raw.turn),
              rows: raw.turn.rows.map(({ usage, ...row }) => (usage ? { ...row, spend: a.price(usage) } : row)),
            }
          : null,
      });
    case "context":
      return finish({ ...base, view: "context", points: raw.points });
  }
}

function getProviderName(id: string): string {
  return getProvider(id)?.name ?? id;
}

/** The provider a model id names in a cockpit model setting (`provider:model`). */
function providerIn(setting: string | undefined, model: string): string | undefined {
  if (!setting) return undefined;
  const colon = setting.indexOf(":");
  if (colon <= 0) return undefined;
  return setting.slice(colon + 1).replace(/\[.*\]$/, "") === model ? setting.slice(0, colon) : undefined;
}

const namingCache = new TtlCache<SessionNaming>();
const jobCache = new TtlCache<Map<string, { id: string; name: string; cwd: string }>>();
const NAMING_TTL_MS = 60_000;

/** Every scheduled job's runs, by the session each ran in. */
function jobsBySession(): Map<string, { id: string; name: string; cwd: string }> {
  const cached = jobCache.get("all");
  if (cached) return cached;
  const out = new Map<string, { id: string; name: string; cwd: string }>();
  for (const job of loadJobs()) {
    for (const run of loadRuns(job.id)) {
      if (run.sessionId) out.set(run.sessionId, { id: job.id, name: job.name, cwd: run.cwd });
    }
  }
  jobCache.set("all", out, NAMING_TTL_MS);
  return out;
}

export function defaultInsightsDeps(): InsightsDeps {
  return {
    async nameSessions(ids) {
      const out = new Map<string, SessionNaming>();
      const missing = ids.filter((id) => {
        const cached = namingCache.get(id);
        if (cached) out.set(id, cached);
        return !cached;
      });
      if (missing.length === 0) return out;
      const manager = getSessionManager();
      const live = new Map(manager.listKnownSessions().map((s) => [s.id, s]));
      const unknown = missing.filter((id) => !live.has(id));
      const scanned = new Map((await scanSessionsByIds(unknown)).map((s) => [s.id, s]));
      const jobs = jobsBySession();
      const projects = loadProjects();
      for (const id of missing) {
        const info = live.get(id) ?? scanned.get(id);
        const job = jobs.get(id);
        const cwd = info?.cwd || job?.cwd || undefined;
        const project = projectForSession(projects, cwd);
        const naming: SessionNaming = {
          id,
          // A job run's transcript name is its prompt, so the job's own name goes first.
          name: getSessionPrefs(id)?.name || (job ? `[job] ${job.name}` : info?.name) || `Session ${id.slice(0, 8)}`,
          ...(cwd ? { cwd } : {}),
          ...(project ? { project } : {}),
          ...(job ? { job: { id: job.id, name: job.name } } : {}),
        };
        namingCache.set(id, naming, NAMING_TTL_MS);
        out.set(id, naming);
      }
      return out;
    },
    providerFor(row) {
      if (row.provider) return row.provider;
      const prefs = getSessionPrefs(row.session);
      const slots: ModelSlots = prefs?.modelSlots ?? {};
      for (const setting of [
        prefs?.model,
        slots.main,
        slots.subagent,
        slots.fast,
        getSessionManager().getSessionModel(row.session) ?? undefined,
      ]) {
        const found = providerIn(setting, row.model);
        if (found) return found;
      }
      if (modelRunsOnAnthropic(row.model)) return "anthropic";
      return resolveProviderModel(row.model)?.provider.id ?? "unknown";
    },
    priceSource(providerId, model) {
      if (providerId === "anthropic") return { kind: "cli" };
      const entry = getProvider(providerId)?.models.find((m) => m.modelId === model);
      if (entry?.free) return { kind: "free" };
      if (entry?.pricing) return { kind: "catalogue", pricing: entry.pricing };
      return { kind: "none" };
    },
  };
}

/** One view for the API route; null when cockpit has no telemetry service. */
export async function getInsights(q: InsightsQuery, deps: InsightsDeps = defaultInsightsDeps()): Promise<InsightsPayload | null> {
  const telemetry = getTelemetry();
  if (!telemetry) return null;
  return assembleInsights(await telemetry.insights(q), q, deps);
}
