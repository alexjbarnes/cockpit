import { v4 as uuidv4 } from "uuid";
import type { ChatMessage } from "@/types";
import type { ParsedEvent } from "./event-parser";
import type { HookEventName } from "./hook-router";

/**
 * Convert a single hook payload from claude into ParsedEvent objects that
 * the existing stream-processor / session emitter pipeline can consume.
 *
 * Pure function: no state, no side effects. The session manager owns
 * status tracking, permission request bookkeeping, and emission.
 *
 * Returns an empty array for events that don't map to a ParsedEvent
 * (e.g. UserPromptExpansion, which only confirms a prompt landed).
 */
export function translateHookEvent(eventName: HookEventName, payload: Record<string, unknown>): ParsedEvent[] {
  switch (eventName) {
    case "PreToolUse":
      return translatePreToolUse(payload);
    case "PostToolUse":
      return translatePostToolUse(payload);
    case "Stop":
      return translateStop(payload);
    case "StopFailure":
      return translateStopFailure(payload);
    case "PermissionRequest":
      return translatePermissionRequest(payload);
    case "Notification":
      return translateNotification(payload);
    case "SubagentStart":
      return translateSubagentStart(payload);
    case "SubagentStop":
      return translateSubagentStop(payload);
    case "PreCompact":
      return translatePreCompact(payload);
    case "PostCompact":
      return translatePostCompact(payload);
    // A prompt submission opens a parent turn, so the session is working from
    // here until its Stop. The CLI submits one itself when it resumes the
    // parent after a launched agent finishes; without this, a resumed turn that
    // replies in text alone never emitted anything that marked the session
    // running, and the in-progress indicator stayed off until it happened to
    // call a tool.
    case "UserPromptSubmit":
      return [{ type: "system_message", text: "__turn_start" }];
    case "UserPromptExpansion":
      return [];
  }
}

/** PermissionRequest payloads don't carry a request ID; cockpit synthesises one. */
export function newPermissionRequestId(): string {
  return uuidv4();
}

function translatePreToolUse(payload: Record<string, unknown>): ParsedEvent[] {
  const toolName = stringOr(payload.tool_name, "unknown");
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const toolId = stringOr(payload.tool_use_id, "");
  const events: ParsedEvent[] = [
    {
      type: "system_message",
      text: "__tool_use_start",
    },
    {
      type: "tool_use_start",
      toolName,
      toolId: toolId || undefined,
      toolInput: toolInput ? JSON.stringify(toolInput) : "",
    },
  ];
  if (toolName === "EnterPlanMode") {
    events.push({ type: "system_message", text: "__permission_mode::plan" });
  }
  return events;
}

function translatePostToolUse(payload: Record<string, unknown>): ParsedEvent[] {
  const toolName = stringOr(payload.tool_name, "unknown");
  const toolId = stringOr(payload.tool_use_id, "");
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const response = payload.tool_response;
  const output = extractToolOutput(response);
  const filePath = extractFilePath(toolInput);
  const events: ParsedEvent[] = [
    {
      type: "tool_result",
      toolId: toolId || undefined,
      toolOutput: output,
      filePath,
    },
  ];
  if (toolName === "ExitPlanMode") {
    events.push({ type: "system_message", text: "__permission_mode::standard" });
  }
  return events;
}

function translateStop(payload: Record<string, unknown>): ParsedEvent[] {
  const text = stringOr(payload.last_assistant_message, "");
  const message: ChatMessage = {
    id: uuidv4(),
    role: "assistant",
    content: text,
    toolUses: [],
    blocks: [],
    timestamp: Date.now(),
  };
  // Stop fires when the turn ends, which for a launched agent is while it is
  // still working — and its payload says so. Syncing here is what keeps a
  // running agent on screen instead of being cleared with the turn.
  return [{ type: "message_done", message }, ...translateBackgroundTasks(payload)];
}

function translateStopFailure(payload: Record<string, unknown>): ParsedEvent[] {
  const errorType = stringOr(payload.error_type, "unknown");
  const errorMessage = stringOr(payload.error_message, "Unknown error");
  const message: ChatMessage = {
    id: uuidv4(),
    role: "assistant",
    content: "",
    toolUses: [],
    blocks: [],
    timestamp: Date.now(),
  };
  return [
    { type: "message_done", message },
    { type: "system_message", text: `__stop_failure::${errorType}::${errorMessage}` },
  ];
}

function translatePermissionRequest(payload: Record<string, unknown>): ParsedEvent[] {
  const toolName = stringOr(payload.tool_name, "unknown");
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;

  return [
    {
      type: "permission_request",
      requestId: newPermissionRequestId(),
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : "",
      rawToolInput: toolInput,
    },
  ];
}

/** The CLI's own list of in-flight background work, attached to Stop and
 *  SubagentStop payloads. This is authoritative: it is the only thing that
 *  says an agent is still running after the turn that launched it has ended,
 *  which is precisely when a launched agent does its work. */
interface CliBackgroundTask {
  id?: string;
  type?: string;
  status?: string;
  description?: string;
  agent_type?: string;
}

function translateBackgroundTasks(payload: Record<string, unknown>): ParsedEvent[] {
  const raw = payload.background_tasks;
  if (!Array.isArray(raw)) return [];
  const tasks = (raw as CliBackgroundTask[])
    .filter((t) => stringOr(t.id, ""))
    .map((t) => {
      const id = stringOr(t.id, "");
      const agentType = stringOr(t.agent_type, "");
      return {
        taskId: id,
        toolUseId: id,
        status: t.status === "running" ? ("running" as const) : ("completed" as const),
        title: agentType || "Agent",
        description: stringOr(t.description, "") || agentType || "Agent",
      };
    });
  // An empty array is meaningful — it says nothing is running — so the sync is
  // emitted either way and replaces whatever the client was holding.
  return [{ type: "task_sync", tasks }];
}

function translateSubagentStart(payload: Record<string, unknown>): ParsedEvent[] {
  // Keyed by agent id, not session id: the session id is the PARENT's, so
  // every agent in a session used to collide onto one entry and the first
  // completion cleared them all. SubagentStart carries no description, so the
  // agent type stands in until the tool use supplies one.
  // No uuid fallback: taskId doubles as the transcript lookup key (the
  // `agent-<id>.jsonl` suffix), so a synthesised id is one that can never
  // match a meta sidecar — it produced a card permanently reporting no
  // transcript while the file sat on disk. An agent id is always present in
  // practice; dropping the event is better than emitting an uncorrelatable
  // card.
  const agentId = stringOr(payload.agent_id, "");
  if (!agentId) return [];
  const agentType = stringOr(payload.agent_type, "");
  const description = stringOr(payload.description, "");
  return [
    {
      type: "task_update",
      taskInfo: {
        taskId: agentId,
        toolUseId: agentId,
        status: "running",
        title: agentType || "Agent",
        description: description || agentType || "Subagent running",
      },
    },
  ];
}

function translateSubagentStop(payload: Record<string, unknown>): ParsedEvent[] {
  // Same reasoning as translateSubagentStart, but the sibling task sync below
  // is still worth emitting without an agent id.
  const agentId = stringOr(payload.agent_id, "");
  if (!agentId) return translateBackgroundTasks(payload);
  const agentType = stringOr(payload.agent_type, "");
  const lastMessage = stringOr(payload.last_assistant_message, "");
  const description = stringOr(payload.description, "");
  return [
    {
      type: "task_update",
      taskInfo: {
        taskId: agentId,
        toolUseId: agentId,
        status: "completed",
        title: agentType || "Agent",
        description: description || agentType || "Subagent completed",
        summary: lastMessage.slice(0, 500) || undefined,
      },
    },
    // The payload also carries the post-stop task list; sync it so siblings
    // that are still working stay visible.
    ...translateBackgroundTasks(payload),
  ];
}

function translatePreCompact(_payload: Record<string, unknown>): ParsedEvent[] {
  return [{ type: "system_message", text: "__compact::hook_start" }];
}

/**
 * The CLI sends `trigger: "auto" | "manual"` on both compact hooks, and the
 * distinction decides whether the turn is over. An auto-compact fires mid-turn
 * once the context fills and the CLI resumes the same turn by itself a few
 * seconds later; only a manual /compact leaves nothing to resume. Carry the
 * trigger through so the session manager can tell them apart.
 *
 * An older CLI that omits the field falls back to the manual path, which is
 * what cockpit did unconditionally before.
 */
function translatePostCompact(payload: Record<string, unknown>): ParsedEvent[] {
  const auto = stringOr(payload.trigger, "") === "auto";
  return [{ type: "system_message", text: `__compact::hook_done::${auto ? "auto" : "manual"}` }];
}

function translateNotification(payload: Record<string, unknown>): ParsedEvent[] {
  const message = stringOr(payload.message, "");
  if (!message) return [];
  return [{ type: "system_message", text: `__notification::${message}` }];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function extractToolOutput(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (typeof obj.stdout === "string") {
      let out = obj.stdout;
      if (typeof obj.stderr === "string" && obj.stderr.length > 0) out += `\n${obj.stderr}`;
      return out;
    }
    if (typeof obj.content === "string") return obj.content;
    return JSON.stringify(response);
  }
  return String(response);
}

function extractFilePath(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) return undefined;
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.filePath === "string") return toolInput.filePath;
  if (typeof toolInput.path === "string") return toolInput.path;
  return undefined;
}
