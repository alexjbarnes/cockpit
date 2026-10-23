// A small, fully known telemetry store for Insights tests: three sessions on
// three providers, shaped like what Claude Code 2.1.303 sends. Used by the
// database tests (raw numbers) and the Insights browser spec (priced and
// labelled ones), so both check the same arithmetic.
//
//   Login fix      Anthropic (stamped), 2 hours ago: 2 requests, a Bash call
//                  that waited 8 s for the user and failed, an overloaded
//                  request retried, lines and a commit.
//   Inbox summary  seed-cheap, NOT stamped (old data): its provider comes from
//                  the session's prefs. A day ago: a request and a title
//                  request, a Read (bypass answered) and an MCP call.
//   Hello test     seed-noprice (stamped), 90 minutes ago: one request on a
//                  model with no price.

import { TelemetryDb } from "@/server/telemetry/db";
import type { FlatRecord, ParsedBatch } from "@/server/telemetry/otlp";
import type { SqliteModule } from "@/server/telemetry/sqlite";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const SEED = {
  anthropic: { id: "sess-anthropic-0001", name: "Login fix", model: "claude-opus-5-5", trace: "a".repeat(32) },
  catalogue: { id: "sess-catalogue-0002", name: "Inbox summary", model: "seed-flash", provider: "seed-cheap", trace: "b".repeat(32) },
  unpriced: { id: "sess-unpriced-0003", name: "Hello test", model: "seed-mystery", provider: "seed-noprice", trace: "c".repeat(32) },
  /** Prices for seed-cheap's model, USD per million tokens. */
  pricing: { inPerM: 1, outPerM: 2, cacheReadPerM: 0.1 },
};

/** When each session's turn started, from the seed's `now`. */
export function seedTimes(now: number) {
  return { anthropic: now - 2 * HOUR, catalogue: now - DAY, unpriced: now - 1.5 * HOUR };
}

type Rec = Omit<FlatRecord, "source">;

const span = (
  name: string,
  trace: string,
  id: string,
  parent: string | undefined,
  a: number,
  b: number,
  attrs: Record<string, unknown>,
): Rec => ({
  signal: "span",
  name,
  timeMs: a,
  endMs: b,
  value: b - a,
  traceId: trace,
  spanId: id,
  ...(parent ? { parentSpanId: parent } : {}),
  attrs,
});

const log = (name: string, trace: string, t: number, attrs: Record<string, unknown>, promptId?: string): Rec => ({
  signal: "log",
  name,
  timeMs: t,
  traceId: trace,
  spanId: "1".repeat(16),
  ...(promptId ? { promptId } : {}),
  attrs: { ...attrs, ...(promptId ? { "prompt.id": promptId } : {}) },
});

const metric = (name: string, t: number, value: number, attrs: Record<string, unknown>): Rec => ({
  signal: "metric",
  name,
  timeMs: t,
  value,
  attrs,
});

function request(model: string, tokens: [number, number, number, number], extra: Record<string, unknown>) {
  const [input, output, cacheRead, cacheWrite] = tokens;
  return { model, input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_creation_tokens: cacheWrite, ...extra };
}

function batch(records: Rec[], resource: Record<string, unknown>): ParsedBatch {
  return {
    sources: [{ resource, scope: { name: "com.anthropic.claude_code.events" } }],
    records: records.map((r) => ({ ...r, source: 0 })),
    skipped: 0,
  };
}

export function seedRecords(now: number): Array<{ sessionId: string; spawnId: string; batch: ParsedBatch }> {
  const t = seedTimes(now);
  const A = SEED.anthropic;
  const B = SEED.catalogue;
  const C = SEED.unpriced;
  const a = t.anthropic;
  const b = t.catalogue;
  const c = t.unpriced;

  const anthropic: Rec[] = [
    span("claude_code.interaction", A.trace, "ia", undefined, a, a + 60_000, {
      user_prompt: "Fix the login bug",
      "interaction.sequence": 1,
    }),
    log("claude_code.user_prompt", A.trace, a, { prompt: "Fix the login bug", prompt_length: 17 }, "p-a1"),
    span("claude_code.llm_request", A.trace, "la1", "ia", a + 1_000, a + 11_000, {
      ...request(A.model, [1_000, 500, 9_000, 0], { ttft_ms: 2_000, success: true, attempt: 1 }),
    }),
    log(
      "claude_code.api_request",
      A.trace,
      a + 11_000,
      request(A.model, [1_000, 500, 9_000, 0], {
        cost_usd: 0.5,
        duration_ms: 10_000,
        ttft_ms: 2_000,
        query_source: "repl_main_thread",
        effort: "high",
      }),
      "p-a1",
    ),
    span("claude_code.tool", A.trace, "ta1", "ia", a + 12_000, a + 30_000, {
      tool_name: "Bash",
      bash_argv0: "npm",
      full_command: "npm test",
      tool_use_id: "tu-a1",
    }),
    span("claude_code.tool.blocked_on_user", A.trace, "wa1", "ta1", a + 12_000, a + 20_000, { decision: "accept", source: "hook" }),
    span("claude_code.tool.execution", A.trace, "xa1", "ta1", a + 20_000, a + 30_000, { success: false, tool_use_id: "tu-a1" }),
    log("claude_code.tool_decision", A.trace, a + 12_000, { decision: "accept", source: "hook", tool_name: "Bash" }, "p-a1"),
    log(
      "claude_code.tool_result",
      A.trace,
      a + 30_000,
      { tool_name: "Bash", success: "false", duration_ms: "10000", tool_use_id: "tu-a1" },
      "p-a1",
    ),
    log("claude_code.hook_execution_complete", A.trace, a + 12_050, {
      hook_event: "PreToolUse",
      hook_name: "PreToolUse:*",
      total_duration_ms: 50,
      num_blocking: 0,
      num_non_blocking_error: 0,
    }),
    log("claude_code.api_error", A.trace, a + 31_000, { model: A.model, status_code: "529", error: "Overloaded", attempt: 1 }, "p-a1"),
    span("claude_code.llm_request", A.trace, "la2", "ia", a + 31_000, a + 59_000, {
      ...request(A.model, [2_000, 1_000, 10_000, 1_000], { ttft_ms: 3_000, success: true, attempt: 2 }),
    }),
    log(
      "claude_code.api_request",
      A.trace,
      a + 59_000,
      request(A.model, [2_000, 1_000, 10_000, 1_000], {
        cost_usd: 1,
        duration_ms: 28_000,
        ttft_ms: 3_000,
        query_source: "repl_main_thread",
        effort: "high",
      }),
      "p-a1",
    ),
    metric("claude_code.lines_of_code.count", a + 40_000, 30, { type: "added", model: A.model }),
    metric("claude_code.lines_of_code.count", a + 40_000, 5, { type: "removed", model: A.model }),
    metric("claude_code.code_edit_tool.decision", a + 40_000, 2, { decision: "accept", language: "TypeScript", tool_name: "Edit" }),
    metric("claude_code.code_edit_tool.decision", a + 40_000, 1, { decision: "reject", language: "TypeScript", tool_name: "Edit" }),
    metric("claude_code.commit.count", a + 50_000, 1, {}),
  ];

  const catalogue: Rec[] = [
    span("claude_code.interaction", B.trace, "ib", undefined, b, b + 20_000, {
      user_prompt: "Summarise the inbox",
      "interaction.sequence": 1,
    }),
    log("claude_code.user_prompt", B.trace, b, { prompt: "Summarise the inbox", prompt_length: 19 }, "p-b1"),
    span("claude_code.llm_request", B.trace, "lb1", "ib", b + 1_000, b + 6_000, {
      ...request(B.model, [100_000, 2_000, 400_000, 0], { ttft_ms: 500, success: true, attempt: 1 }),
    }),
    // Claude Code's cost here is at Anthropic's prices, as it is for every
    // model: Insights must show the catalogue's figure instead.
    log(
      "claude_code.api_request",
      B.trace,
      b + 6_000,
      request(B.model, [100_000, 2_000, 400_000, 0], {
        cost_usd: 3,
        duration_ms: 5_000,
        ttft_ms: 500,
        query_source: "repl_main_thread",
        effort: "max",
      }),
      "p-b1",
    ),
    log(
      "claude_code.api_request",
      B.trace,
      b + 6_500,
      request(B.model, [100, 10, 0, 0], {
        cost_usd: 0.001,
        duration_ms: 400,
        ttft_ms: 300,
        query_source: "generate_session_title",
        effort: "max",
      }),
      "p-b1",
    ),
    span("claude_code.tool", B.trace, "tb1", "ib", b + 7_000, b + 8_000, {
      tool_name: "Read",
      file_path: "/repo/src/app.ts",
      tool_use_id: "tu-b1",
    }),
    span("claude_code.tool.blocked_on_user", B.trace, "wb1", "tb1", b + 7_000, b + 7_090, { decision: "accept", source: "hook" }),
    span("claude_code.tool.execution", B.trace, "xb1", "tb1", b + 7_090, b + 8_000, { success: true, tool_use_id: "tu-b1" }),
    span("claude_code.tool", B.trace, "tb2", "ib", b + 9_000, b + 10_000, { tool_name: "mcp__gmail__read_email", tool_use_id: "tu-b2" }),
    span("claude_code.tool.execution", B.trace, "xb2", "tb2", b + 9_000, b + 10_000, { success: true, tool_use_id: "tu-b2" }),
    log("claude_code.tool_decision", B.trace, b + 7_000, { decision: "accept", source: "config", tool_name: "Read" }, "p-b1"),
    log("claude_code.tool_result", B.trace, b + 8_000, { tool_name: "Read", success: "true", duration_ms: "910" }, "p-b1"),
    log("claude_code.tool_result", B.trace, b + 10_000, { tool_name: "mcp_tool", success: "true", duration_ms: "1000" }, "p-b1"),
    log("claude_code.mcp_server_connection", B.trace, b + 500, { server_name: "gmail", status: "connected", duration_ms: 60 }),
    log("claude_code.mcp_server_connection", B.trace, b + 600, { server_name: "broken", status: "failed", duration_ms: 5_000 }),
  ];

  const unpriced: Rec[] = [
    span("claude_code.interaction", C.trace, "ic", undefined, c, c + 10_000, { user_prompt: "Hello", "interaction.sequence": 1 }),
    log("claude_code.user_prompt", C.trace, c, { prompt: "Hello", prompt_length: 5 }, "p-c1"),
    span("claude_code.llm_request", C.trace, "lc1", "ic", c + 1_000, c + 4_000, {
      ...request(C.model, [50, 20, 0, 0], { ttft_ms: 800, success: true, attempt: 1 }),
    }),
    log(
      "claude_code.api_request",
      C.trace,
      c + 4_000,
      request(C.model, [50, 20, 0, 0], {
        cost_usd: 0.02,
        duration_ms: 3_000,
        ttft_ms: 800,
        query_source: "repl_main_thread",
        effort: "low",
      }),
      "p-c1",
    ),
  ];

  // Cockpit's own records of who answered each prompt.
  const answer = (tool: string, toolUseId: string, from: number, ms: number, who: string): Rec => ({
    signal: "log",
    name: "cockpit.permission_answer",
    timeMs: from,
    endMs: from + ms,
    value: ms,
    attrs: { tool_name: tool, tool_use_id: toolUseId, kind: "permission", answered_by: who, decision: "allow" },
  });

  const resource = (sessionId: string, provider?: string) => ({
    "service.name": "claude-code",
    "cockpit.session_id": sessionId,
    ...(provider ? { "cockpit.provider": provider } : {}),
  });

  return [
    { sessionId: A.id, spawnId: "spawn-a", batch: batch(anthropic, resource(A.id, "anthropic")) },
    { sessionId: B.id, spawnId: "spawn-b", batch: batch(catalogue, resource(B.id)) },
    { sessionId: C.id, spawnId: "spawn-c", batch: batch(unpriced, resource(C.id, C.provider)) },
    {
      sessionId: A.id,
      spawnId: "cockpit",
      batch: batch([answer("Bash", "tu-a1", a + 12_000, 8_000, "you")], { "service.name": "cockpit" }),
    },
    {
      sessionId: B.id,
      spawnId: "cockpit",
      batch: batch([answer("Read", "tu-b1", b + 7_000, 90, "bypass")], { "service.name": "cockpit" }),
    },
  ];
}

/** Write the seed into a telemetry database, received now so retention keeps it. */
export function seedInsightsDb(file: string, sqlite: SqliteModule, now: number): void {
  const db = TelemetryDb.open(file, sqlite);
  try {
    for (const { sessionId, spawnId, batch: b } of seedRecords(now)) db.ingest({ sessionId, spawnId, receivedMs: now }, b);
  } finally {
    db.close();
  }
}

/** Cockpit's own config for the seeded sessions: their names, and the prefs
 *  model that names the unstamped session's provider. */
export const SEED_PREFS = {
  [SEED.anthropic.id]: { name: SEED.anthropic.name, model: SEED.anthropic.model },
  [SEED.catalogue.id]: { name: SEED.catalogue.name, model: `${SEED.catalogue.provider}:${SEED.catalogue.model}` },
  [SEED.unpriced.id]: { name: SEED.unpriced.name, model: `${SEED.unpriced.provider}:${SEED.unpriced.model}` },
};

/** Custom providers for the seed's two non-Anthropic models: one priced, one not. */
export const SEED_PROVIDERS = [
  {
    id: SEED.catalogue.provider,
    name: "Seed Cheap",
    envVars: {},
    models: [{ modelId: SEED.catalogue.model, displayName: "Seed Flash", effortLevels: [], contextSizes: ["200k"], pricing: SEED.pricing }],
  },
  {
    id: SEED.unpriced.provider,
    name: "Seed No Price",
    envVars: {},
    models: [{ modelId: SEED.unpriced.model, displayName: "Seed Mystery", effortLevels: [], contextSizes: ["200k"] }],
  },
];
