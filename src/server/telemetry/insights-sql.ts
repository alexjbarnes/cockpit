/**
 * The Insights views, as the telemetry worker computes them: grouped numbers
 * straight from the records, with percentiles and turn breakdowns worked out
 * here so only small results cross to the server's thread. Nothing here
 * prices anything or names a session: spend depends on the provider's
 * catalogue and labels on cockpit's session store, both of which live on the
 * server's side (src/server/insights.ts).
 *
 * Claude Code writes a request's numbers three times (the api_request event,
 * the llm_request span, the token and cost metrics). Spend and tokens come
 * from the event alone, which is the one that carries cost and purpose.
 */

import { mcpTool } from "@/lib/insights/labels";
import { durations, histogram, type Interval, percentile, TURN_DURATION_EDGES, turnBreakdown } from "@/lib/insights/stats";
import type { InsightsDurations, InsightsQuery, InsightsTimelineRow, InsightsTokens } from "@/types";

type Param = string | number | null;
type Row = Record<string, unknown>;
export type Select = (sql: string, ...params: Param[]) => Row[];

/** Some requests' tokens and Claude Code's cost for them, for one session,
 *  model and provider (null when the spawn named none). */
export interface RawUsage {
  session: string;
  model: string;
  provider: string | null;
  requests: number;
  tokens: InsightsTokens;
  cliCost: number;
  firstMs: number;
  lastMs: number;
  bucket?: number;
  purpose?: string | null;
  effort?: string | null;
}

export interface RawTurnUsage extends RawUsage {
  traceId: string | null;
  promptId: string;
  timeMs: number;
  prompt: string | null;
}

interface RawBase {
  /** Per session, model and provider, every request in range: what the
   *  server needs to label the sessions a view names. */
  seen: RawUsage[];
}

export interface RawOverview extends RawBase {
  view: "overview";
  usage: RawUsage[];
  turnsBySession: Record<string, number>;
  turns: number;
  medianTurnMs: number | null;
  toolCalls: number;
  toolFailures: number;
  waitingMs: number;
  waits: number;
  apiErrors: number;
  retries: number;
  linesAdded: number;
  linesRemoved: number;
  prompts: number;
}

export interface RawSpend extends RawBase {
  view: "spend";
  usage: RawUsage[];
  turns: RawTurnUsage[];
  turnsBySession: Record<string, number>;
}

export interface RawSpeed extends RawBase {
  view: "speed";
  models: Array<{
    model: string;
    providers: string[];
    requests: number;
    errors: number;
    ttft: InsightsDurations;
    response: InsightsDurations;
    outputTps: number | null;
  }>;
  ttftTrend: Array<{ model: string; values: Array<number | null> }>;
  turnDurations: Array<{ fromMs: number; toMs: number | null; count: number }>;
  turnTime: { turns: number; modelMs: number; toolsMs: number; waitingMs: number; otherMs: number };
}

export interface RawTools extends RawBase {
  view: "tools";
  tools: Array<{ name: string; calls: number; failures: number; p50Ms: number | null; p90Ms: number | null; totalMs: number }>;
  programs: Array<{ name: string; calls: number; failures: number; p90Ms: number | null; totalMs: number }>;
  slowestCommands: Array<{ command: string; durationMs: number; timeMs: number; sessionId: string; success: boolean | null }>;
  mcpServers: Array<{ server: string; calls: number; failures: number; totalMs: number; tools: Array<{ name: string; calls: number }> }>;
  files: Array<{ path: string; touches: number; edits: number }>;
  waiting: {
    byTool: Array<{ tool: string; waits: number; totalMs: number; p50Ms: number | null }>;
    answeredBy: Record<string, number>;
    allowed: number;
    denied: number;
    totalMs: number;
    rulesApproved: number;
  };
}

export interface RawHealth extends RawBase {
  view: "health";
  apiErrors: Array<{ model: string; status: string; count: number; lastMessage: string | null; lastMs: number }>;
  errorsByBucket: Array<{ model: string; values: number[] }>;
  retries: Array<{ model: string; retries: number; requests: number }>;
  toolFailures: Array<{
    tool: string;
    failures: number;
    calls: number;
    recent: Array<{ detail: string | null; timeMs: number; sessionId: string }>;
  }>;
  mcpServers: Array<{
    server: string;
    attempts: number;
    failures: number;
    p50Ms: number | null;
    maxMs: number | null;
    lastStatus: string | null;
  }>;
  hooks: Array<{
    event: string;
    runs: number;
    totalMs: number;
    p90Ms: number | null;
    maxMs: number | null;
    blocking: number;
    errors: number;
  }>;
}

export interface RawActivity extends RawBase {
  view: "activity";
  lines: { added: number[]; removed: number[] };
  editsByLanguage: Array<{ language: string; accepted: number; rejected: number }>;
  commits: number;
  pullRequests: number;
  prompts: number[];
  heatmap: number[][];
}

export interface RawTurn {
  traceId: string;
  startMs: number;
  durationMs: number;
  prompt: string | null;
  usage: RawUsage[];
  requests: number;
  toolCalls: number;
  errors: number;
  modelMs: number;
  toolsMs: number;
  waitingMs: number;
  otherMs: number;
}

export interface RawTurns extends RawBase {
  view: "turns";
  turns: RawTurn[];
}

export interface RawTimelineRow extends Omit<InsightsTimelineRow, "spend"> {
  /** For a request: what pricing it needs. */
  usage?: RawUsage;
}

export interface RawTurnView extends RawBase {
  view: "turn";
  turn: (RawTurn & { rows: RawTimelineRow[] }) | null;
}

export interface RawContext extends RawBase {
  view: "context";
  points: Array<{ timeMs: number; tokens: number; model: string; compaction: boolean }>;
}

export type RawInsights = RawOverview | RawSpend | RawSpeed | RawTools | RawHealth | RawActivity | RawTurns | RawTurnView | RawContext;

const API_REQUEST = "claude_code.api_request";
const INTERACTION = "claude_code.interaction";
const LLM_REQUEST = "claude_code.llm_request";
const TOOL = "claude_code.tool";
const TOOL_EXECUTION = "claude_code.tool.execution";
const TOOL_BLOCKED = "claude_code.tool.blocked_on_user";
export const PERMISSION_ANSWER = "cockpit.permission_answer";
const PREVIEW = 160;

function n(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  const x = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** JSON false arrives as 0, a string "false" as itself; neither is success. */
function success(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return !(v === 0 || v === "false" || v === false);
}

/** An attribute's text, or the opening of it from `content` when it was
 *  long enough to be stored apart. `r` is the records alias. */
function textAttr(key: string, r = "r"): string {
  return `COALESCE(
    CASE WHEN json_type(${r}.attrs, '$."${key}"') = 'text' THEN substr(${r}.attrs ->> '${key}', 1, ${PREVIEW}) END,
    (SELECT substr(c.value, 1, ${PREVIEW}) FROM content c WHERE c.record_id = ${r}.id AND c.path = 'attrs.${key}')
  )`;
}

function bucketExpr(r = "r"): string {
  return `(CAST((${r}.time_ms + ?) / ? AS INTEGER) * ? - ?)`;
}

export class InsightsReader {
  private readonly offsetMs: number;
  private readonly bucketCount: number;

  constructor(
    private readonly select: Select,
    private readonly q: InsightsQuery,
  ) {
    this.offsetMs = q.tzOffsetMin * 60_000;
    this.bucketCount = Math.max(0, Math.round((q.until - q.since) / q.bucketMs));
  }

  private bucketParams(): Param[] {
    return [this.offsetMs, this.q.bucketMs, this.q.bucketMs, this.offsetMs];
  }

  /** `name = ? AND time in range [AND session]`, with its parameters. */
  private scope(name: string, r = "r"): [string, Param[]] {
    const clauses = [`${r}.name = ?`, `${r}.time_ms >= ?`, `${r}.time_ms < ?`];
    const params: Param[] = [name, this.q.since, this.q.until];
    if (this.q.session) {
      clauses.push(`${r}.session_id = ?`);
      params.push(this.q.session);
    }
    return [clauses.join(" AND "), params];
  }

  private index(t: number): number {
    if (t < this.q.since || t >= this.q.until) return -1;
    return Math.floor((t - this.q.since) / this.q.bucketMs);
  }

  private zeros(): number[] {
    return new Array(this.bucketCount).fill(0);
  }

  read(): RawInsights {
    switch (this.q.view) {
      case "overview":
        return this.overview();
      case "spend":
        return this.spend();
      case "speed":
        return this.speed();
      case "tools":
        return this.tools();
      case "health":
        return this.health();
      case "activity":
        return this.activity();
      case "turns":
        return { view: "turns", seen: this.seen(), turns: this.turns() };
      case "turn":
        return { view: "turn", seen: this.seen(), turn: this.turn() };
      case "context":
        return this.context();
    }
  }

  /** Usage grouped by session, model and provider, plus whatever `dims`
   *  adds: the bucket, the purpose, the effort, or one request each. */
  usage(dims: { bucket?: boolean; purpose?: boolean; effort?: boolean } = {}): RawUsage[] {
    const [clause, params] = this.scope(API_REQUEST);
    const extra: string[] = [];
    const extraParams: Param[] = [];
    if (dims.bucket) {
      extra.push(`${bucketExpr()} AS bucket`);
      extraParams.push(...this.bucketParams());
    }
    if (dims.purpose) extra.push("r.attrs ->> 'query_source' AS purpose");
    if (dims.effort) extra.push("r.attrs ->> 'effort' AS effort");
    const groups = [
      "session",
      "model",
      "provider",
      ...(dims.bucket ? ["bucket"] : []),
      ...(dims.purpose ? ["purpose"] : []),
      ...(dims.effort ? ["effort"] : []),
    ];
    const rows = this.select(
      `SELECT r.session_id AS session, coalesce(r.attrs ->> 'model', 'unknown') AS model,
         src.resource ->> 'cockpit.provider' AS provider,
         ${extra.length ? `${extra.join(", ")},` : ""}
         count(*) AS requests,
         sum(CAST(r.attrs ->> 'input_tokens' AS REAL)) AS input,
         sum(CAST(r.attrs ->> 'output_tokens' AS REAL)) AS output,
         sum(CAST(r.attrs ->> 'cache_read_tokens' AS REAL)) AS cache_read,
         sum(CAST(r.attrs ->> 'cache_creation_tokens' AS REAL)) AS cache_write,
         sum(CAST(r.attrs ->> 'cost_usd' AS REAL)) AS cli_cost,
         min(r.time_ms) AS first_ms, max(r.time_ms) AS last_ms
       FROM records r LEFT JOIN sources src ON src.id = r.source_id
       WHERE ${clause}
       GROUP BY ${groups.join(", ")}`,
      ...extraParams,
      ...params,
    );
    return rows.map((row) => ({
      session: String(row.session),
      model: String(row.model),
      provider: s(row.provider),
      requests: n(row.requests),
      tokens: { input: n(row.input), output: n(row.output), cacheRead: n(row.cache_read), cacheWrite: n(row.cache_write) },
      cliCost: n(row.cli_cost),
      firstMs: n(row.first_ms),
      lastMs: n(row.last_ms),
      ...(dims.bucket ? { bucket: n(row.bucket) } : {}),
      ...(dims.purpose ? { purpose: s(row.purpose) } : {}),
      ...(dims.effort ? { effort: s(row.effort) } : {}),
    }));
  }

  seen(): RawUsage[] {
    return this.usage();
  }

  private count(name: string, extra = "", extraParams: Param[] = []): number {
    const [clause, params] = this.scope(name);
    return n(this.select(`SELECT count(*) AS n FROM records r WHERE ${clause}${extra}`, ...params, ...extraParams)[0]?.n);
  }

  private sum(name: string, expr: string, extra = "", extraParams: Param[] = []): number {
    const [clause, params] = this.scope(name);
    return n(this.select(`SELECT sum(${expr}) AS n FROM records r WHERE ${clause}${extra}`, ...params, ...extraParams)[0]?.n);
  }

  private interactions(): Array<{ session: string; traceId: string | null; startMs: number; durationMs: number; prompt: string | null }> {
    const [clause, params] = this.scope(INTERACTION);
    return this.select(
      `SELECT r.session_id AS session, r.trace_id AS trace, r.time_ms AS start, coalesce(r.value, r.end_ms - r.time_ms, 0) AS ms,
         ${textAttr("user_prompt")} AS prompt
       FROM records r WHERE ${clause} ORDER BY r.time_ms`,
      ...params,
    ).map((row) => ({
      session: String(row.session),
      traceId: s(row.trace),
      startMs: n(row.start),
      durationMs: n(row.ms),
      prompt: s(row.prompt),
    }));
  }

  private failedTools(): number {
    return this.count("claude_code.tool_result", " AND (r.attrs ->> 'success') IN (0, 'false')");
  }

  overview(): RawOverview {
    const turns = this.interactions();
    const turnsBySession: Record<string, number> = {};
    for (const t of turns) turnsBySession[t.session] = (turnsBySession[t.session] ?? 0) + 1;
    const usage = this.usage({ bucket: true });
    return {
      view: "overview",
      seen: this.seen(),
      usage,
      turnsBySession,
      turns: turns.length,
      medianTurnMs: percentile(
        turns.map((t) => t.durationMs),
        0.5,
      ),
      toolCalls: this.count("claude_code.tool_result"),
      toolFailures: this.failedTools(),
      waitingMs: this.sum(PERMISSION_ANSWER, "r.value", " AND r.attrs ->> 'answered_by' = 'you'"),
      waits: this.count(PERMISSION_ANSWER, " AND r.attrs ->> 'answered_by' = 'you'"),
      apiErrors: this.count("claude_code.api_error"),
      retries: this.sum(LLM_REQUEST, "max(CAST(coalesce(r.attrs ->> 'attempt', 1) AS INTEGER) - 1, 0)"),
      linesAdded: this.sum("claude_code.lines_of_code.count", "r.value", " AND r.attrs ->> 'type' = 'added'"),
      linesRemoved: this.sum("claude_code.lines_of_code.count", "r.value", " AND r.attrs ->> 'type' = 'removed'"),
      prompts: this.count("claude_code.user_prompt"),
    };
  }

  spend(): RawSpend {
    const [clause, params] = this.scope(API_REQUEST);
    const turnRows = this.select(
      `SELECT r.session_id AS session, coalesce(r.attrs ->> 'model', 'unknown') AS model,
         src.resource ->> 'cockpit.provider' AS provider, r.prompt_id AS prompt_id, min(r.trace_id) AS trace,
         count(*) AS requests,
         sum(CAST(r.attrs ->> 'input_tokens' AS REAL)) AS input,
         sum(CAST(r.attrs ->> 'output_tokens' AS REAL)) AS output,
         sum(CAST(r.attrs ->> 'cache_read_tokens' AS REAL)) AS cache_read,
         sum(CAST(r.attrs ->> 'cache_creation_tokens' AS REAL)) AS cache_write,
         sum(CAST(r.attrs ->> 'cost_usd' AS REAL)) AS cli_cost,
         min(r.time_ms) AS first_ms, max(r.time_ms) AS last_ms
       FROM records r LEFT JOIN sources src ON src.id = r.source_id
       WHERE ${clause} AND r.prompt_id IS NOT NULL
       GROUP BY session, model, provider, prompt_id`,
      ...params,
    );
    // The prompt's opening words, from its user_prompt event.
    const prompts = new Map<string, string | null>();
    const [pClause, pParams] = this.scope("claude_code.user_prompt");
    for (const row of this.select(
      `SELECT r.prompt_id AS id, ${textAttr("prompt")} AS prompt FROM records r WHERE ${pClause}`,
      ...pParams,
    )) {
      if (row.id != null) prompts.set(String(row.id), s(row.prompt));
    }
    const turns: RawTurnUsage[] = turnRows.map((row) => ({
      session: String(row.session),
      model: String(row.model),
      provider: s(row.provider),
      requests: n(row.requests),
      tokens: { input: n(row.input), output: n(row.output), cacheRead: n(row.cache_read), cacheWrite: n(row.cache_write) },
      cliCost: n(row.cli_cost),
      firstMs: n(row.first_ms),
      lastMs: n(row.last_ms),
      promptId: String(row.prompt_id),
      traceId: s(row.trace),
      timeMs: n(row.first_ms),
      prompt: prompts.get(String(row.prompt_id)) ?? null,
    }));
    const turnsBySession: Record<string, number> = {};
    for (const t of this.interactions()) turnsBySession[t.session] = (turnsBySession[t.session] ?? 0) + 1;
    return { view: "spend", seen: this.seen(), usage: this.usage({ bucket: true, purpose: true, effort: true }), turns, turnsBySession };
  }

  /** Each turn's span intervals by category, keyed by trace id. */
  private turnIntervals(
    traceIds: string[],
  ): Map<string, { model: Interval[]; tools: Interval[]; waiting: Interval[]; requests: number; toolCalls: number }> {
    const out = new Map<string, { model: Interval[]; tools: Interval[]; waiting: Interval[]; requests: number; toolCalls: number }>();
    for (const id of traceIds) out.set(id, { model: [], tools: [], waiting: [], requests: 0, toolCalls: 0 });
    if (traceIds.length === 0) return out;
    const [clause, params] = this.scope(INTERACTION, "i");
    const rows = this.select(
      `SELECT c.trace_id AS trace, c.name AS name, c.time_ms AS a, coalesce(c.end_ms, c.time_ms + c.value, c.time_ms) AS b
       FROM records i JOIN records c ON c.trace_id = i.trace_id
       WHERE ${clause} AND c.name IN (?, ?, ?, ?)`,
      ...params,
      LLM_REQUEST,
      TOOL,
      TOOL_EXECUTION,
      TOOL_BLOCKED,
    );
    for (const row of rows) {
      const entry = out.get(String(row.trace));
      if (!entry) continue;
      const span: Interval = [n(row.a), n(row.b)];
      if (row.name === LLM_REQUEST) {
        entry.model.push(span);
        entry.requests++;
      } else if (row.name === TOOL_EXECUTION) entry.tools.push(span);
      else if (row.name === TOOL_BLOCKED) entry.waiting.push(span);
      else entry.toolCalls++;
    }
    return out;
  }

  speed(): RawSpeed {
    const [clause, params] = this.scope(API_REQUEST);
    const rows = this.select(
      `SELECT coalesce(r.attrs ->> 'model', 'unknown') AS model, src.resource ->> 'cockpit.provider' AS provider, r.time_ms AS t,
         CAST(r.attrs ->> 'ttft_ms' AS REAL) AS ttft, CAST(r.attrs ->> 'duration_ms' AS REAL) AS ms,
         CAST(r.attrs ->> 'output_tokens' AS REAL) AS output
       FROM records r LEFT JOIN sources src ON src.id = r.source_id WHERE ${clause}`,
      ...params,
    );
    const errors = new Map<string, number>();
    const [eClause, eParams] = this.scope("claude_code.api_error");
    for (const row of this.select(
      `SELECT coalesce(r.attrs ->> 'model', 'unknown') AS model, count(*) AS n FROM records r WHERE ${eClause} GROUP BY model`,
      ...eParams,
    )) {
      errors.set(String(row.model), n(row.n));
    }
    const byModel = new Map<string, { providers: Set<string>; ttft: number[]; ms: number[]; tps: number[]; trend: number[][] }>();
    const entry = (model: string) => {
      let m = byModel.get(model);
      if (!m) {
        m = { providers: new Set(), ttft: [], ms: [], tps: [], trend: Array.from({ length: this.bucketCount }, () => []) };
        byModel.set(model, m);
      }
      return m;
    };
    for (const row of rows) {
      const m = entry(String(row.model));
      if (row.provider != null) m.providers.add(String(row.provider));
      const ttft = row.ttft == null ? null : n(row.ttft);
      const ms = n(row.ms);
      if (ttft !== null) {
        m.ttft.push(ttft);
        const i = this.index(n(row.t));
        if (i >= 0) m.trend[i].push(ttft);
      }
      m.ms.push(ms);
      const output = n(row.output);
      const streaming = ttft !== null ? ms - ttft : ms;
      if (output > 0 && streaming > 0) m.tps.push(output / (streaming / 1000));
    }
    // A model whose every request failed still has a row, for its errors.
    for (const model of errors.keys()) entry(model);
    const models = [...byModel].map(([model, m]) => ({
      model,
      providers: [...m.providers].sort(),
      requests: m.ms.length,
      errors: errors.get(model) ?? 0,
      ttft: durations(m.ttft),
      response: durations(m.ms),
      outputTps: percentile(m.tps, 0.5),
    }));
    models.sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
    const turns = this.interactions();
    const intervals = this.turnIntervals(turns.map((t) => t.traceId).filter((id): id is string => !!id));
    const turnTime = { turns: turns.length, modelMs: 0, toolsMs: 0, waitingMs: 0, otherMs: 0 };
    for (const t of turns) {
      const spans = t.traceId ? intervals.get(t.traceId) : undefined;
      const split = turnBreakdown(t.startMs, t.startMs + t.durationMs, spans ?? { model: [], tools: [], waiting: [] });
      turnTime.modelMs += split.modelMs;
      turnTime.toolsMs += split.toolsMs;
      turnTime.waitingMs += split.waitingMs;
      turnTime.otherMs += split.otherMs;
    }
    return {
      view: "speed",
      seen: this.seen(),
      models,
      ttftTrend: models.map((m) => ({ model: m.model, values: (byModel.get(m.model)?.trend ?? []).map((v) => percentile(v, 0.5)) })),
      turnDurations: histogram(
        turns.map((t) => t.durationMs),
        TURN_DURATION_EDGES,
      ),
      turnTime,
    };
  }

  /** Every tool call in range: its name, time, and what it ran or touched. */
  private toolCalls(): Array<{
    session: string;
    timeMs: number;
    ms: number;
    tool: string;
    program: string | null;
    command: string | null;
    file: string | null;
    success: boolean | null;
  }> {
    const [clause, params] = this.scope(TOOL);
    return this.select(
      `SELECT r.session_id AS session, r.time_ms AS t, coalesce(r.value, r.end_ms - r.time_ms, 0) AS ms,
         coalesce(r.attrs ->> 'tool_name', 'unknown') AS tool, r.attrs ->> 'bash_argv0' AS program,
         ${textAttr("full_command")} AS command, ${textAttr("file_path")} AS file,
         (SELECT e.attrs ->> 'success' FROM records e
           WHERE e.trace_id = r.trace_id AND e.parent_span_id = r.span_id AND e.name = '${TOOL_EXECUTION}' LIMIT 1) AS ok
       FROM records r WHERE ${clause} ORDER BY r.time_ms`,
      ...params,
    ).map((row) => ({
      session: String(row.session),
      timeMs: n(row.t),
      ms: n(row.ms),
      tool: String(row.tool),
      program: s(row.program),
      command: s(row.command),
      file: s(row.file),
      success: success(row.ok),
    }));
  }

  tools(): RawTools {
    const calls = this.toolCalls();
    const group = <K extends string>(key: (c: (typeof calls)[number]) => K | null) => {
      const out = new Map<K, typeof calls>();
      for (const c of calls) {
        const k = key(c);
        if (k === null) continue;
        const list = out.get(k) ?? [];
        list.push(c);
        out.set(k, list);
      }
      return out;
    };
    const failures = (list: typeof calls) => list.filter((c) => c.success === false).length;
    const total = (list: typeof calls) => list.reduce((sum, c) => sum + c.ms, 0);
    const tools = [...group((c) => c.tool)].map(([name, list]) => {
      const ms = list.map((c) => c.ms);
      return {
        name,
        calls: list.length,
        failures: failures(list),
        p50Ms: percentile(ms, 0.5),
        p90Ms: percentile(ms, 0.9),
        totalMs: total(list),
      };
    });
    tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    const programs = [...group((c) => (c.tool === "Bash" ? (c.program ?? "other") : null))].map(([name, list]) => ({
      name,
      calls: list.length,
      failures: failures(list),
      p90Ms: percentile(
        list.map((c) => c.ms),
        0.9,
      ),
      totalMs: total(list),
    }));
    programs.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    const slowestCommands = calls
      .filter((c) => c.tool === "Bash" && c.command)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
      .map((c) => ({ command: c.command as string, durationMs: c.ms, timeMs: c.timeMs, sessionId: c.session, success: c.success }));
    const servers = new Map<string, { calls: number; failures: number; totalMs: number; tools: Map<string, number> }>();
    for (const c of calls) {
      const mcp = mcpTool(c.tool);
      if (!mcp) continue;
      const entry = servers.get(mcp.server) ?? { calls: 0, failures: 0, totalMs: 0, tools: new Map<string, number>() };
      entry.calls++;
      if (c.success === false) entry.failures++;
      entry.totalMs += c.ms;
      entry.tools.set(mcp.tool, (entry.tools.get(mcp.tool) ?? 0) + 1);
      servers.set(mcp.server, entry);
    }
    const mcpServers = [...servers].map(([server, e]) => ({
      server,
      calls: e.calls,
      failures: e.failures,
      totalMs: e.totalMs,
      tools: [...e.tools].map(([name, count]) => ({ name, calls: count })).sort((a, b) => b.calls - a.calls),
    }));
    mcpServers.sort((a, b) => b.calls - a.calls);
    const fileMap = new Map<string, { touches: number; edits: number }>();
    for (const c of calls) {
      if (!c.file) continue;
      const entry = fileMap.get(c.file) ?? { touches: 0, edits: 0 };
      entry.touches++;
      if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(c.tool)) entry.edits++;
      fileMap.set(c.file, entry);
    }
    const files = [...fileMap]
      .map(([path, e]) => ({ path, ...e }))
      .sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path))
      .slice(0, 20);

    const [aClause, aParams] = this.scope(PERMISSION_ANSWER);
    const answers = this.select(
      `SELECT coalesce(r.attrs ->> 'tool_name', 'unknown') AS tool, r.attrs ->> 'answered_by' AS who, r.attrs ->> 'decision' AS decision, coalesce(r.value, 0) AS ms
       FROM records r WHERE ${aClause}`,
      ...aParams,
    );
    const answeredBy: Record<string, number> = {};
    const yours = new Map<string, number[]>();
    let allowed = 0;
    let denied = 0;
    let waitTotal = 0;
    for (const a of answers) {
      const who = String(a.who ?? "unknown");
      answeredBy[who] = (answeredBy[who] ?? 0) + 1;
      if (who !== "you") continue;
      if (a.decision === "allow") allowed++;
      else denied++;
      waitTotal += n(a.ms);
      const list = yours.get(String(a.tool)) ?? [];
      list.push(n(a.ms));
      yours.set(String(a.tool), list);
    }
    const byTool = [...yours]
      .map(([tool, ms]) => ({ tool, waits: ms.length, totalMs: ms.reduce((x, y) => x + y, 0), p50Ms: percentile(ms, 0.5) }))
      .sort((a, b) => b.totalMs - a.totalMs);
    return {
      view: "tools",
      seen: this.seen(),
      tools,
      programs,
      slowestCommands,
      mcpServers,
      files,
      waiting: {
        byTool,
        answeredBy,
        allowed,
        denied,
        totalMs: waitTotal,
        rulesApproved: this.count(
          "claude_code.tool_decision",
          " AND r.attrs ->> 'source' = 'config' AND r.attrs ->> 'decision' = 'accept'",
        ),
      },
    };
  }

  health(): RawHealth {
    const [eClause, eParams] = this.scope("claude_code.api_error");
    const errorRows = this.select(
      `SELECT coalesce(r.attrs ->> 'model', 'unknown') AS model, coalesce(r.attrs ->> 'status_code', 'none') AS status, r.time_ms AS t,
         ${textAttr("error")} AS message
       FROM records r WHERE ${eClause} ORDER BY r.time_ms`,
      ...eParams,
    );
    const errors = new Map<string, { model: string; status: string; count: number; lastMessage: string | null; lastMs: number }>();
    const byBucket = new Map<string, number[]>();
    for (const row of errorRows) {
      const key = `${row.model}\n${row.status}`;
      const entry = errors.get(key) ?? { model: String(row.model), status: String(row.status), count: 0, lastMessage: null, lastMs: 0 };
      entry.count++;
      entry.lastMessage = s(row.message);
      entry.lastMs = n(row.t);
      errors.set(key, entry);
      const values = byBucket.get(String(row.model)) ?? this.zeros();
      const i = this.index(n(row.t));
      if (i >= 0) values[i]++;
      byBucket.set(String(row.model), values);
    }
    const [rClause, rParams] = this.scope(LLM_REQUEST);
    const retries = this.select(
      `SELECT coalesce(r.attrs ->> 'model', 'unknown') AS model, count(*) AS requests,
         sum(max(CAST(coalesce(r.attrs ->> 'attempt', 1) AS INTEGER) - 1, 0)) AS retries
       FROM records r WHERE ${rClause} GROUP BY model`,
      ...rParams,
    )
      .map((row) => ({ model: String(row.model), retries: n(row.retries), requests: n(row.requests) }))
      .filter((row) => row.retries > 0)
      .sort((a, b) => b.retries - a.retries);

    const calls = this.toolCalls();
    const failing = new Map<
      string,
      { failures: number; calls: number; recent: Array<{ detail: string | null; timeMs: number; sessionId: string }> }
    >();
    for (const c of calls) {
      const entry = failing.get(c.tool) ?? { failures: 0, calls: 0, recent: [] };
      entry.calls++;
      if (c.success === false) {
        entry.failures++;
        entry.recent.unshift({ detail: c.command ?? c.file, timeMs: c.timeMs, sessionId: c.session });
        entry.recent.length = Math.min(entry.recent.length, 3);
      }
      failing.set(c.tool, entry);
    }
    const toolFailures = [...failing]
      .filter(([, e]) => e.failures > 0)
      .map(([tool, e]) => ({ tool, ...e }))
      .sort((a, b) => b.failures - a.failures);

    const [mClause, mParams] = this.scope("claude_code.mcp_server_connection");
    const connections = new Map<string, { attempts: number; failures: number; ms: number[]; lastStatus: string | null }>();
    for (const row of this.select(
      `SELECT coalesce(r.attrs ->> 'server_name', 'unknown') AS server, r.attrs ->> 'status' AS status, CAST(r.attrs ->> 'duration_ms' AS REAL) AS ms
       FROM records r WHERE ${mClause} ORDER BY r.time_ms`,
      ...mParams,
    )) {
      const entry = connections.get(String(row.server)) ?? { attempts: 0, failures: 0, ms: [], lastStatus: null };
      entry.attempts++;
      const status = s(row.status);
      if (status && !/^(connected|success|ok)$/i.test(status)) entry.failures++;
      if (row.ms != null) entry.ms.push(n(row.ms));
      entry.lastStatus = status;
      connections.set(String(row.server), entry);
    }
    const mcpServers = [...connections]
      .map(([server, e]) => ({
        server,
        attempts: e.attempts,
        failures: e.failures,
        p50Ms: percentile(e.ms, 0.5),
        maxMs: e.ms.length ? Math.max(...e.ms) : null,
        lastStatus: e.lastStatus,
      }))
      .sort((a, b) => b.failures - a.failures || b.attempts - a.attempts);

    const [hClause, hParams] = this.scope("claude_code.hook_execution_complete");
    const hookMap = new Map<string, { ms: number[]; blocking: number; errors: number }>();
    for (const row of this.select(
      `SELECT coalesce(r.attrs ->> 'hook_event', 'unknown') AS event, CAST(r.attrs ->> 'total_duration_ms' AS REAL) AS ms,
         CAST(coalesce(r.attrs ->> 'num_blocking', 0) AS INTEGER) AS blocking,
         CAST(coalesce(r.attrs ->> 'num_non_blocking_error', 0) AS INTEGER) AS errors
       FROM records r WHERE ${hClause}`,
      ...hParams,
    )) {
      const entry = hookMap.get(String(row.event)) ?? { ms: [], blocking: 0, errors: 0 };
      entry.ms.push(n(row.ms));
      entry.blocking += n(row.blocking);
      entry.errors += n(row.errors);
      hookMap.set(String(row.event), entry);
    }
    const hooks = [...hookMap]
      .map(([event, e]) => ({
        event,
        runs: e.ms.length,
        totalMs: e.ms.reduce((x, y) => x + y, 0),
        p90Ms: percentile(e.ms, 0.9),
        maxMs: e.ms.length ? Math.max(...e.ms) : null,
        blocking: e.blocking,
        errors: e.errors,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    return {
      view: "health",
      seen: this.seen(),
      apiErrors: [...errors.values()].sort((a, b) => b.count - a.count),
      errorsByBucket: [...byBucket].map(([model, values]) => ({ model, values })),
      retries,
      toolFailures,
      mcpServers,
      hooks,
    };
  }

  activity(): RawActivity {
    const perBucket = (name: string, expr: string, extra = ""): number[] => {
      const [clause, params] = this.scope(name);
      const values = this.zeros();
      for (const row of this.select(
        `SELECT ${bucketExpr()} AS bucket, sum(${expr}) AS v FROM records r WHERE ${clause}${extra} GROUP BY bucket`,
        ...this.bucketParams(),
        ...params,
      )) {
        const i = this.index(n(row.bucket));
        if (i >= 0) values[i] += n(row.v);
      }
      return values;
    };
    const [dClause, dParams] = this.scope("claude_code.code_edit_tool.decision");
    const languages = new Map<string, { accepted: number; rejected: number }>();
    for (const row of this.select(
      `SELECT coalesce(r.attrs ->> 'language', 'unknown') AS language, r.attrs ->> 'decision' AS decision, sum(r.value) AS v
       FROM records r WHERE ${dClause} GROUP BY language, decision`,
      ...dParams,
    )) {
      const entry = languages.get(String(row.language)) ?? { accepted: 0, rejected: 0 };
      if (row.decision === "accept") entry.accepted += n(row.v);
      else entry.rejected += n(row.v);
      languages.set(String(row.language), entry);
    }
    const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0) as number[]);
    const [pClause, pParams] = this.scope("claude_code.user_prompt");
    for (const row of this.select(`SELECT r.time_ms AS t FROM records r WHERE ${pClause}`, ...pParams)) {
      const local = new Date(n(row.t) + this.offsetMs);
      heatmap[(local.getUTCDay() + 6) % 7][local.getUTCHours()]++;
    }
    return {
      view: "activity",
      seen: this.seen(),
      lines: {
        added: perBucket("claude_code.lines_of_code.count", "r.value", " AND r.attrs ->> 'type' = 'added'"),
        removed: perBucket("claude_code.lines_of_code.count", "r.value", " AND r.attrs ->> 'type' = 'removed'"),
      },
      editsByLanguage: [...languages]
        .map(([language, e]) => ({ language, ...e }))
        .sort((a, b) => b.accepted + b.rejected - (a.accepted + a.rejected)),
      commits: this.sum("claude_code.commit.count", "r.value"),
      pullRequests: this.sum("claude_code.pull_request.count", "r.value"),
      prompts: perBucket("claude_code.user_prompt", "1"),
      heatmap,
    };
  }

  /** Usage per trace, for pricing each turn. */
  private usageByTrace(traceIds: string[]): Map<string, RawUsage[]> {
    const out = new Map<string, RawUsage[]>();
    if (traceIds.length === 0) return out;
    const [clause, params] = this.scope(API_REQUEST);
    const rows = this.select(
      `SELECT r.trace_id AS trace, r.session_id AS session, coalesce(r.attrs ->> 'model', 'unknown') AS model,
         src.resource ->> 'cockpit.provider' AS provider, count(*) AS requests,
         sum(CAST(r.attrs ->> 'input_tokens' AS REAL)) AS input,
         sum(CAST(r.attrs ->> 'output_tokens' AS REAL)) AS output,
         sum(CAST(r.attrs ->> 'cache_read_tokens' AS REAL)) AS cache_read,
         sum(CAST(r.attrs ->> 'cache_creation_tokens' AS REAL)) AS cache_write,
         sum(CAST(r.attrs ->> 'cost_usd' AS REAL)) AS cli_cost,
         min(r.time_ms) AS first_ms, max(r.time_ms) AS last_ms
       FROM records r LEFT JOIN sources src ON src.id = r.source_id
       WHERE ${clause} AND r.trace_id IS NOT NULL
       GROUP BY trace, session, model, provider`,
      ...params,
    );
    const wanted = new Set(traceIds);
    for (const row of rows) {
      const trace = String(row.trace);
      if (!wanted.has(trace)) continue;
      const list = out.get(trace) ?? [];
      list.push({
        session: String(row.session),
        model: String(row.model),
        provider: s(row.provider),
        requests: n(row.requests),
        tokens: { input: n(row.input), output: n(row.output), cacheRead: n(row.cache_read), cacheWrite: n(row.cache_write) },
        cliCost: n(row.cli_cost),
        firstMs: n(row.first_ms),
        lastMs: n(row.last_ms),
      });
      out.set(trace, list);
    }
    return out;
  }

  private errorsByTrace(): Map<string, number> {
    const out = new Map<string, number>();
    const [clause, params] = this.scope("claude_code.api_error");
    for (const row of this.select(
      `SELECT r.trace_id AS trace, count(*) AS n FROM records r WHERE ${clause} AND r.trace_id IS NOT NULL GROUP BY trace`,
      ...params,
    )) {
      out.set(String(row.trace), n(row.n));
    }
    const [tClause, tParams] = this.scope("claude_code.tool_result");
    for (const row of this.select(
      `SELECT r.trace_id AS trace, count(*) AS n FROM records r WHERE ${tClause} AND r.trace_id IS NOT NULL AND (r.attrs ->> 'success') IN (0, 'false') GROUP BY trace`,
      ...tParams,
    )) {
      out.set(String(row.trace), (out.get(String(row.trace)) ?? 0) + n(row.n));
    }
    return out;
  }

  turns(): RawTurn[] {
    const turns = this.interactions().filter((t): t is typeof t & { traceId: string } => !!t.traceId);
    const ids = turns.map((t) => t.traceId);
    const intervals = this.turnIntervals(ids);
    const usage = this.usageByTrace(ids);
    const errors = this.errorsByTrace();
    return turns
      .map((t) => {
        const spans = intervals.get(t.traceId) ?? { model: [], tools: [], waiting: [], requests: 0, toolCalls: 0 };
        return {
          traceId: t.traceId,
          startMs: t.startMs,
          durationMs: t.durationMs,
          prompt: t.prompt,
          usage: usage.get(t.traceId) ?? [],
          requests: spans.requests,
          toolCalls: spans.toolCalls,
          errors: errors.get(t.traceId) ?? 0,
          ...turnBreakdown(t.startMs, t.startMs + t.durationMs, spans),
        };
      })
      .reverse();
  }

  turn(): (RawTurn & { rows: RawTimelineRow[] }) | null {
    const trace = this.q.turn as string;
    const params: Param[] = [trace];
    let sessionClause = "";
    if (this.q.session) {
      sessionClause = " AND r.session_id = ?";
      params.push(this.q.session);
    }
    const records = this.select(
      `SELECT r.id, r.signal, r.name, r.time_ms AS t, coalesce(r.end_ms, r.time_ms + coalesce(r.value, 0)) AS e, r.value, r.span_id AS span, r.parent_span_id AS parent,
         r.attrs ->> 'model' AS model, r.attrs ->> 'tool_name' AS tool,
         ${textAttr("full_command")} AS command, ${textAttr("file_path")} AS file, ${textAttr("user_prompt")} AS prompt,
         r.attrs ->> 'success' AS ok, r.attrs ->> 'attempt' AS attempt, r.attrs ->> 'ttft_ms' AS ttft,
         r.attrs ->> 'input_tokens' AS input, r.attrs ->> 'output_tokens' AS output,
         r.attrs ->> 'cache_read_tokens' AS cache_read, r.attrs ->> 'cache_creation_tokens' AS cache_write,
         r.attrs ->> 'cost_usd' AS cost, r.attrs ->> 'hook_event' AS hook_event, r.attrs ->> 'hook_name' AS hook_name,
         r.attrs ->> 'total_duration_ms' AS hook_ms, src.resource ->> 'cockpit.provider' AS provider, r.session_id AS session
       FROM records r LEFT JOIN sources src ON src.id = r.source_id
       WHERE r.trace_id = ?${sessionClause} ORDER BY r.time_ms, r.id`,
      ...params,
    );
    const root = records.find((r) => r.name === INTERACTION);
    if (!root) return null;
    const start = n(root.t);
    const end = Math.max(n(root.e), start);
    const rows: RawTimelineRow[] = [];
    const segmentsBySpan = new Map<string, RawTimelineRow["segments"]>();
    const toolSuccess = new Map<string, boolean | null>();
    for (const r of records) {
      if (r.name !== TOOL_BLOCKED && r.name !== TOOL_EXECUTION) continue;
      const parent = String(r.parent ?? "");
      const list = segmentsBySpan.get(parent) ?? [];
      list.push({ kind: r.name === TOOL_BLOCKED ? "waiting" : "running", startMs: n(r.t), endMs: n(r.e) });
      segmentsBySpan.set(parent, list);
      if (r.name === TOOL_EXECUTION) toolSuccess.set(parent, success(r.ok));
    }
    // api_request events carry Claude Code's cost; pair each with its span.
    const events = records.filter((r) => r.name === API_REQUEST);
    const used = new Set<unknown>();
    const model: Interval[] = [];
    const tools: Interval[] = [];
    const waiting: Interval[] = [];
    let requests = 0;
    let toolCalls = 0;
    for (const r of records) {
      if (r.name === LLM_REQUEST) {
        requests++;
        model.push([n(r.t), n(r.e)]);
        const tokens = { input: n(r.input), output: n(r.output), cacheRead: n(r.cache_read), cacheWrite: n(r.cache_write) };
        const event =
          events.find((ev) => !used.has(ev.id) && ev.model === r.model && n(ev.output) === tokens.output && n(ev.input) === tokens.input) ??
          events.find((ev) => !used.has(ev.id) && ev.model === r.model);
        if (event) used.add(event.id);
        rows.push({
          id: String(r.span ?? r.id),
          parentId: s(r.parent),
          kind: "request",
          label: String(r.model ?? "request"),
          detail: null,
          startMs: n(r.t),
          endMs: n(r.e),
          success: success(r.ok),
          segments: [],
          tokens,
          ttftMs: r.ttft == null ? null : n(r.ttft),
          attempt: r.attempt == null ? null : n(r.attempt),
          usage: {
            session: String(r.session),
            model: String(r.model ?? "unknown"),
            provider: s(r.provider),
            requests: 1,
            tokens,
            cliCost: event ? n(event.cost) : 0,
            firstMs: n(r.t),
            lastMs: n(r.e),
          },
        });
      } else if (r.name === TOOL) {
        toolCalls++;
        const segments = segmentsBySpan.get(String(r.span)) ?? [];
        for (const seg of segments) (seg.kind === "waiting" ? waiting : tools).push([seg.startMs, seg.endMs]);
        rows.push({
          id: String(r.span ?? r.id),
          parentId: s(r.parent),
          kind: "tool",
          label: String(r.tool ?? "tool"),
          detail: s(r.command) ?? s(r.file),
          startMs: n(r.t),
          endMs: n(r.e),
          success: toolSuccess.get(String(r.span)) ?? null,
          segments,
        });
      } else if (r.name === "claude_code.hook_execution_complete") {
        const ms = n(r.hook_ms);
        rows.push({
          id: `hook-${r.id}`,
          parentId: null,
          kind: "hook",
          label: String(r.hook_event ?? "hook"),
          detail: s(r.hook_name),
          startMs: n(r.t) - ms,
          endMs: n(r.t),
          success: null,
          segments: [],
        });
      }
    }
    rows.sort((a, b) => a.startMs - b.startMs);
    const usage = new Map<string, RawUsage>();
    for (const row of rows) {
      if (!row.usage) continue;
      const key = `${row.usage.model}\n${row.usage.provider}`;
      const into = usage.get(key);
      if (!into) {
        usage.set(key, { ...row.usage, tokens: { ...row.usage.tokens } });
        continue;
      }
      into.requests++;
      into.cliCost += row.usage.cliCost;
      into.tokens.input += row.usage.tokens.input;
      into.tokens.output += row.usage.tokens.output;
      into.tokens.cacheRead += row.usage.tokens.cacheRead;
      into.tokens.cacheWrite += row.usage.tokens.cacheWrite;
    }
    const errors =
      records.filter((r) => r.name === "claude_code.api_error").length + [...toolSuccess.values()].filter((v) => v === false).length;
    return {
      traceId: trace,
      startMs: start,
      durationMs: end - start,
      prompt: s(root.prompt),
      usage: [...usage.values()],
      requests,
      toolCalls,
      errors,
      ...turnBreakdown(start, end, { model, tools, waiting }),
      rows,
    };
  }

  context(): RawContext {
    const [clause, params] = this.scope(API_REQUEST);
    const points = this.select(
      `SELECT r.time_ms AS t, coalesce(r.attrs ->> 'model', 'unknown') AS model, r.attrs ->> 'query_source' AS source,
         coalesce(CAST(r.attrs ->> 'input_tokens' AS REAL), 0) + coalesce(CAST(r.attrs ->> 'cache_read_tokens' AS REAL), 0)
           + coalesce(CAST(r.attrs ->> 'cache_creation_tokens' AS REAL), 0) AS tokens
       FROM records r WHERE ${clause} ORDER BY r.time_ms`,
      ...params,
    )
      .filter((row) => row.source == null || row.source === "repl_main_thread" || /compact/.test(String(row.source)))
      .map((row) => ({
        timeMs: n(row.t),
        tokens: n(row.tokens),
        model: String(row.model),
        compaction: /compact/.test(String(row.source ?? "")),
      }));
    return { view: "context", seen: this.seen(), points };
  }
}
