import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getDefaults, setDefaults } from "@/server/defaults";
import { deleteJob, getJob, loadJobs, saveJob } from "@/server/job-storage";
import { getNotificationSettings, setNotificationSettings, updateNotificationSettings } from "@/server/notification-settings";
import { getClaudeUserConfigFile } from "@/server/paths";
import { addProvider, deleteProvider, getProviders, updateProvider } from "@/server/providers";
import { getJobScheduler } from "@/server/singleton";
import type { InboxPriority, JobRun, NotificationProviderEntry, ScheduledJob } from "@/types";
import { isValidToken } from "./run-context";

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
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
        schedule: { type: "object", properties: { type: { type: "string", enum: ["simple", "cron"] } }, required: ["type"] },
        schedules: {
          type: "array",
          items: { type: "object" },
          description: "Multiple schedules (use instead of schedule for multi-schedule jobs)",
        },
        prompt: { type: "string" },
        cwd: { type: "string" },
        enabled: { type: "boolean" },
        model: { type: "string" },
        contextSize: { type: "string" },
        thinkingLevel: { type: "string" },
        bypassPermissions: { type: "boolean" },
        maxDurationMinutes: { type: "number" },
        retentionDays: { type: "number" },
        skipIfMissed: { type: "boolean" },
        inboxOutput: { type: "boolean" },
        runtime: { type: "string", enum: ["stream", "pty"], description: "Execution runtime: stream (default) or pty" },
        allowedTools: { type: "array", items: { type: "string" }, description: "Tool names the job is allowed to use" },
        mcpServers: { type: "array", items: { type: "string" }, description: "MCP server names to enable for this job" },
        mcpToolFilters: { type: "object", description: 'Per-MCP-server tool filter: { serverName: ["tool1", "tool2"] }' },
        notifyProviders: { type: "array", items: { type: "string" }, description: "Notification provider IDs to alert on job completion" },
      },
      required: ["name", "schedule", "prompt", "cwd"],
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
        schedule: { type: "object", properties: { type: { type: "string", enum: ["simple", "cron"] } }, required: ["type"] },
        schedules: { type: "array", items: { type: "object" } },
        prompt: { type: "string" },
        cwd: { type: "string" },
        enabled: { type: "boolean" },
        model: { type: "string" },
        contextSize: { type: "string" },
        thinkingLevel: { type: "string" },
        bypassPermissions: { type: "boolean" },
        maxDurationMinutes: { type: "number" },
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
        thinkingLevel: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        diffStyle: { type: "string", enum: ["split", "unified"] },
        dismissKeyboardOnSend: { type: "boolean" },
        thinkingExpanded: { type: "boolean" },
        readExpanded: { type: "boolean" },
        editExpanded: { type: "boolean" },
        toolCallsExpanded: { type: "boolean" },
        messageStitching: { type: "boolean" },
        reviewsEnabled: { type: "boolean" },
        bypassAllPermissions: { type: "boolean" },
        modelSlots: {
          type: "object",
          properties: {
            main: { type: "string", description: "Model ID (e.g. claude-sonnet-4-5, claude-opus-4-5, claude-haiku-4-5)" },
            mainContext: { type: "string", enum: ["50k", "100k", "200k"], description: "Context window size" },
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
    name: "list_running_jobs",
    description: "List scheduled jobs that are currently running",
    inputSchema: { type: "object", properties: {}, required: [] },
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

function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  _token: string,
): { content: { type: string; text: string }[]; isError?: boolean } {
  try {
    switch (name) {
      case "list_jobs":
        return { content: [{ type: "text", text: JSON.stringify(loadJobs(), null, 2) }] };
      case "get_job": {
        const job = getJob(args.id as string);
        if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
      }
      case "create_job": {
        const now = Date.now();
        const job: ScheduledJob = {
          id: randomUUID(),
          name: args.name as string,
          schedule: args.schedule as ScheduledJob["schedule"],
          prompt: args.prompt as string,
          cwd: args.cwd as string,
          enabled: (args.enabled as boolean) ?? true,
          createdAt: now,
          updatedAt: now,
        };
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
            const update = { ...entry };
            delete (update as Record<string, unknown>).id;
            const updated: ScheduledJob = { ...existing, ...update, updatedAt: Date.now() };
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
        const update = { ...args };
        delete (update as Record<string, unknown>).id;
        const updated: ScheduledJob = { ...existing, ...update, updatedAt: Date.now() };
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
        return { content: [{ type: "text", text: JSON.stringify(getProviders(), null, 2) }] };
      case "add_provider": {
        const provider = addProvider({
          name: args.name as string,
          envVars: args.envVars as Record<string, string>,
          models: [],
        });
        return { content: [{ type: "text", text: JSON.stringify({ created: provider }, null, 2) }] };
      }
      case "update_provider": {
        const { id, ...rest } = args;
        const before = getProviders().find((p) => p.id === id);
        if (!before) return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${id}` }) }], isError: true };
        const after = updateProvider(id as string, rest as Parameters<typeof updateProvider>[1]);
        return { content: [{ type: "text", text: JSON.stringify({ before, after }, null, 2) }] };
      }
      case "delete_provider": {
        const provider = getProviders().find((p) => p.id === args.id);
        if (!provider)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        deleteProvider(args.id as string);
        return { content: [{ type: "text", text: JSON.stringify({ deleted: provider }, null, 2) }] };
      }
      case "list_mcp_servers": {
        const config = readClaudeConfig();
        const entries = Object.entries(config.mcpServers ?? {}).map(([n, c]) => ({ name: n, ...c }));
        return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
      }
      case "get_mcp_server": {
        const config = readClaudeConfig();
        const entry = config.mcpServers?.[args.name as string];
        if (!entry)
          return { content: [{ type: "text", text: JSON.stringify({ error: `MCP server not found: ${args.name}` }) }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify({ name: args.name, ...entry }, null, 2) }] };
      }
      case "save_mcp_server": {
        const config = readClaudeConfig();
        const servers = config.mcpServers ?? {};
        const before = servers[args.name as string] ? { ...servers[args.name as string] } : null;
        servers[args.name as string] = {
          command: args.command as string,
          args: args.args as string[],
          env: args.env as Record<string, string> | undefined,
        };
        writeClaudeConfig({ ...config, mcpServers: servers });
        return { content: [{ type: "text", text: JSON.stringify({ before, after: servers[args.name as string] }, null, 2) }] };
      }
      case "delete_mcp_server": {
        const config = readClaudeConfig();
        const servers = config.mcpServers ?? {};
        if (!servers[args.name as string])
          return { content: [{ type: "text", text: JSON.stringify({ error: `MCP server not found: ${args.name}` }) }], isError: true };
        const deleted = servers[args.name as string];
        delete servers[args.name as string];
        writeClaudeConfig({ ...config, mcpServers: servers });
        return { content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }] };
      }
      case "get_notification_settings":
        return { content: [{ type: "text", text: JSON.stringify(getNotificationSettings(), null, 2) }] };
      case "update_notification_settings": {
        const before = getNotificationSettings();
        const after = updateNotificationSettings(args as Parameters<typeof updateNotificationSettings>[0]);
        return { content: [{ type: "text", text: JSON.stringify({ before, after }, null, 2) }] };
      }
      case "list_notification_providers": {
        const settings = getNotificationSettings();
        return { content: [{ type: "text", text: JSON.stringify(settings.providers, null, 2) }] };
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
        return { content: [{ type: "text", text: JSON.stringify({ created: entry, providers: after.providers }, null, 2) }] };
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
          ...(args.config !== undefined ? { config: args.config as NotificationProviderEntry["config"] } : {}),
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
        return { content: [{ type: "text", text: JSON.stringify({ before, after: after.providers[idx] }, null, 2) }] };
      }
      case "delete_notification_provider": {
        const settings = getNotificationSettings();
        const provider = settings.providers.find((p) => p.id === args.id);
        if (!provider)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        const after = setNotificationSettings({ ...settings, providers: settings.providers.filter((p) => p.id !== args.id) });
        return { content: [{ type: "text", text: JSON.stringify({ deleted: provider, providers: after.providers }, null, 2) }] };
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

        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
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
