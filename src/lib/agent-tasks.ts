import type { BackgroundTask, ChatMessage, ToolUse } from "@/types";

// The header's task list cannot be built from hooks alone. SubagentStop fires
// on completion, but no start event arrives for an async agent, so a running
// agent was never announced and the panel sat empty while work was in flight.
// Every agent is already in the message stream as an "Agent" tool use, so the
// list is derived from there and hook events are folded in on top for
// completion (and for anything the stream never saw).

/** An async launch returns immediately with the agent id it will report under;
 *  the tool use is "done" at that point while the agent keeps running. */
const ASYNC_LAUNCH_RE = /async agent launched/i;
const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9_-]+)/;

/** The launch result is addressed to the model, not to a person: the CLI
 *  labels it "internal metadata" and tells the model never to quote it. It
 *  carries the agent id, a SendMessage recipe, the JSONL path and a warning
 *  not to read that path. None of it belongs on screen. */
export function isAsyncLaunchOutput(output: string | undefined): boolean {
  return ASYNC_LAUNCH_RE.test(output ?? "");
}

export function agentIdFromOutput(output: string | undefined): string | undefined {
  return output?.match(AGENT_ID_RE)?.[1];
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Agent tool uses anywhere in a message, including ones nested under a parent
 *  agent (an agent that launches its own agents). */
function collectAgentTools(tools: ToolUse[] | undefined, out: ToolUse[]): void {
  for (const t of tools ?? []) {
    if (t.name === "Agent") out.push(t);
    collectAgentTools(t.children, out);
  }
}

/**
 * @param sessionActive whether the session is mid-turn. An async agent leaves
 *   no completion record in the transcript, so without this every past session
 *   would reopen showing its long-finished agents as still running.
 */
export function deriveAgentTasks(messages: ChatMessage[], hookTasks: BackgroundTask[], sessionActive = true): BackgroundTask[] {
  // Hook events are keyed by the agent id the CLI reports, which is the id an
  // async launch hands back in its output — that is the join between the two
  // sources.
  const hookById = new Map(hookTasks.map((t) => [t.toolUseId, t]));
  const derived: BackgroundTask[] = [];
  const claimed = new Set<string>();

  const agentTools: ToolUse[] = [];
  for (const m of messages) collectAgentTools(m.toolUses, agentTools);

  for (const tool of agentTools) {
    const input = parseInput(tool.input);
    const asyncLaunch = ASYNC_LAUNCH_RE.test(tool.output || "");
    const agentId = tool.output?.match(AGENT_ID_RE)?.[1];
    const key = agentId ?? tool.id;
    if (claimed.has(key)) continue;
    // Claim both ids: a completion can arrive under either (see below), and
    // both must be excluded from the hook-only pass so neither duplicates.
    claimed.add(key);
    claimed.add(tool.id);

    // A completion is reported under a different id per runtime: the PTY
    // SubagentStop uses the runtime agent id (matching `key`), while the
    // stream task_notification uses the launching tool_use id (matching
    // tool.id). Match either, or an async agent hangs on the sessionActive
    // fallback until the whole turn ends even though it finished long ago.
    const hook = hookById.get(key) ?? hookById.get(tool.id);
    // The CLI's own report wins outright when there is one: it is the only
    // source that knows an agent is still working after the turn that
    // launched it ended. Without it, a synchronous agent is finished when its
    // tool use is, while an async one completes its tool use at launch and so
    // is judged by whether the session is still working.
    const finished = hook ? hook.status === "completed" : asyncLaunch ? !sessionActive : tool.status === "done";

    const description = str(input.description) ?? str(input.prompt) ?? hook?.description ?? "Agent";
    derived.push({
      taskId: key,
      toolUseId: key,
      status: finished ? "completed" : "running",
      title: str(input.subagent_type) ?? hook?.title ?? "Agent",
      description: description.length > 200 ? `${description.slice(0, 200)}…` : description,
      activity: hook?.activity,
      summary: hook?.summary,
    });
  }

  // Hook-only tasks (a completion for an agent whose tool use is not in the
  // loaded window, or a task from some other source) still belong in the list.
  for (const t of hookTasks) {
    if (!claimed.has(t.toolUseId)) derived.push(t);
  }

  return derived;
}
