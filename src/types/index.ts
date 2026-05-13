export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastActiveAt: number;
  status: "idle" | "running";
  model?: string;
  pendingRequestCount?: number;
}

export interface SessionGroup {
  cwd: string;
  dirName: string;
  sessions: SessionInfo[];
  totalSessionCount: number;
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

export interface ImageAttachment {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string; // base64
}

export interface DocumentAttachment {
  mediaType: "application/pdf";
  data: string; // base64
  name: string;
}

export interface TextFileAttachment {
  name: string;
  content: string;
  language?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; tokens?: number; durationMs?: number; redacted?: boolean }
  | { type: "tool_use"; toolUse: ToolUse };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolUses: ToolUse[];
  blocks: ContentBlock[];
  timestamp: number;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  textFiles?: TextFileAttachment[];
  model?: string;
}

export interface GlobalSearchResult {
  sessionId: string;
  sessionName: string;
  cwd: string;
  dirName: string;
  messageId: string;
  role: "user" | "assistant";
  timestamp: number;
  preview: string;
  matchStart: number;
  matchLength: number;
  fullContent: string;
}

export interface ContextUsage {
  used: number;
  total: number;
}

export interface BackgroundTask {
  taskId: string;
  toolUseId: string;
  status: "running" | "completed";
  title?: string;
  description: string;
  activity?: string;
  summary?: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface AccountInfo {
  email: string;
  organization: string;
  subscriptionType: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface InitAgentInfo {
  name: string;
  description?: string;
}

export interface InitData {
  slashCommands: string[];
  skills: string[];
  agents: InitAgentInfo[];
  version: string;
  model: string;
  mcpServers: { name: string; status: string }[];
  models?: ModelInfo[];
  account?: AccountInfo;
  commands?: CommandInfo[];
}

export type PermissionMode = "allow" | "allow_always" | "allow_all" | "deny";

export interface PermissionSuggestion {
  type: string;
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  mode?: string;
  directories?: string[];
  destination?: string;
}

export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

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

// Scheduled Jobs

export type SimpleScheduleFrequency = "hourly" | "daily" | "weekly" | "monthly";

export interface SimpleSchedule {
  type: "simple";
  frequency: SimpleScheduleFrequency;
  time?: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
}

export interface CronSchedule {
  type: "cron";
  expression: string;
}

export type JobSchedule = SimpleSchedule | CronSchedule;

export interface ScheduledJob {
  id: string;
  name: string;
  schedule: JobSchedule;
  schedules?: JobSchedule[];
  prompt: string;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  allowedTools?: string[];
  mcpServers?: string[];
  mcpToolFilters?: Record<string, string[]>;
  bypassPermissions?: boolean;
  maxDurationMinutes?: number;
  retentionDays?: number;
  skipIfMissed?: boolean;
  inboxOutput?: boolean;
  notifyProviders?: string[];
}

export type JobRunStatus = "running" | "success" | "failure" | "timeout";

export interface JobRunToolUse {
  name: string;
  input: string;
  output: string;
  timestamp: number;
  durationMs?: number;
  permitted?: boolean;
}

export interface JobRun {
  id: string;
  jobId: string;
  sessionId: string;
  status: JobRunStatus;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  toolsUsed: JobRunToolUse[];
  messageCount: number;
  prompt: string;
  cwd: string;
}

// Inbox
export type InboxPriority = "info" | "warning" | "error";

export interface InboxMessage {
  id: string;
  jobId?: string;
  jobName?: string;
  runId?: string;
  title: string;
  body: string;
  priority: InboxPriority;
  createdAt: number;
  read: boolean;
}

// Notifications
export interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
  priority: InboxPriority;
  source: string;
  providerIds?: string[];
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface NtfyConfig {
  serverUrl: string;
  topic: string;
  token?: string;
}

export interface NotificationProviderEntry {
  id: string;
  type: "telegram" | "ntfy";
  enabled: boolean;
  name: string;
  config: TelegramConfig | NtfyConfig;
  filter?: {
    priorities?: InboxPriority[];
    sources?: string[];
  };
}

export interface NotificationSettings {
  baseUrl?: string;
  providers: NotificationProviderEntry[];
}

// Client -> Server messages
export type ClientMessage =
  | { type: "session:connect"; sessionId: string; cwd?: string; lastMessageId?: string | null; historyView?: boolean }
  | { type: "message:send"; sessionId: string; text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] }
  | { type: "session:interrupt"; sessionId: string }
  | {
      type: "permission:response";
      sessionId: string;
      requestId: string;
      allowed: boolean;
      permissionMode?: PermissionMode;
      suggestionIndex?: number;
    }
  | { type: "permission:set_bypass"; sessionId: string; enabled: boolean }
  | { type: "session:set_plan_mode"; sessionId: string; enabled: boolean }
  | { type: "session:set_thinking"; sessionId: string; level: ThinkingLevel }
  | { type: "session:set_model"; sessionId: string; model: string }
  | { type: "session:set_model_slot"; sessionId: string; slot: "main" | "subagent" | "fast"; modelId: string }
  | { type: "session:restart"; sessionId: string }
  | { type: "session:subscribe"; sessionIds: string[] }
  | { type: "question:response"; sessionId: string; requestId: string; answers: Record<string, string> }
  | { type: "message:cancel_queued"; sessionId: string }
  | { type: "message:pause_queue"; sessionId: string }
  | { type: "message:resume_queue"; sessionId: string }
  | { type: "message:delete_queued"; sessionId: string; messageId: string }
  | { type: "message:edit_queued"; sessionId: string; messageId: string }
  | { type: "history:request_more"; sessionId: string; beforeMessageId: string }
  | { type: "ping" };

// Server -> Client messages
export type ServerMessage =
  | { type: "session:connected"; sessionId: string }
  | { type: "assistant:text"; sessionId: string; text: string }
  | { type: "assistant:thinking"; sessionId: string; text: string; tokens?: number; durationMs?: number; redacted?: boolean }
  | { type: "assistant:tool_use"; sessionId: string; name: string; input: string; toolId: string; isMainThread?: boolean }
  | { type: "assistant:tool_result"; sessionId: string; toolId: string; output: string; filePath?: string }
  | { type: "assistant:message_done"; sessionId: string; message: ChatMessage }
  | { type: "assistant:tool_children"; sessionId: string; messageId: string; toolId: string; children: ToolUse[] }
  | { type: "session:status"; sessionId: string; status: "idle" | "running" }
  | { type: "session:pending"; sessionId: string; count: number }
  | { type: "session:error"; sessionId: string; error: string }
  | {
      type: "permission:request";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: string;
      suggestions?: PermissionSuggestion[];
      planFilePath?: string;
      planContent?: string;
    }
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
  | { type: "session:init"; sessionId: string; data: InitData }
  | { type: "history"; sessionId: string; messages: ChatMessage[]; delta?: boolean; status?: "idle" | "running"; hasMore?: boolean }
  | { type: "history:more"; sessionId: string; messages: ChatMessage[]; hasMore: boolean }
  | {
      type: "session:streaming_snapshot";
      sessionId: string;
      messageId: string;
      content: string;
      toolUses: ToolUse[];
      blocks: ContentBlock[];
    }
  | {
      type: "session:queued";
      sessionId: string;
      count: number;
      cancelledText?: string;
      sentText?: string;
      messages?: Array<{ id: string; text: string }>;
      paused?: boolean;
      editText?: string;
    }
  | { type: "message:ack"; sessionId: string }
  | { type: "pong" };

export interface ModelSlots {
  main?: string;
  subagent?: string;
  fast?: string;
}

export interface ProviderModel {
  modelId: string;
  displayName: string;
  effortLevels: ThinkingLevel[];
  supportsExtendedContext?: boolean;
  defaultEffort?: ThinkingLevel;
}

export interface Provider {
  id: string;
  name: string;
  envVars: Record<string, string>;
  models: ProviderModel[];
  isBuiltin?: boolean;
}
