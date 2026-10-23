// Thirty days of made-up telemetry for Insights, shaped like what Claude Code
// sends: turns with their requests, tool calls and waits, retries, edits,
// commits, and cockpit's own records of who answered each prompt. Spread over
// working hours, across the tour's sessions, its jobs' runs, and the providers
// they ran on.

import { TelemetryDb } from "../../src/server/telemetry/db";
import type { FlatRecord, ParsedBatch } from "../../src/server/telemetry/otlp";
import { loadSqlite } from "../../src/server/telemetry/sqlite";
import { random } from "./world";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Rec = Omit<FlatRecord, "source">;

export interface TelemetrySession {
  id: string;
  provider: string;
  model: string;
  /** Prompts its turns open with. */
  prompts: string[];
  /** Turn starts, newest last. */
  starts: number[];
  /** Absolute path of the repo it works in. */
  repo: string;
  /** Bigger, slower turns for real coding work; jobs are leaner. */
  weight: number;
}

/** USD per million tokens: input, output, cache read. */
const PRICES: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};

const SPEED: Record<string, { ttft: number; tps: number }> = {
  "claude-opus-5-5": { ttft: 2600, tps: 62 },
  "claude-sonnet-5-5": { ttft: 1500, tps: 88 },
  "claude-haiku-5-5": { ttft: 520, tps: 190 },
  "deepseek-v4-pro": { ttft: 1900, tps: 48 },
  "deepseek-flash": { ttft: 900, tps: 120 },
  "glm-5.3": { ttft: 1300, tps: 70 },
  "z-ai/glm-5.3": { ttft: 1500, tps: 66 },
};

const TOOLS = [
  { name: "Read", w: 30, ms: [40, 300] },
  { name: "Edit", w: 16, ms: [60, 400] },
  { name: "Bash", w: 18, ms: [600, 24_000] },
  { name: "Grep", w: 12, ms: [80, 900] },
  { name: "Glob", w: 6, ms: [40, 300] },
  { name: "Write", w: 5, ms: [60, 300] },
  { name: "WebFetch", w: 2, ms: [900, 4_000] },
  { name: "mcp__github__list_pull_requests", w: 2, ms: [400, 1_800] },
  { name: "mcp__github__get_pull_request_diff", w: 2, ms: [500, 2_400] },
  { name: "mcp__cockpit-config__update_issue", w: 2, ms: [30, 120] },
] as const;

const COMMANDS = [
  ["npm", "npm test"],
  ["npm", "npm run build"],
  ["npm", "npm run lint"],
  ["git", "git status"],
  ["git", "git diff --stat"],
  ["git", "git log --oneline -10"],
  ["rg", "rg -n checkout src"],
  ["npx", "npx tsc --noEmit"],
  ["gh", "gh pr list --state open"],
  ["npx", "npx playwright test e2e/checkout.spec.ts"],
] as const;

const FILES = [
  "src/routes/checkout.ts",
  "src/routes/cart.ts",
  "src/lib/auth.ts",
  "src/lib/rate-limit.ts",
  "src/services/orders.ts",
  "src/services/payments.ts",
  "src/webhooks/stripe.ts",
  "tests/checkout.test.ts",
  "tests/cart.test.ts",
  "docs/migration-v2.md",
];

const LANGUAGES = ["TypeScript", "TypeScript", "TypeScript", "Markdown", "JSON", "CSS"];

function pickWeighted<T extends { w: number }>(rand: () => number, items: readonly T[]): T {
  const total = items.reduce((n, i) => n + i.w, 0);
  let r = rand() * total;
  for (const item of items) {
    r -= item.w;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function hex(rand: () => number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/** One turn's records, and the answers cockpit recorded for it. */
function turn(session: TelemetrySession, start: number, prompt: string, rand: () => number, context: { size: number }) {
  const trace = hex(rand, 32);
  const promptId = `p-${hex(rand, 12)}`;
  const recs: Rec[] = [];
  const answers: Rec[] = [];
  const span = (name: string, id: string, parent: string | undefined, a: number, b: number, attrs: Record<string, unknown>): Rec => ({
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
  const log = (name: string, t: number, attrs: Record<string, unknown>): Rec => ({
    signal: "log",
    name,
    timeMs: t,
    traceId: trace,
    spanId: "1".repeat(16),
    promptId,
    attrs: { ...attrs, "prompt.id": promptId },
  });
  const metric = (name: string, t: number, value: number, attrs: Record<string, unknown>): Rec => ({
    signal: "metric",
    name,
    timeMs: t,
    value,
    attrs,
  });

  const interactionId = hex(rand, 16);
  recs.push(log("claude_code.user_prompt", start, { prompt, prompt_length: prompt.length }));
  const speed = SPEED[session.model] ?? { ttft: 1500, tps: 70 };
  const price = PRICES[session.model];
  const steps = Math.max(1, Math.round((2 + rand() * 6) * session.weight));
  let t = start + 400;
  let added = 0;
  let removed = 0;
  for (let s = 0; s < steps; s++) {
    // A request: the context grows with the conversation, most of it cached.
    context.size = Math.min(context.size + 3_000 + rand() * 9_000, 420_000);
    const fresh = Math.round(800 + rand() * 4_000);
    const cacheWrite = Math.round(rand() < 0.3 ? 2_000 + rand() * 6_000 : 0);
    const cacheRead = Math.max(0, Math.round(context.size - fresh - cacheWrite));
    const output = Math.round(120 + rand() * 1_400 * session.weight);
    const ttft = Math.round(speed.ttft * (0.6 + rand() * 0.9));
    const duration = Math.round(ttft + (output / speed.tps) * 1000);
    const retry = rand() < 0.025;
    if (retry) {
      const code = rand() < 0.6 ? "529" : "429";
      recs.push(
        log("claude_code.api_error", t + 1_200, {
          model: session.model,
          status_code: code,
          error: code === "529" ? "Overloaded" : "Rate limited",
          attempt: 1,
        }),
      );
      t += 4_000 + rand() * 6_000;
    }
    const requestId = hex(rand, 16);
    const usage = {
      model: session.model,
      input_tokens: fresh,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
    };
    const cost = price ? (fresh * price[0] + cacheWrite * price[0] * 1.25 + cacheRead * price[2] + output * price[1]) / 1e6 : 0.002;
    const subagent = rand() < 0.08;
    recs.push(
      span("claude_code.llm_request", requestId, interactionId, t, t + duration, {
        ...usage,
        ttft_ms: ttft,
        success: true,
        attempt: retry ? 2 : 1,
      }),
    );
    recs.push(
      log("claude_code.api_request", t + duration, {
        ...usage,
        cost_usd: Number(cost.toFixed(6)),
        duration_ms: duration,
        ttft_ms: ttft,
        query_source: subagent ? "agent:custom" : "repl_main_thread",
        effort: "high",
      }),
    );
    t += duration + 150;

    if (s === steps - 1) break;
    // The tools that request asked for, sometimes two at once.
    const calls = rand() < 0.3 ? 2 : 1;
    let longest = 0;
    for (let c = 0; c < calls; c++) {
      const tool = pickWeighted(rand, TOOLS);
      const toolId = hex(rand, 16);
      const useId = `toolu_${hex(rand, 20)}`;
      const asks = tool.name === "Bash" || tool.name.startsWith("mcp__");
      const youAnswer = asks && rand() < 0.18;
      const wait = youAnswer ? Math.round(2_000 + rand() * 40_000) : asks ? 70 + Math.round(rand() * 60) : 0;
      const run = Math.round(tool.ms[0] + rand() * (tool.ms[1] - tool.ms[0]));
      const failed = rand() < (tool.name === "Bash" ? 0.07 : 0.015);
      const attrs: Record<string, unknown> = { tool_name: tool.name, tool_use_id: useId };
      if (tool.name === "Bash") {
        const [argv0, command] = COMMANDS[Math.floor(rand() * COMMANDS.length)];
        attrs.bash_argv0 = argv0;
        attrs.full_command = command;
      } else if (["Read", "Edit", "Write"].includes(tool.name)) {
        attrs.file_path = `${session.repo}/${FILES[Math.floor(rand() * FILES.length)]}`;
      }
      const a = t;
      recs.push(span("claude_code.tool", toolId, interactionId, a, a + wait + run, attrs));
      if (wait) {
        recs.push(span("claude_code.tool.blocked_on_user", hex(rand, 16), toolId, a, a + wait, { decision: "accept", source: "hook" }));
        answers.push({
          signal: "log",
          name: "cockpit.permission_answer",
          timeMs: a,
          endMs: a + wait,
          value: wait,
          attrs: {
            tool_name: tool.name,
            tool_use_id: useId,
            kind: "permission",
            answered_by: youAnswer ? "you" : "bypass",
            decision: "allow",
          },
        });
      }
      recs.push(
        span("claude_code.tool.execution", hex(rand, 16), toolId, a + wait, a + wait + run, { success: !failed, tool_use_id: useId }),
      );
      recs.push(log("claude_code.tool_decision", a, { decision: "accept", source: asks ? "hook" : "config", tool_name: tool.name }));
      recs.push(
        log("claude_code.tool_result", a + wait + run, {
          tool_name: tool.name,
          success: String(!failed),
          duration_ms: String(run),
          tool_use_id: useId,
        }),
      );
      recs.push({
        signal: "log",
        name: "claude_code.hook_execution_complete",
        timeMs: a + 20,
        traceId: trace,
        spanId: "1".repeat(16),
        attrs: {
          hook_event: "PreToolUse",
          hook_name: "PreToolUse:*",
          total_duration_ms: 18 + Math.round(rand() * 60),
          num_blocking: 0,
          num_non_blocking_error: 0,
        },
      });
      if (tool.name === "Edit" || tool.name === "Write") {
        const plus = Math.round(2 + rand() * 40);
        const minus = Math.round(rand() * plus * 0.6);
        added += plus;
        removed += minus;
        recs.push(
          metric("claude_code.code_edit_tool.decision", a + run, 1, {
            decision: rand() < 0.94 ? "accept" : "reject",
            language: LANGUAGES[Math.floor(rand() * LANGUAGES.length)],
            tool_name: tool.name,
          }),
        );
      }
      longest = Math.max(longest, wait + run);
    }
    t += longest + 200;
  }
  if (added) {
    recs.push(metric("claude_code.lines_of_code.count", t, added, { type: "added", model: session.model }));
    recs.push(metric("claude_code.lines_of_code.count", t, removed, { type: "removed", model: session.model }));
  }
  if (rand() < 0.22 * session.weight) recs.push(metric("claude_code.commit.count", t, 1, {}));
  if (rand() < 0.07 * session.weight) recs.push(metric("claude_code.pull_request.count", t, 1, {}));
  recs.unshift(span("claude_code.interaction", interactionId, undefined, start, t, { user_prompt: prompt, "interaction.sequence": 1 }));
  return { recs, answers, end: t };
}

function batch(records: Rec[], resource: Record<string, unknown>): ParsedBatch {
  return {
    sources: [{ resource, scope: { name: "com.anthropic.claude_code.events" } }],
    records: records.map((r) => ({ ...r, source: 0 })),
    skipped: 0,
  };
}

/** Working-hours turn starts over the last `days` days, busier on weekdays. */
export function workdayStarts(now: number, days: number, perDay: number, rand: () => number): number[] {
  const out: number[] = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let d = days; d >= 0; d--) {
    const day = today.getTime() - d * DAY;
    const weekday = new Date(day).getDay();
    const n = weekday === 0 || weekday === 6 ? Math.round(perDay * 0.25 * rand()) : Math.round(perDay * (0.6 + rand() * 0.8));
    for (let i = 0; i < n; i++) {
      const hour = 9 + rand() * 9 + (rand() < 0.15 ? 3 : 0);
      const at = day + hour * HOUR;
      if (at < now - 10 * MIN) out.push(at);
    }
  }
  return out.sort((a, b) => a - b);
}

export function writeTelemetry(file: string, sessions: TelemetrySession[], now: number): number {
  const { sqlite, reason } = loadSqlite();
  if (!sqlite) throw new Error(reason ?? "no SQLite");
  const db = TelemetryDb.open(file, sqlite);
  const rand = random(42);
  let records = 0;
  try {
    for (const session of sessions) {
      const context = { size: 18_000 };
      const all: Rec[] = [];
      const answers: Rec[] = [];
      session.starts.forEach((start, i) => {
        // A new conversation now and then, so its context starts small again.
        if (rand() < 0.12) context.size = 18_000;
        const { recs, answers: a } = turn(session, start, session.prompts[i % session.prompts.length], rand, context);
        all.push(...recs);
        answers.push(...a);
      });
      const resource = { "service.name": "claude-code", "cockpit.session_id": session.id, "cockpit.provider": session.provider };
      // In slices, the size the receiver hands the store.
      for (let i = 0; i < all.length; i += 400) {
        db.ingest(
          { sessionId: session.id, spawnId: `spawn-${session.id.slice(0, 8)}`, receivedMs: now },
          batch(all.slice(i, i + 400), resource),
        );
      }
      if (answers.length)
        db.ingest({ sessionId: session.id, spawnId: "cockpit", receivedMs: now }, batch(answers, { "service.name": "cockpit" }));
      records += all.length + answers.length;
    }
  } finally {
    db.close();
  }
  return records;
}
