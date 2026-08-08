import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CONTEXT_SIZES } from "@/lib/models";
import { getDefaults, setDefaults } from "@/server/defaults";
import { addInboxMessage } from "@/server/inbox";
import {
  addIssueAttachment,
  addIssueComment,
  applyIssueUpdate,
  buildIssue,
  getIssue,
  type IssueUpdateInput,
  loadIssues,
  loadProjects,
  persistAttachmentFile,
  saveIssue,
} from "@/server/issue-storage";
import { buildJob, deleteJob, getJob, getLatestRun, getRun, loadJobs, saveJob } from "@/server/job-storage";
import { getNotificationSettings, setNotificationSettings, updateNotificationSettings } from "@/server/notification-settings";
import { getClaudeUserConfigFile } from "@/server/paths";
import { addProvider, deleteProvider, getProviders, updateProvider } from "@/server/providers";
import { getJobScheduler } from "@/server/singleton";
import { findSessionCwd, loadTranscript } from "@/server/transcript";
import type { InboxPriority, Issue, IssueActor, IssueStatus, JobRun, NotificationProviderEntry, Project, ScheduledJob } from "@/types";
import { ISSUE_STATUSES } from "@/types";
import { isValidToken, lookupCaller, type McpCaller } from "./run-context";

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

/**
 * The only fields update_job may write, mirroring update_job's inputSchema and
 * create_job's explicit construction. The handler used to spread the caller's
 * args wholesale, so any field the model invented (a stringified singular
 * `schedule`, a stray `cron`) was persisted onto the job. Such a field only
 * ever disappeared if normalizeJob happened to know how to strip it, so
 * anything unrecognised stayed in scheduled-jobs.json indefinitely.
 */
const JOB_UPDATE_FIELDS = [
  "name",
  "schedules",
  "prompt",
  "cwd",
  "enabled",
  "model",
  "contextSize",
  "thinkingLevel",
  "allowedTools",
  "mcpServers",
  "mcpToolFilters",
  "bypassPermissions",
  "maxDurationMinutes",
  "maxRetries",
  "retentionDays",
  "skipIfMissed",
  "inboxOutput",
  "notifyProviders",
  "runtime",
] as const satisfies readonly (keyof ScheduledJob)[];

/**
 * Placeholder the assistant sees in place of a stored secret.
 *
 * The read tools (list_providers and friends) are auto-approved for the cockpit
 * assistant, so before this every provider API key, MCP server env value and
 * notification token was pulled into the model's context unprompted, written to
 * the session transcript on disk, and sent to whatever provider the assistant
 * session happens to run on. It never needs the value, only whether one is set.
 */
const REDACTED = "<redacted>";

/** Field names whose values are treated as secret wherever they appear. */
const SECRET_NAME = /key|token|secret|password|credential/i;

/**
 * Deep-copy `value`, replacing secret-looking string values with REDACTED.
 * Empty strings are left alone: `ANTHROPIC_API_KEY: ""` is meaningful config
 * (it stops the CLI falling back to Anthropic), not a secret to hide.
 */
function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === "string" && v !== "" && SECRET_NAME.test(k) ? REDACTED : redactSecrets(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Undo a redacted round trip: wherever `incoming` carries the placeholder, take
 * the real value from `stored`. Without this, an assistant that read a config
 * and echoed it back into an update would overwrite a live API key with the
 * literal string "<redacted>".
 */
function restoreRedacted<T>(incoming: T, stored: unknown): T {
  if (incoming === REDACTED) return (typeof stored === "string" ? stored : incoming) as T;
  if (Array.isArray(incoming)) return incoming as T;
  if (incoming && typeof incoming === "object") {
    const storedObj = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      out[k] = restoreRedacted(v, storedObj[k]);
    }
    return out as T;
  }
  return incoming;
}

/**
 * Which callers may reach each tool. A tool absent from this map is
 * assistant-only, which keeps the default closed — anything new added to
 * TOOL_DEFINITIONS needs an explicit opt-in here to reach a job or session.
 *
 * Enforced twice on purpose: tools/list is filtered by this map so a job or
 * session's model never even sees the rest, and handleToolCall rejects
 * anything outside the map, because a list the model was shown is not a
 * security boundary — a model can still name a tool it was never offered.
 *
 * Keep this minimal. Everything added here becomes reachable by an unattended
 * job, or by a plain session that often runs with bypass permissions and
 * reads arbitrary repo content.
 */
type McpScope = "assistant" | "job" | "session";

const TOOL_SCOPES: Record<string, readonly McpScope[]> = {
  add_inbox_message: ["job", "session"],
  list_notify_targets: ["job", "session"],
  // Scheduled-job tools are open to interactive sessions by user decision
  // (2026-08-08): a session already runs with the user's shell, so it could
  // write a real crontab entry anyway — the MCP gate was inconvenience, not a
  // boundary. Deliberately NOT opened to job callers: a scheduled job that
  // can mint or rewrite scheduled jobs is self-replication with no human in
  // the loop, and unlike a session there is no user watching the turn.
  list_jobs: ["assistant", "session"],
  get_job: ["assistant", "session"],
  create_job: ["assistant", "session"],
  update_job: ["assistant", "session"],
  delete_job: ["assistant", "session"],
  run_job: ["assistant", "session"],
  stop_job: ["assistant", "session"],
  list_running_jobs: ["assistant", "session"],
  get_job_transcript: ["assistant", "session"],
  // Phase 2.3: the native issue tracker. A plain session gets no cockpit
  // system prompt (see run-context.ts's McpCaller doc), so these tool
  // descriptions are its only affordance for using the tracker at all.
  list_projects: ["assistant", "job", "session"],
  list_issues: ["assistant", "job", "session"],
  get_issue: ["assistant", "job", "session"],
  create_issue: ["assistant", "job", "session"],
  update_issue: ["assistant", "job", "session"],
  add_issue_comment: ["assistant", "job", "session"],
  add_issue_attachment: ["assistant", "job", "session"],
};

function scopesFor(name: string): readonly McpScope[] {
  return TOOL_SCOPES[name] ?? ["assistant"];
}

/**
 * The seven issue/project tools, gated separately from TOOL_SCOPES by the
 * `issuesEnabled` setting (default off — see defaults.ts). Unlike TOOL_SCOPES,
 * which is static per caller kind, this is read fresh from getDefaults() on
 * every tools/list and tools/call so a toggle in Settings takes effect
 * immediately, with no server restart and no module-load caching.
 */
const ISSUE_TOOLS = new Set([
  "list_projects",
  "list_issues",
  "get_issue",
  "create_issue",
  "update_issue",
  "add_issue_comment",
  "add_issue_attachment",
]);

const ISSUES_DISABLED_ERROR = "The issue tracker is disabled. Turn it on in Settings → Appearance to use this tool.";

/** Messages returned by get_job_transcript when the caller does not ask for a count. */
const JOB_TRANSCRIPT_DEFAULT_MESSAGES = 50;
/** Per-message character cap, so one long tool dump cannot swamp the reply. */
const JOB_TRANSCRIPT_MAX_TEXT = 4000;

/**
 * Push notifications a single session may trigger per rolling hour, via
 * add_inbox_message's notifyProviders. A job reports once per run and is
 * unaffected by this cap; an interactive session can run for hours and loop,
 * and nothing else stops it from hammering a phone. In-memory only — reset on
 * restart, deliberately not persisted. The inbox write itself is never rate
 * limited, only the push.
 */
const SESSION_PUSH_LIMIT_PER_HOUR = 10;
const SESSION_PUSH_WINDOW_MS = 60 * 60 * 1000;
const sessionPushTimestamps = new Map<string, number[]>();

/** True (and records the attempt) if `sessionId` is still under its hourly
 *  push cap; false if it has to wait for the window to roll forward. */
function allowSessionPush(sessionId: string): boolean {
  const now = Date.now();
  const recent = (sessionPushTimestamps.get(sessionId) ?? []).filter((t) => now - t < SESSION_PUSH_WINDOW_MS);
  if (recent.length >= SESSION_PUSH_LIMIT_PER_HOUR) {
    sessionPushTimestamps.set(sessionId, recent);
    return false;
  }
  recent.push(now);
  sessionPushTimestamps.set(sessionId, recent);
  return true;
}

function pickJobUpdate(source: Record<string, unknown>): Partial<ScheduledJob> {
  const update: Record<string, unknown> = {};
  for (const key of JOB_UPDATE_FIELDS) {
    if (source[key] !== undefined) update[key] = source[key];
  }
  return update as Partial<ScheduledJob>;
}

// ISSUE_STATUSES: imported from @/types (canonical array IssueStatus derives
// from) rather than a local copy — used here to validate a caller-supplied
// `status` filter or patch field before it reaches storage. IssueStatus is a
// small, closed enum — unlike a project id/prefix, which is an open
// namespace where "no match" is a normal, expected outcome — so an
// unrecognised value here is always a caller mistake, worth a clear error
// rather than a silent empty result (list_issues) or a corrupted issue
// (update_issue). issue-storage.ts's buildIssue/applyIssueUpdate now also
// validate status independently (belt and braces, not a replacement for
// this) — this tool's own check still runs first and produces the better,
// isError-shaped message.

/** Linear's 0-4 priority scale (see the Issue type's own comment). */
const PRIORITIES = [0, 1, 2, 3, 4] as const;

/**
 * Map the token's caller identity to the actor recorded on an issue's
 * activity/comments. This is the *only* place a caller's identity becomes an
 * IssueActor: none of the issue tool schemas below expose an author/actor
 * argument, so a caller has no way to claim to be someone else — the token
 * alone decides. McpCaller has no "user" kind (that one is UI-only, with no
 * MCP token involved at all — see IssueActor's own comment in
 * src/types/index.ts), so this switch is exhaustive over assistant/job/session
 * without needing a fourth branch; the `default` below is an unreachable
 * exhaustiveness guard, not a real code path (same treatment as the
 * "Unreachable" branch already in add_inbox_message's caller check below).
 */
function actorFromCaller(caller: McpCaller): IssueActor {
  switch (caller.kind) {
    case "assistant":
      return { kind: "assistant" };
    case "job":
      return { kind: "job", jobId: caller.run.jobId, jobName: caller.run.jobName, runId: caller.run.runId };
    case "session":
      return { kind: "session", sessionId: caller.sessionId, sessionName: caller.sessionName };
    default: {
      const exhaustive: never = caller;
      throw new Error(`Unknown MCP caller kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Resolve a caller-supplied project reference to a real Project, accepting
 * either its id (as returned by list_projects) or its prefix (e.g. "CK",
 * case-insensitive) — the form an issue key already carries, so a caller who
 * only knows a key like "CK-12" can filter or create without a round trip
 * through list_projects first. Returns undefined if neither matches, same as
 * a plain lookup miss.
 */
function resolveProject(idOrPrefix: string): Project | undefined {
  const projects = loadProjects();
  const normalized = idOrPrefix.trim().toUpperCase();
  return projects.find((p) => p.id === idOrPrefix) ?? projects.find((p) => p.prefix.toUpperCase() === normalized);
}

/**
 * Trim an Issue down to what list_issues returns. The pipeline calls
 * list_issues constantly to scan for matching issues by status/label before
 * opening the ones it cares about with get_issue, so returning every
 * comment/attachment/activity entry (get_issue's job) for every issue in the
 * list would be wasteful — counts are enough to know an issue has discussion
 * worth reading with get_issue.
 */
function issueSummary(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    key: issue.key,
    projectId: issue.projectId,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    commentCount: issue.comments.length,
    attachmentCount: issue.attachments.length,
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "list_jobs",
    description: "List all scheduled jobs",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_job",
    description: "Get a scheduled job by ID",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_job",
    description: "Create a new scheduled job",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        schedules: {
          type: "array",
          items: { type: "object" },
          description: "One or more schedules for this job. A single job can hold more than one schedule.",
        },
        prompt: { type: "string" },
        cwd: { type: "string" },
        enabled: { type: "boolean" },
        model: { type: "string" },
        contextSize: { type: "string", enum: Object.keys(CONTEXT_SIZES), description: "Context window size" },
        thinkingLevel: { type: "string" },
        bypassPermissions: { type: "boolean" },
        maxDurationMinutes: { type: "number" },
        maxRetries: { type: "number", description: "Extra attempts after a failure run (not timeout/stopped). Defaults to 1." },
        retentionDays: { type: "number" },
        skipIfMissed: { type: "boolean" },
        inboxOutput: { type: "boolean" },
        runtime: { type: "string", enum: ["stream", "pty"], description: "Execution runtime: stream (default) or pty" },
        allowedTools: { type: "array", items: { type: "string" }, description: "Tool names the job is allowed to use" },
        mcpServers: { type: "array", items: { type: "string" }, description: "MCP server names to enable for this job" },
        mcpToolFilters: { type: "object", description: 'Per-MCP-server tool filter: { serverName: ["tool1", "tool2"] }' },
        notifyProviders: { type: "array", items: { type: "string" }, description: "Notification provider IDs to alert on job completion" },
      },
      required: ["name", "schedules", "prompt", "cwd"],
    },
  },
  {
    name: "update_job",
    description: "Update an existing scheduled job",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        schedules: {
          type: "array",
          items: { type: "object" },
          description: "Replaces all of the job's schedules with this list.",
        },
        prompt: { type: "string" },
        cwd: { type: "string" },
        enabled: { type: "boolean" },
        model: { type: "string" },
        contextSize: { type: "string", enum: Object.keys(CONTEXT_SIZES), description: "Context window size" },
        thinkingLevel: { type: "string" },
        bypassPermissions: { type: "boolean" },
        maxDurationMinutes: { type: "number" },
        maxRetries: { type: "number", description: "Extra attempts after a failure run (not timeout/stopped). Defaults to 1." },
        retentionDays: { type: "number" },
        skipIfMissed: { type: "boolean" },
        inboxOutput: { type: "boolean" },
        runtime: { type: "string", enum: ["stream", "pty"] },
        allowedTools: { type: "array", items: { type: "string" } },
        mcpServers: { type: "array", items: { type: "string" } },
        mcpToolFilters: { type: "object" },
        notifyProviders: { type: "array", items: { type: "string" } },
        updates: { type: "array", items: { type: "object" } },
      },
    },
  },
  {
    name: "delete_job",
    description: "Delete a scheduled job by ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "get_settings",
    description: "Get current application settings",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_settings",
    description: "Update application settings",
    inputSchema: {
      type: "object",
      properties: {
        thinkingLevel: { type: "string", enum: ["off", "low", "medium", "high", "xhigh", "max"] },
        diffStyle: { type: "string", enum: ["split", "unified"] },
        dismissKeyboardOnSend: { type: "boolean" },
        thinkingExpanded: { type: "boolean" },
        readExpanded: { type: "boolean" },
        editExpanded: { type: "boolean" },
        toolCallsExpanded: { type: "boolean" },
        messageStitching: { type: "boolean" },
        reviewsEnabled: { type: "boolean" },
        issuesEnabled: { type: "boolean" },
        bypassAllPermissions: { type: "boolean" },
        modelSlots: {
          type: "object",
          properties: {
            main: { type: "string", description: "Model ID (e.g. claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5)" },
            mainContext: { type: "string", enum: Object.keys(CONTEXT_SIZES), description: "Context window size" },
          },
        },
      },
    },
  },
  {
    name: "list_providers",
    description: "List all model providers",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_provider",
    description: "Add a new model provider",
    inputSchema: { type: "object", properties: { name: { type: "string" }, envVars: { type: "object" } }, required: ["name", "envVars"] },
  },
  {
    name: "update_provider",
    description: "Update an existing model provider",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        envVars: { type: "object" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_provider",
    description: "Delete a model provider by ID",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_mcp_servers",
    description: "List all configured MCP servers from ~/.claude.json",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_mcp_server",
    description: "Get an MCP server configuration by name",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "save_mcp_server",
    description: "Create or update an MCP server configuration",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
      required: ["name", "command", "args"],
    },
  },
  {
    name: "delete_mcp_server",
    description: "Delete an MCP server configuration by name",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "get_notification_settings",
    description: "Get current notification settings",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_notification_settings",
    description: "Update notification settings",
    inputSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", description: "Webhook URL for notifications" },
      },
    },
  },
  {
    name: "list_notification_providers",
    description: "List all notification providers",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_notification_provider",
    description: "Add a notification provider (telegram or ntfy)",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["telegram", "ntfy"] },
        name: { type: "string" },
        enabled: { type: "boolean" },
        config: { type: "object", description: "For telegram: {botToken, chatId}. For ntfy: {serverUrl, topic, token?}" },
        filterPriorities: { type: "array", items: { type: "string", enum: ["info", "warning", "error"] } },
      },
      required: ["type", "name", "config"],
    },
  },
  {
    name: "update_notification_provider",
    description: "Update an existing notification provider by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        enabled: { type: "boolean" },
        config: { type: "object" },
        filterPriorities: { type: "array", items: { type: "string", enum: ["info", "warning", "error"] } },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_notification_provider",
    description: "Delete a notification provider by ID",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_job",
    description:
      "Trigger one or more scheduled jobs to run immediately, regardless of their enabled state; returns as soon as the run is queued and does not wait for completion",
    inputSchema: { type: "object", properties: { id: { type: "string" }, ids: { type: "array", items: { type: "string" } } } },
  },
  {
    name: "stop_job",
    description: "Stop a currently running scheduled job by ID",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_running_jobs",
    description: "List scheduled jobs that are currently running",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_inbox_message",
    description:
      'Post your result to the cockpit inbox. This is how a scheduled job or a plain session reports back, so call it once when you have something worth surfacing, and do not call it at all when there is nothing to report. The job or session you belong to is known already, so there is no id or author to pass. By default this only writes the inbox entry — set notifyProviders to also reach the user\'s phone (see list_notify_targets to turn a name like "telegram" into an id); an interactive session that pushes too often will start getting a rate-limit error back instead of a second push.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short one-line summary, shown in the inbox list." },
        body: { type: "string", description: "Full report. Markdown, as long as you need. No escaping beyond normal JSON string rules." },
        priority: { type: "string", enum: ["info", "warning", "error"], description: 'Defaults to "info".' },
        notifyProviders: {
          type: "array",
          items: { type: "string" },
          description:
            "Provider ids to push this report to (e.g. Telegram) in addition to the inbox. Omit for inbox-only, no push. Resolve a name to an id with list_notify_targets first.",
        },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "list_notify_targets",
    description:
      'List the notification targets (e.g. Telegram, ntfy) that add_inbox_message can push to. Use this to resolve a name the user gave you, like "telegram" or "my phone", into the id notifyProviders expects.',
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_job_transcript",
    description:
      "Read the conversation transcript of a scheduled job's run, so you can see what it actually did rather than only whether it succeeded. Defaults to the most recent run, which may still be in progress, so this is also how you watch a job that is running right now.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job ID" },
        runId: { type: "string", description: "A specific run to read. Defaults to the most recent run, running or finished." },
        tailMessages: {
          type: "number",
          description: `Return only the last N messages. Defaults to ${JOB_TRANSCRIPT_DEFAULT_MESSAGES}.`,
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_projects",
    description:
      'List every project in the native issue tracker (id, name, prefix, repoPath, archived). Use a project\'s id or its prefix (e.g. "CK") wherever another tool asks for a project.',
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_issues",
    description:
      'List issues, optionally filtered by project (its id or prefix, e.g. "CK"), status and/or label; filters combine with AND. Omit all three to list every issue in every project. Returns a trimmed summary (no description, comments or activity — use get_issue for the full record). An unrecognised project filter returns an empty list; an unrecognised status is refused with the valid status names, since status is a fixed set and a typo there is always a mistake.',
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: 'Project id or prefix (e.g. "CK"). Omit to search every project.' },
        status: { type: "string", enum: [...ISSUE_STATUSES], description: "Filter to one status." },
        label: { type: "string", description: "Filter to issues carrying exactly this label." },
      },
      required: [],
    },
  },
  {
    name: "get_issue",
    description:
      'Get one issue by its key (e.g. "CK-12"): full title and description, every comment, every attachment, and its full activity/audit trail. Errors if the key does not resolve to a real issue.',
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: 'Issue key, e.g. "CK-12".' } },
      required: ["key"],
    },
  },
  {
    name: "create_issue",
    description:
      'Create a new issue under a project (its id or prefix, e.g. "CK"). Its key (e.g. "CK-13") is assigned automatically — there is no field to set one, and every new issue starts in the "Backlog" status.',
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: 'Project id or prefix (e.g. "CK") to create the issue under.' },
        title: { type: "string" },
        description: { type: "string", description: "Markdown body. Optional." },
        priority: { type: "number", enum: [...PRIORITIES], description: "Linear's 0 (urgent) - 4 (low) scale. Optional." },
        labels: { type: "array", items: { type: "string" }, description: "Optional." },
      },
      required: ["project", "title"],
    },
  },
  {
    name: "update_issue",
    description:
      "Update an existing issue's title, description, status, priority and/or labels, found by its key. Only the fields you pass are changed; everything else is left alone. Every changed field is appended to the issue's activity log, attributed to you automatically.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Issue key, e.g. "CK-12".' },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: [...ISSUE_STATUSES] },
        priority: { type: "number", enum: [...PRIORITIES] },
        labels: { type: "array", items: { type: "string" } },
      },
      required: ["key"],
    },
  },
  {
    name: "add_issue_comment",
    description:
      "Add a comment to an issue, found by its key. The author is attributed automatically from your session/job/assistant identity — there is no author field to set.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Issue key, e.g. "CK-12".' },
        body: { type: "string", description: "Markdown, as long as you need." },
      },
      required: ["key", "body"],
    },
  },
  {
    name: "add_issue_attachment",
    description:
      "Attach a file to an issue, found by its key — the ui-reviewer agent's screenshots are the main use. `url` may be a remote URL or a local/cockpit-served path.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'Issue key, e.g. "CK-12".' },
        url: { type: "string", description: "A remote URL or a local/cockpit-served path." },
        title: { type: "string" },
      },
      required: ["key", "url", "title"],
    },
  },
];

function readClaudeConfig(): { mcpServers: Record<string, McpServerEntry> } {
  try {
    return JSON.parse(readFileSync(getClaudeUserConfigFile(), "utf-8"));
  } catch {
    return { mcpServers: {} };
  }
}

function writeClaudeConfig(data: { mcpServers: Record<string, McpServerEntry> }): void {
  const file = getClaudeUserConfigFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  try {
    const caller: McpCaller = lookupCaller(token) ?? { kind: "assistant" };
    // Both enforcement layers matter: tools/list already filters by the same
    // map so a job or session's model never sees a tool outside its scope,
    // but a list the model was shown is not a security boundary — a model can
    // still name a tool it was never offered, so the call itself is refused
    // here too.
    if (!scopesFor(name).includes(caller.kind)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `${name} is only available to: ${scopesFor(name).join(", ")}` }) }],
        isError: true,
      };
    }
    // Read per call, not cached at module load, so a toggle in Settings takes
    // effect on the very next call rather than waiting for a restart.
    if (ISSUE_TOOLS.has(name) && !getDefaults().issuesEnabled) {
      return { content: [{ type: "text", text: JSON.stringify({ error: ISSUES_DISABLED_ERROR }) }], isError: true };
    }

    switch (name) {
      case "add_inbox_message": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!title || !body) {
          // Explicit rather than silent: the model reads this and retries,
          // which is the whole reason this is a tool and not a parsed fence.
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "title and body are both required and must be non-empty" }) }],
            isError: true,
          };
        }
        const priority = args.priority === "warning" || args.priority === "error" ? args.priority : "info";
        const explicitNotify = Array.isArray(args.notifyProviders) ? (args.notifyProviders as string[]) : undefined;

        let jobId: string | undefined;
        let jobName: string | undefined;
        let runId: string | undefined;
        let sessionId: string | undefined;
        let sessionName: string | undefined;
        let notifyProviders: string[] | undefined;
        let rateLimitedNote: string | undefined;

        if (caller.kind === "job") {
          jobId = caller.run.jobId;
          jobName = caller.run.jobName;
          runId = caller.run.runId;
          // 1. an explicit ask wins. 2. otherwise fall back to the job's own
          // configured providers exactly as before, which may be undefined —
          // in which case dispatchNotification's default per-provider filter
          // decides, unchanged from today's behaviour.
          notifyProviders = explicitNotify ?? caller.run.notifyProviders;
        } else if (caller.kind === "session") {
          sessionId = caller.sessionId;
          sessionName = caller.sessionName;
          if (explicitNotify && explicitNotify.length > 0) {
            if (allowSessionPush(sessionId)) {
              notifyProviders = explicitNotify;
            } else {
              // The inbox write below still happens — only the push is capped.
              notifyProviders = [];
              rateLimitedNote = `Push notifications for this session are capped at ${SESSION_PUSH_LIMIT_PER_HOUR} per hour; this report was still saved to the inbox but not pushed. Stop retrying the push until the next hour.`;
            }
          } else {
            // Default-quiet: a session that doesn't ask for a push doesn't
            // get one. A tool that can reach a phone should not fire unless
            // asked, so this deliberately does NOT fall through to the
            // per-provider filter the way a job with no notifyProviders does.
            notifyProviders = [];
          }
        } else {
          // Unreachable: scopesFor("add_inbox_message") excludes "assistant",
          // so the scope check above already refused this call. Handled
          // defensively rather than asserted away.
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "add_inbox_message requires a job or session caller" }) }],
            isError: true,
          };
        }

        const { entry, outcome } = addInboxMessage({
          title,
          body,
          priority,
          jobId,
          jobName,
          runId,
          sessionId,
          sessionName,
          notifyProviders,
        });

        if (rateLimitedNote) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: rateLimitedNote, delivered: true, id: entry.id }) }],
            isError: true,
          };
        }

        const result: Record<string, unknown> = { delivered: true, id: entry.id, notified: outcome.notified.map((n) => n.name) };
        if (outcome.skipped.length > 0) {
          result.skipped = outcome.skipped.map((s) => `${s.name}: ${s.reason}`);
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "list_notify_targets": {
        const settings = getNotificationSettings();
        const targets = settings.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled }));
        return { content: [{ type: "text", text: JSON.stringify(targets, null, 2) }] };
      }
      case "list_jobs":
        return { content: [{ type: "text", text: JSON.stringify(loadJobs(), null, 2) }] };
      case "get_job": {
        const job = getJob(args.id as string);
        if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
      }
      case "get_job_transcript": {
        const job = getJob(args.id as string);
        if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        const runId = args.runId as string | undefined;
        // A run is persisted with status "running" the moment its session
        // exists, so the newest run is often still in flight. That is what lets
        // this read a job the agent has only just triggered.
        const run = runId ? getRun(job.id, runId) : getLatestRun(job.id);
        if (!run) {
          const detail = runId ? `Run not found: ${runId}` : `No runs recorded for job: ${job.name}`;
          return { content: [{ type: "text", text: JSON.stringify({ error: detail }) }], isError: true };
        }
        const cwd = run.cwd || (await findSessionCwd(run.sessionId));
        if (!cwd) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `No transcript found for run ${run.id}` }) }], isError: true };
        }
        const { messages } = await loadTranscript(run.sessionId, cwd);
        const asked =
          typeof args.tailMessages === "number" && args.tailMessages > 0 ? Math.floor(args.tailMessages) : JOB_TRANSCRIPT_DEFAULT_MESSAGES;
        const tail = messages.slice(-asked);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  job: job.name,
                  jobId: job.id,
                  runId: run.id,
                  status: run.status,
                  startedAt: run.startedAt,
                  completedAt: run.completedAt,
                  durationMs: run.durationMs,
                  error: run.error,
                  totalMessages: messages.length,
                  returnedMessages: tail.length,
                  messages: tail.map((m) => ({
                    role: m.role,
                    timestamp: m.timestamp,
                    text:
                      m.content.length > JOB_TRANSCRIPT_MAX_TEXT
                        ? `${m.content.slice(0, JOB_TRANSCRIPT_MAX_TEXT)}\n... (truncated)`
                        : m.content,
                    tools: m.toolUses.map((t) => t.name),
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "create_job": {
        // pickJobUpdate keeps this to the fields the schema documents, and
        // buildJob is the same constructor the REST route uses, so a job the
        // assistant creates is identical to one made through the UI.
        const input = pickJobUpdate(args);
        const missing = (["name", "schedules", "prompt"] as const).filter((k) => {
          const v = input[k];
          return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
        });
        if (missing.length > 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Missing required field(s): ${missing.join(", ")}` }) }],
            isError: true,
          };
        }
        const job = buildJob(input);
        saveJob(job);
        return { content: [{ type: "text", text: JSON.stringify({ created: job }, null, 2) }] };
      }
      case "update_job": {
        if (Array.isArray(args.updates)) {
          const results = (args.updates as Record<string, unknown>[]).map((entry) => {
            const id = entry.id as string;
            const existing = getJob(id);
            if (!existing) return { id, error: `Job not found: ${id}` };
            const before = { ...existing };
            const updated: ScheduledJob = { ...existing, ...pickJobUpdate(entry), updatedAt: Date.now() };
            saveJob(updated);
            return { id, before, after: updated };
          });
          return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
        }
        if (!args.id) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "missing id or updates" }) }], isError: true };
        }
        const existing = getJob(args.id as string);
        if (!existing) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        const before = { ...existing };
        const updated: ScheduledJob = { ...existing, ...pickJobUpdate(args), updatedAt: Date.now() };
        saveJob(updated);
        return { content: [{ type: "text", text: JSON.stringify({ before, after: updated }, null, 2) }] };
      }
      case "delete_job": {
        if (Array.isArray(args.ids)) {
          const results = (args.ids as string[]).map((id) => {
            const job = getJob(id);
            if (!job) return { id, error: `Job not found: ${id}` };
            deleteJob(id);
            return { id, deleted: true };
          });
          return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
        }
        const job = getJob(args.id as string);
        if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        deleteJob(args.id as string);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: job }, null, 2) }] };
      }
      case "get_settings":
        return { content: [{ type: "text", text: JSON.stringify(getDefaults(), null, 2) }] };
      case "update_settings": {
        const before = getDefaults();
        const allowed: (keyof Parameters<typeof setDefaults>[0])[] = [
          "thinkingLevel",
          "diffStyle",
          "dismissKeyboardOnSend",
          "thinkingExpanded",
          "readExpanded",
          "editExpanded",
          "toolCallsExpanded",
          "messageStitching",
          "reviewsEnabled",
          "issuesEnabled",
          "bypassAllPermissions",
          "modelSlots",
        ];
        const safe = Object.fromEntries(
          Object.entries(args).filter(([k]) => allowed.includes(k as (typeof allowed)[number])),
        ) as Parameters<typeof setDefaults>[0];
        const after = setDefaults(safe);
        return { content: [{ type: "text", text: JSON.stringify({ before, after }, null, 2) }] };
      }
      case "list_providers":
        return { content: [{ type: "text", text: JSON.stringify(redactSecrets(getProviders()), null, 2) }] };
      case "add_provider": {
        const provider = addProvider({
          name: args.name as string,
          envVars: args.envVars as Record<string, string>,
          models: [],
        });
        return { content: [{ type: "text", text: JSON.stringify({ created: redactSecrets(provider) }, null, 2) }] };
      }
      case "update_provider": {
        const { id, ...rest } = args;
        const before = getProviders().find((p) => p.id === id);
        if (!before) return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${id}` }) }], isError: true };
        const patch = restoreRedacted(rest, before) as Parameters<typeof updateProvider>[1];
        const after = updateProvider(id as string, patch);
        return {
          content: [{ type: "text", text: JSON.stringify({ before: redactSecrets(before), after: redactSecrets(after) }, null, 2) }],
        };
      }
      case "delete_provider": {
        const provider = getProviders().find((p) => p.id === args.id);
        if (!provider)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        deleteProvider(args.id as string);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: redactSecrets(provider) }, null, 2) }] };
      }
      case "list_mcp_servers": {
        const config = readClaudeConfig();
        const entries = Object.entries(config.mcpServers ?? {}).map(([n, c]) => ({ name: n, ...c }));
        return { content: [{ type: "text", text: JSON.stringify(redactSecrets(entries), null, 2) }] };
      }
      case "get_mcp_server": {
        const config = readClaudeConfig();
        const entry = config.mcpServers?.[args.name as string];
        if (!entry)
          return { content: [{ type: "text", text: JSON.stringify({ error: `MCP server not found: ${args.name}` }) }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(redactSecrets({ name: args.name, ...entry }), null, 2) }] };
      }
      case "save_mcp_server": {
        const config = readClaudeConfig();
        const servers = config.mcpServers ?? {};
        const before = servers[args.name as string] ? { ...servers[args.name as string] } : null;
        servers[args.name as string] = {
          command: args.command as string,
          args: args.args as string[],
          env: restoreRedacted(args.env as Record<string, string> | undefined, before?.env),
        };
        writeClaudeConfig({ ...config, mcpServers: servers });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ before: redactSecrets(before), after: redactSecrets(servers[args.name as string]) }, null, 2),
            },
          ],
        };
      }
      case "delete_mcp_server": {
        const config = readClaudeConfig();
        const servers = config.mcpServers ?? {};
        if (!servers[args.name as string])
          return { content: [{ type: "text", text: JSON.stringify({ error: `MCP server not found: ${args.name}` }) }], isError: true };
        const deleted = servers[args.name as string];
        delete servers[args.name as string];
        writeClaudeConfig({ ...config, mcpServers: servers });
        return { content: [{ type: "text", text: JSON.stringify({ deleted: redactSecrets(deleted) }, null, 2) }] };
      }
      case "get_notification_settings":
        return { content: [{ type: "text", text: JSON.stringify(redactSecrets(getNotificationSettings()), null, 2) }] };
      case "update_notification_settings": {
        const before = getNotificationSettings();
        const patch = restoreRedacted(args, before) as Parameters<typeof updateNotificationSettings>[0];
        const after = updateNotificationSettings(patch);
        return {
          content: [{ type: "text", text: JSON.stringify({ before: redactSecrets(before), after: redactSecrets(after) }, null, 2) }],
        };
      }
      case "list_notification_providers": {
        const settings = getNotificationSettings();
        return { content: [{ type: "text", text: JSON.stringify(redactSecrets(settings.providers), null, 2) }] };
      }
      case "add_notification_provider": {
        const settings = getNotificationSettings();
        const entry: NotificationProviderEntry = {
          id: randomUUID(),
          type: args.type as NotificationProviderEntry["type"],
          name: args.name as string,
          enabled: (args.enabled as boolean) ?? true,
          config: args.config as NotificationProviderEntry["config"],
          filter:
            Array.isArray(args.filterPriorities) && args.filterPriorities.length > 0
              ? { priorities: args.filterPriorities as InboxPriority[] }
              : undefined,
        };
        const after = setNotificationSettings({ ...settings, providers: [...settings.providers, entry] });
        return {
          content: [
            { type: "text", text: JSON.stringify({ created: redactSecrets(entry), providers: redactSecrets(after.providers) }, null, 2) },
          ],
        };
      }
      case "update_notification_provider": {
        const settings = getNotificationSettings();
        const idx = settings.providers.findIndex((p) => p.id === args.id);
        if (idx === -1)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        const before = settings.providers[idx];
        const updated: NotificationProviderEntry = {
          ...before,
          ...(args.name !== undefined ? { name: args.name as string } : {}),
          ...(args.enabled !== undefined ? { enabled: args.enabled as boolean } : {}),
          ...(args.config !== undefined
            ? { config: restoreRedacted(args.config, before.config) as NotificationProviderEntry["config"] }
            : {}),
          ...(Array.isArray(args.filterPriorities)
            ? {
                filter:
                  args.filterPriorities.length > 0
                    ? { ...before.filter, priorities: args.filterPriorities as InboxPriority[] }
                    : before.filter?.sources?.length
                      ? { ...before.filter, priorities: undefined }
                      : undefined,
              }
            : {}),
        };
        const providers = [...settings.providers];
        providers[idx] = updated;
        const after = setNotificationSettings({ ...settings, providers });
        return {
          content: [
            { type: "text", text: JSON.stringify({ before: redactSecrets(before), after: redactSecrets(after.providers[idx]) }, null, 2) },
          ],
        };
      }
      case "delete_notification_provider": {
        const settings = getNotificationSettings();
        const provider = settings.providers.find((p) => p.id === args.id);
        if (!provider)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        const after = setNotificationSettings({ ...settings, providers: settings.providers.filter((p) => p.id !== args.id) });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ deleted: redactSecrets(provider), providers: redactSecrets(after.providers) }, null, 2),
            },
          ],
        };
      }
      case "run_job": {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : args.id ? [args.id as string] : [];
        if (ids.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "no job id provided" }) }], isError: true };
        }
        const scheduler = getJobScheduler();
        if (!scheduler) {
          return {
            content: [{ type: "text", text: JSON.stringify({ results: ids.map((id) => ({ id, status: "scheduler not available" })) }) }],
          };
        }
        const running = scheduler.getRunningJobs();
        const jobs = loadJobs();
        const results = ids.map((id) => {
          const job = jobs.find((j) => j.id === id);
          if (!job) return { id, status: "not_found" };
          if (running.has(id)) return { id, name: job.name, status: "already_running" };
          void scheduler.triggerJob(id).catch((err) => console.error("[cockpit-mcp] run_job", id, err));
          return { id, name: job.name, status: "started" };
        });
        return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
      }
      case "stop_job": {
        const jobId = args.id as string;
        if (!jobId) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "no job id provided" }) }], isError: true };
        }
        const scheduler = getJobScheduler();
        if (!scheduler) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "scheduler not available" }) }], isError: true };
        }
        try {
          const run = scheduler.stopJob(jobId);
          const jobs = loadJobs();
          const nameMap = new Map(jobs.map((j) => [j.id, j.name]));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    jobId: run.jobId,
                    name: nameMap.get(run.jobId) ?? "unknown",
                    runId: run.id,
                    status: run.status,
                    startedAt: run.startedAt,
                    elapsedMs: run.durationMs ?? Date.now() - run.startedAt,
                    messageCount: run.messageCount,
                    toolCount: run.toolsUsed.length,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
            isError: true,
          };
        }
      }
      case "list_running_jobs": {
        const scheduler = getJobScheduler();
        if (!scheduler) {
          return { content: [{ type: "text", text: JSON.stringify({ running: [], count: 0, note: "scheduler not available" }) }] };
        }
        const jobs = loadJobs();
        const nameMap = new Map(jobs.map((j) => [j.id, j.name]));
        const running = Array.from(scheduler.getRunningJobs().values()).map((r: JobRun) => ({
          jobId: r.jobId,
          name: nameMap.get(r.jobId) ?? "unknown",
          runId: r.id,
          sessionId: r.sessionId,
          status: r.status,
          startedAt: r.startedAt,
          elapsedMs: Date.now() - r.startedAt,
          messageCount: r.messageCount,
          toolCount: r.toolsUsed.length,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ running, count: running.length }, null, 2) }] };
      }
      case "list_projects": {
        const projects = loadProjects().map((p) => ({
          id: p.id,
          name: p.name,
          prefix: p.prefix,
          repoPath: p.repoPath,
          archived: p.archived,
        }));
        return { content: [{ type: "text", text: JSON.stringify(projects, null, 2) }] };
      }
      case "list_issues": {
        let statusFilter: IssueStatus | undefined;
        if (args.status !== undefined) {
          if (typeof args.status !== "string" || !ISSUE_STATUSES.includes(args.status as IssueStatus)) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: `Unknown status "${args.status}". Valid statuses: ${ISSUE_STATUSES.join(", ")}` }),
                },
              ],
              isError: true,
            };
          }
          statusFilter = args.status as IssueStatus;
        }
        const labelFilter = typeof args.label === "string" && args.label.length > 0 ? args.label : undefined;
        const projectArg = typeof args.project === "string" ? args.project.trim() : "";

        // An unresolved project reads as "no issues", not an error — the same
        // convention loadIssues itself already uses for an unknown projectId
        // (see issue-storage.ts's safeIssuesFile comment): this is a read, and
        // "no such project" is a normal outcome here (e.g. a stale reference),
        // unlike `status` above, which is a small closed enum where a mismatch
        // is always a caller mistake worth surfacing loudly instead.
        let projects: Project[];
        if (projectArg) {
          const match = resolveProject(projectArg);
          projects = match ? [match] : [];
        } else {
          projects = loadProjects();
        }

        const issues = projects
          .flatMap((p) => loadIssues(p.id))
          .filter((issue) => statusFilter === undefined || issue.status === statusFilter)
          .filter((issue) => labelFilter === undefined || (issue.labels ?? []).includes(labelFilter))
          .map(issueSummary);

        return { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }] };
      }
      case "get_issue": {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        if (!key) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "key is required" }) }], isError: true };
        }
        const issue = getIssue(key);
        if (!issue) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Issue not found: ${key}` }) }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }] };
      }
      case "create_issue": {
        const projectArg = typeof args.project === "string" ? args.project.trim() : "";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!projectArg || !title) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "project and title are both required and must be non-empty" }) }],
            isError: true,
          };
        }
        const project = resolveProject(projectArg);
        if (!project) {
          // Unlike list_issues's read-only project filter, this is a write —
          // silently discarding it would be the same silent-success shape the
          // spec elsewhere complains about, so this errors instead, mirroring
          // saveIssue's own "Unknown project" throw for the same reason.
          return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown project: ${projectArg}` }) }], isError: true };
        }

        const description = typeof args.description === "string" ? args.description : undefined;

        let priority: 0 | 1 | 2 | 3 | 4 | undefined;
        if (args.priority !== undefined) {
          if (typeof args.priority !== "number" || !PRIORITIES.includes(args.priority as (typeof PRIORITIES)[number])) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `priority must be one of ${PRIORITIES.join(", ")}` }) }],
              isError: true,
            };
          }
          priority = args.priority as 0 | 1 | 2 | 3 | 4;
        }

        let labels: string[] | undefined;
        if (args.labels !== undefined) {
          if (!Array.isArray(args.labels) || !args.labels.every((l) => typeof l === "string")) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "labels must be an array of strings" }) }], isError: true };
          }
          labels = args.labels as string[];
        }

        // buildIssue's IssueInput type has no key/id/createdAt/activity/status
        // field at all (see issue-storage.ts), so nothing the caller put in
        // args under those names — however plausible-looking — ever reaches
        // the stored issue. Only the five fields picked out above are read,
        // and the actor comes from the token, never from args.
        const actor = actorFromCaller(caller);
        const issue = buildIssue({ projectId: project.id, title, description, priority, labels }, actor);
        saveIssue(issue);
        return { content: [{ type: "text", text: JSON.stringify({ created: issue }, null, 2) }] };
      }
      case "update_issue": {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        if (!key) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "key is required" }) }], isError: true };
        }
        const issue = getIssue(key);
        if (!issue) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Issue not found: ${key}` }) }], isError: true };
        }

        const patch: IssueUpdateInput = {};
        if (args.title !== undefined) {
          if (typeof args.title !== "string" || args.title.trim() === "") {
            return { content: [{ type: "text", text: JSON.stringify({ error: "title must be a non-empty string" }) }], isError: true };
          }
          patch.title = args.title;
        }
        if (args.description !== undefined) {
          if (typeof args.description !== "string") {
            return { content: [{ type: "text", text: JSON.stringify({ error: "description must be a string" }) }], isError: true };
          }
          patch.description = args.description;
        }
        if (args.status !== undefined) {
          if (typeof args.status !== "string" || !ISSUE_STATUSES.includes(args.status as IssueStatus)) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ error: `Unknown status "${args.status}". Valid statuses: ${ISSUE_STATUSES.join(", ")}` }),
                },
              ],
              isError: true,
            };
          }
          patch.status = args.status as IssueStatus;
        }
        if (args.priority !== undefined) {
          if (typeof args.priority !== "number" || !PRIORITIES.includes(args.priority as (typeof PRIORITIES)[number])) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `priority must be one of ${PRIORITIES.join(", ")}` }) }],
              isError: true,
            };
          }
          patch.priority = args.priority as 0 | 1 | 2 | 3 | 4;
        }
        if (args.labels !== undefined) {
          if (!Array.isArray(args.labels) || !args.labels.every((l) => typeof l === "string")) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "labels must be an array of strings" }) }], isError: true };
          }
          patch.labels = args.labels as string[];
        }

        // The actor comes from the token, never from args (no field in the
        // schema could even carry one) — same discipline as create_issue.
        const actor = actorFromCaller(caller);
        const updated = applyIssueUpdate(issue, patch, actor);
        // applyIssueUpdate returns the *same* object reference for a no-op
        // patch (see its own comment in issue-storage.ts), so this skips an
        // unnecessary write rather than re-saving unchanged data.
        if (updated !== issue) saveIssue(updated);
        return { content: [{ type: "text", text: JSON.stringify({ before: issue, after: updated }, null, 2) }] };
      }
      case "add_issue_comment": {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!key || !body.trim()) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "key and body are both required and must be non-empty" }) }],
            isError: true,
          };
        }
        const issue = getIssue(key);
        if (!issue) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Issue not found: ${key}` }) }], isError: true };
        }

        const actor = actorFromCaller(caller);
        const updated = addIssueComment(issue, body, actor);
        saveIssue(updated);
        const comment = updated.comments[updated.comments.length - 1];
        return { content: [{ type: "text", text: JSON.stringify({ added: comment, issue: updated }, null, 2) }] };
      }
      case "add_issue_attachment": {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        const url = typeof args.url === "string" ? args.url.trim() : "";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!key || !url || !title) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "key, url and title are all required and must be non-empty" }) }],
            isError: true,
          };
        }
        const issue = getIssue(key);
        if (!issue) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Issue not found: ${key}` }) }], isError: true };
        }

        const actor = actorFromCaller(caller);
        // Copies a local file into the issue-attachments root, because the
        // caller's path is usually one it does not own the lifetime of (a
        // chat attachment the PTY adapter deletes on the next message, a
        // screenshot in a temp dir). Throws for a missing file, which the
        // outer catch turns into an isError response.
        const storedUrl = persistAttachmentFile(issue.key, url);
        const updated = addIssueAttachment(issue, { title, url: storedUrl }, actor);
        saveIssue(updated);
        const attachment = updated.attachments[updated.attachments.length - 1];
        return { content: [{ type: "text", text: JSON.stringify({ added: attachment, issue: updated }, null, 2) }] };
      }
      default:
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      isError: true,
    };
  }
}

export class CockpitMcpServer {
  private httpServer: Server | null = null;
  private port = 0;

  async start(host = "127.0.0.1", port = 0): Promise<void> {
    this.httpServer = createServer((req, res) => {
      (async () => {
        if (req.url !== "/mcp" || req.method !== "POST") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }

        const authHeader = req.headers.authorization ?? "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (!isValidToken(token)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcpServer = new McpServer({ name: "cockpit-config", version: "1.0.0" }, { capabilities: { tools: {} } });

        // A job or session is shown only the tools scoped to it; the assistant
        // is shown everything else. handleToolCall enforces the same map, so a
        // model that names an unlisted tool still gets nothing.
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
          const caller: McpCaller = lookupCaller(token) ?? { kind: "assistant" };
          const issuesEnabled = getDefaults().issuesEnabled;
          return {
            tools: TOOL_DEFINITIONS.filter((t) => scopesFor(t.name).includes(caller.kind) && (issuesEnabled || !ISSUE_TOOLS.has(t.name))),
          };
        });
        mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
          const toolName = request.params.name;
          const toolArgs = (request.params.arguments as Record<string, unknown>) ?? {};
          return handleToolCall(toolName, toolArgs, token);
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      })().catch((err) => {
        console.error("[cockpit-mcp] request handler error:", err);
        if (!res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        resolve();
      });
    });
  }

  getUrl(host = "127.0.0.1"): string {
    return `http://${host}:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    this.httpServer = null;
  }
}
