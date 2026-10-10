import type { BackgroundTask, ChatMessage, ThinkingLevel, ToolUse } from "@/types";
import { agentIdFromOutput } from "./agent-tasks";

/**
 * The agent transcript modal: an agent's own transcript, opened from its card
 * in the chat or its row in Background Tasks, shown over the session and kept
 * scrolled to the latest message while the agent works.
 */

/** One agent, as the modal needs it. */
export interface AgentTarget {
  /** What the transcript is looked up by: the launching tool use id, or the
   *  agent id. The subagents route takes either. */
  id: string;
  /** Every id the task list may report the agent under: the agent id an
   *  async launch hands back, and the tool use id before that is known. */
  taskIds: string[];
  agentType?: string;
  model?: string;
  description?: string;
  prompt?: string;
  /** The launching tool use, when opened from its card. Its nested calls and
   *  result stand in when no transcript was recorded. */
  tool?: ToolUse;
}

function inputOf(tool: ToolUse): Record<string, unknown> {
  try {
    const parsed = JSON.parse(tool.input || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function agentFromTool(tool: ToolUse): AgentTarget {
  const input = inputOf(tool);
  const agentId = agentIdFromOutput(tool.output);
  return {
    id: tool.id,
    taskIds: agentId ? [agentId, tool.id] : [tool.id],
    agentType: text(input.subagent_type),
    model: text(input.model),
    description: text(input.description),
    prompt: text(input.prompt),
    tool,
  };
}

export function agentFromTask(task: BackgroundTask): AgentTarget {
  return {
    id: task.toolUseId,
    taskIds: [task.toolUseId],
    // "Agent" is what the task list says when it does not know the type.
    agentType: task.title && task.title !== "Agent" ? task.title : undefined,
    description: task.description,
  };
}

export function agentRunning(agent: AgentTarget, tasks: BackgroundTask[]): boolean {
  return tasks.some((t) => t.status === "running" && agent.taskIds.includes(t.toolUseId));
}

/**
 * A transcript opens with the prompt the agent was handed, as a user message.
 * Splits that off from the work after it. With the prompt known from the
 * launch, a first message is taken as the prompt only when it repeats it.
 */
export function splitAgentTranscript(messages: ChatMessage[], prompt?: string): { prompt?: string; work: ChatMessage[] } {
  const [first, ...rest] = messages;
  if (first?.role !== "user") return { prompt, work: messages };
  if (!prompt) return { prompt: text(first.content), work: rest };
  return first.content.trim().startsWith(prompt.trim().slice(0, 200)) ? { prompt, work: rest } : { prompt, work: messages };
}

/** Whether a re-read transcript is the one on screen, so a poll that finds
 *  nothing new keeps the old array and nothing re-renders under the reader.
 *  The last message is compared whole: a tool's result lands on the message
 *  that made the call, which keeps its id. */
export function sameTranscript(prev: ChatMessage[] | null, next: ChatMessage[]): boolean {
  if (!prev || prev.length !== next.length) return false;
  return JSON.stringify(prev.at(-1)) === JSON.stringify(next.at(-1));
}

/** Within this many pixels of the end counts as reading the latest. */
const LATEST_SLACK_PX = 48;

export function atLatest(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= LATEST_SLACK_PX;
}

/** The levels as the composer names them, so a level reads the same wherever
 *  it appears. */
const EFFORT_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/**
 * The chips above an agent's transcript: its type, the model it is running on
 * and the thinking level it is running at.
 *
 * The model and the level come from the agent's own transcript rather than its
 * launch record, because that is the only place either is written down: a
 * launch names a model only when the caller overrode one (otherwise the agent
 * inherits the session's), and the level is recorded per turn by the CLI and
 * nowhere else. The newest message that named one wins, so a level changed
 * mid-run reads as the current one. Without a transcript, the launch's own
 * model still shows.
 */
export function agentTags(agent: AgentTarget, messages: ChatMessage[]): string[] {
  const newest = <T>(pick: (m: ChatMessage) => T | undefined): T | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const value = pick(messages[i]);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const effort = newest((m) => m.effort);
  return [agent.agentType, newest((m) => m.model) ?? agent.model, effort ? EFFORT_LABELS[effort] : undefined].filter(
    (tag): tag is string => !!tag,
  );
}
