export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastActiveAt: number;
  status: "idle" | "running";
  model?: string;
}

export interface SessionGroup {
  cwd: string;
  dirName: string;
  sessions: SessionInfo[];
}

export interface ToolUse {
  id: string;
  name: string;
  input: string;
  output: string;
  filePath?: string;
  status: "running" | "done";
  children?: ToolUse[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolUse: ToolUse };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolUses: ToolUse[];
  blocks: ContentBlock[];
  timestamp: number;
}

export interface ContextUsage {
  used: number;
  total: number;
}

export interface BackgroundTask {
  taskId: string;
  toolUseId: string;
  status: "running" | "completed";
  description: string;
  activity?: string;
  summary?: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export type PermissionMode = "allow" | "allow_always" | "allow_all" | "deny";

export type ThinkingLevel = "low" | "medium" | "high";

export interface UsageLimit {
  /** Percentage 0-100 */
  utilization: number;
  resets_at: string;
}

export interface UsageLimits {
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_sonnet: UsageLimit | null;
  seven_day_opus: UsageLimit | null;
  extra_usage: {
    enabled: boolean;
    remaining_credits: number;
  } | null;
}

// Client -> Server messages
export type ClientMessage =
  | { type: "session:connect"; sessionId: string; cwd?: string }
  | { type: "message:send"; sessionId: string; text: string }
  | { type: "session:interrupt"; sessionId: string }
  | { type: "permission:response"; sessionId: string; requestId: string; allowed: boolean; permissionMode?: PermissionMode }
  | { type: "permission:set_bypass"; sessionId: string; enabled: boolean }
  | { type: "session:set_thinking"; sessionId: string; level: ThinkingLevel }
  | { type: "session:subscribe"; sessionIds: string[] }
  | { type: "question:response"; sessionId: string; requestId: string; answers: Record<string, string> }
  | { type: "ping" };

// Server -> Client messages
export type ServerMessage =
  | { type: "session:connected"; sessionId: string }
  | { type: "assistant:text"; sessionId: string; text: string }
  | { type: "assistant:thinking"; sessionId: string; text: string }
  | { type: "assistant:tool_use"; sessionId: string; name: string; input: string; toolId: string }
  | { type: "assistant:tool_result"; sessionId: string; toolId: string; output: string; filePath?: string }
  | { type: "assistant:message_done"; sessionId: string; message: ChatMessage }
  | { type: "assistant:tool_children"; sessionId: string; messageId: string; toolId: string; children: ToolUse[] }
  | { type: "session:status"; sessionId: string; status: "idle" | "running" }
  | { type: "session:error"; sessionId: string; error: string }
  | { type: "permission:request"; sessionId: string; requestId: string; toolName: string; input: string }
  | { type: "question:request"; sessionId: string; requestId: string; questions: string }
  | { type: "session:clear"; sessionId: string }
  | { type: "session:system"; sessionId: string; text: string }
  | { type: "session:info_updated"; sessionId: string; info: SessionInfo }
  | { type: "session:usage"; sessionId: string; usage: ContextUsage }
  | { type: "assistant:tool_progress"; sessionId: string; toolId: string; content: string }
  | { type: "session:rate_limit"; sessionId: string; status: string; retryAfterMs?: number }
  | { type: "session:suggestions"; sessionId: string; suggestions: string[] }
  | { type: "session:task_update"; sessionId: string; task: BackgroundTask }
  | { type: "session:todos"; sessionId: string; todos: TodoItem[] }
  | { type: "history"; sessionId: string; messages: ChatMessage[] }
  | { type: "pong" };
