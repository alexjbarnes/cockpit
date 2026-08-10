import type { ContextSize } from "@/lib/models";

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastActiveAt: number;
  status: "idle" | "running";
  model?: string;
  contextSize?: ContextSize;
  runtime?: "pty" | "stream";
  pendingRequestCount?: number;
  /** Subagents the session launched that are still running. A session can be
   *  idle and accepting input while these work on. */
  agentCount?: number;
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

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface UsageLimit {
  /** Percentage 0-100 */
  utilization: number;
  resets_at: string;
}

/** One entry of the oauth/usage `limits` array — the current shape of the
 *  Anthropic usage API. `weekly_scoped` entries carry the model the limit is
 *  scoped to (e.g. Fable) in scope.model.display_name. */
export interface ScopedUsageLimit {
  kind: string;
  group?: string;
  percent: number;
  severity?: string;
  resets_at: string;
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
  is_active?: boolean;
}

export interface UsageLimits {
  five_hour: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_sonnet: UsageLimit | null;
  seven_day_opus: UsageLimit | null;
  /** Preferred source when present: covers session, weekly-all, and
   *  model-scoped weekly limits the legacy fields no longer carry. */
  limits?: ScopedUsageLimit[] | null;
  extra_usage: {
    enabled: boolean;
    remaining_credits: number;
  } | null;
}

// Scheduled Jobs

/** Canonical list; SimpleScheduleFrequency derives from it (same pattern as
 *  ISSUE_STATUSES) so validators and tool schemas can't drift from the type. */
export const SIMPLE_SCHEDULE_FREQUENCIES = ["hourly", "daily", "weekly", "monthly"] as const;
export type SimpleScheduleFrequency = (typeof SIMPLE_SCHEDULE_FREQUENCIES)[number];

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

/**
 * Fires when an issue transitions into `status` (including a brand-new issue
 * arriving in its initial status — see issue-storage.ts's saveIssue). There is
 * no cron form for this: it has no time-of-day, so cron-utils.ts's
 * scheduleToCron/getNextRunTime are typed to exclude it, and every other
 * schedule-shape consumer (the 60s tick, describeSchedule, missed-run catch-up)
 * has to account for it explicitly rather than falling through a case that
 * assumes every schedule is time-based.
 */
export interface IssueStatusSchedule {
  type: "onIssueStatus";
  status: IssueStatus;
  /** Project id; absent means any project. */
  project?: string;
}

export type JobSchedule = SimpleSchedule | CronSchedule | IssueStatusSchedule;

export interface ScheduledJob {
  id: string;
  name: string;
  schedules: JobSchedule[];
  prompt: string;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  model?: string;
  contextSize?: ContextSize;
  thinkingLevel?: ThinkingLevel;
  allowedTools?: string[];
  mcpServers?: string[];
  mcpToolFilters?: Record<string, string[]>;
  bypassPermissions?: boolean;
  maxDurationMinutes?: number;
  /** Extra attempts after a `failure` run (not `timeout`/`stopped`). Defaults to 1. */
  maxRetries?: number;
  retentionDays?: number;
  skipIfMissed?: boolean;
  inboxOutput?: boolean;
  notifyProviders?: string[];
  runtime?: "stream" | "pty";
}

export type JobRunStatus = "running" | "success" | "failure" | "timeout" | "stopped";

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
  /** Deterministic configuration failure (e.g. model gone from the provider
   *  catalog): failed before the CLI spawned and is never retried. */
  configFailure?: boolean;
}

// Inbox
export type InboxPriority = "info" | "warning" | "error";

export interface InboxMessage {
  id: string;
  jobId?: string;
  jobName?: string;
  runId?: string;
  /** Set instead of jobId/jobName when a plain session (not a job run, not
   *  the assistant) posted this via add_inbox_message. */
  sessionId?: string;
  sessionName?: string;
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

// Issues and projects (native issue tracker, see docs/internal/issue-tracker-spec.md)

export interface Project {
  id: string;
  name: string;
  prefix: string; // "CK", "RO" — uppercase, unique, drives issue keys
  description?: string;
  repoPath?: string; // the repo this project's work happens in, so one set of pipeline jobs can serve every project
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  nextNumber: number; // per-project counter, so keys are CK-1, CK-2
}

/**
 * Canonical lifecycle order (docs/internal/issue-tracker-spec.md 2.1), not
 * alphabetical — Cancelled sits last since it's a terminal status reached
 * from anywhere, not a step in the normal flow. `IssueStatus` derives from
 * this array, not the other way around, so the type and "every valid value
 * at runtime" can never disagree. This is the single source of truth:
 * before this, the same values were three independent hand-written
 * copies (this file's old bare union, a private const in
 * cockpit-config-server.ts, and an exported one in issue-display.ts) that
 * had already drifted apart in spirit even before disagreeing in fact.
 * Anything needing every valid status — list grouping order, a status
 * `<select>`, validating a caller-supplied status — imports this array
 * rather than hand-writing its own.
 */
export const ISSUE_STATUSES = [
  "Backlog",
  "Needs Detail",
  "Refine Ready",
  "Refining",
  "Plan Review",
  "Implementation Ready",
  "Implementation",
  "Code Review",
  "Accepted",
  "Done",
  "Cancelled",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * Who did something to an issue — a comment's author, an activity entry's
 * actor. Deliberately lines up with `McpCaller` (src/server/mcp/run-context.ts:
 * assistant / job / session) plus a fourth "user" kind for a human acting
 * through the UI directly (no MCP token involved), since phase 2.3 attributes
 * every write to the token's caller and the UI has no token at all. Kept as
 * its own plain, serialisable POJO rather than reusing the McpCaller union
 * itself, which lives only in the in-memory token map and carries the full
 * RunContext (including fields like notifyProviders that have nothing to do
 * with "who did this").
 */
export type IssueActor =
  | { kind: "assistant" }
  | { kind: "job"; jobId: string; jobName: string; runId: string }
  | { kind: "session"; sessionId: string; sessionName: string }
  | { kind: "user" };

export interface IssueComment {
  id: string;
  body: string; // markdown
  author: IssueActor;
  createdAt: number;
}

/** A file the ui-reviewer agent (or a human) attaches to an issue — a
 *  screenshot, most often. `url` is either a remote URL or a local/cockpit-
 *  served path. */
export interface IssueAttachment {
  id: string;
  title: string;
  url: string;
  createdAt: number;
}

/** The Issue field names an activity entry can carry a before/after diff for. */
export type IssueActivityField = "title" | "description" | "status" | "priority" | "labels";

/**
 * One append-only audit entry. `kind` covers the non-field events (creation,
 * comments, attachments) alongside "field_changed", which is the only kind
 * that populates `field`/`from`/`to`. Never mutated or removed once appended.
 */
export interface IssueActivity {
  id: string;
  createdAt: number;
  actor: IssueActor;
  kind: "created" | "field_changed" | "commented" | "attachment_added";
  field?: IssueActivityField;
  from?: unknown;
  to?: unknown;
}

export interface Issue {
  id: string; // uuid, stable
  key: string; // "CK-12", what humans and branches use
  projectId: string;
  title: string;
  description: string; // markdown, the refine skill overwrites this wholesale
  status: IssueStatus;
  priority?: 0 | 1 | 2 | 3 | 4; // Linear's scale, so imports map cleanly
  labels?: string[];
  createdAt: number;
  updatedAt: number;
  comments: IssueComment[];
  attachments: IssueAttachment[];
  activity: IssueActivity[]; // append-only, who changed what
}

// Client -> Server messages
export type ClientMessage =
  | { type: "session:connect"; sessionId: string; cwd?: string; lastMessageId?: string | null; historyView?: boolean }
  | {
      type: "message:send";
      sessionId: string;
      text: string;
      images?: ImageAttachment[];
      documents?: DocumentAttachment[];
      cwd?: string;
      historyView?: boolean;
    }
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
  | { type: "session:set_model"; sessionId: string; model: string; contextSize?: ContextSize }
  | { type: "session:set_model_slot"; sessionId: string; slot: "main" | "subagent" | "fast"; modelId: string }
  | { type: "session:restart"; sessionId: string }
  | { type: "session:set_runtime"; sessionId: string; runtime: "pty" | "stream" }
  | { type: "session:subscribe"; sessionIds: string[] }
  | { type: "question:response"; sessionId: string; requestId: string; answers: Record<string, string> }
  | { type: "message:cancel_queued"; sessionId: string }
  | { type: "message:pause_queue"; sessionId: string }
  | { type: "message:resume_queue"; sessionId: string }
  | { type: "message:delete_queued"; sessionId: string; messageId: string }
  | { type: "message:edit_queued"; sessionId: string; messageId: string }
  | { type: "history:request_more"; sessionId: string; beforeMessageId: string }
  | { type: "watch:cwd"; cwd: string }
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
  | { type: "session:agents"; sessionId: string; count: number }
  | { type: "session:fs_changed"; cwd: string }
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
      configProposal?: { toolName: string; domain: string; action: string; displayName?: string; idNames?: Record<string, string> };
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
  | { type: "session:task_sync"; sessionId: string; tasks: BackgroundTask[] }
  | { type: "session:todos"; sessionId: string; todos: TodoItem[] }
  | { type: "session:init"; sessionId: string; data: InitData }
  | {
      type: "history";
      sessionId: string;
      messages: ChatMessage[];
      delta?: boolean;
      status?: "idle" | "running";
      hasMore?: boolean;
      promptHistory?: string[];
    }
  | { type: "history:more"; sessionId: string; messages: ChatMessage[]; hasMore: boolean }
  | { type: "session:transcript"; sessionId: string; messages: ChatMessage[] }
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
  mainContext?: ContextSize;
  subagent?: string;
  fast?: string;
}

export interface ProviderModel {
  modelId: string;
  displayName: string;
  effortLevels: ThinkingLevel[];
  contextSizes: ContextSize[];
  defaultEffort?: ThinkingLevel;
  /** Raw context window for catalog-synced models. The 200k/1m ContextSize
   *  enum stays Anthropic-only (it drives CLAUDE_CODE_DISABLE_1M_CONTEXT). */
  contextLength?: number;
  /** USD per million tokens, derived from the provider catalog at sync time. */
  pricing?: { inPerM: number; outPerM: number };
  free?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsImageInput?: boolean;
  /** ISO date after which the provider withdraws the model, when declared. */
  expirationDate?: string;
}

export interface Provider {
  id: string;
  name: string;
  envVars: Record<string, string>;
  models: ProviderModel[];
  isBuiltin?: boolean;
  /** Curated opt-in set for catalog-backed providers: only these model ids
   *  appear in pickers. Absent means nothing enabled yet. */
  enabledModels?: string[];
  /** Per-model curated context choices (modelId → sizes). A curated model
   *  gets the session-menu 200K/1M picker exactly like Anthropic models; the
   *  session's pick then drives the gauge and the CLI's window env. Stored
   *  apart from the synced model list so catalog re-syncs can't wipe it. */
  contextSizeOverrides?: Record<string, ContextSize[]>;
  /** Last successful catalog sync, for catalog-backed providers. */
  syncedAt?: number;
}
