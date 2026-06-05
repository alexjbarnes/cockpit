import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const COCKPIT_DIR = process.env.COCKPIT_CONFIG_DIR ?? path.join(homedir(), ".cockpit");
const CLAUDE_FILE = path.join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");

function uuid(): string {
  try {
    return randomUUID();
  } catch {
    return Array.from({ length: 36 }, () => Math.floor(Math.random() * 16).toString(16))
      .map((c, i) => ([8, 13, 18, 23].includes(i) ? "-" : c))
      .join("");
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function mcpEntry<T>(filePath: string, fallback: T): { read: () => T; write: (data: T) => void } {
  return { read: () => readJson(filePath, fallback), write: (data: T) => writeJson(filePath, data) };
}

interface ScheduledJob {
  id: string;
  name: string;
  schedule: { type: string };
  prompt: string;
  cwd: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  model?: string;
  contextSize?: string;
  thinkingLevel?: string;
  allowedTools?: string[];
  mcpServers?: string[];
  mcpToolFilters?: Record<string, string[]>;
  bypassPermissions?: boolean;
  maxDurationMinutes?: number;
  retentionDays?: number;
  skipIfMissed?: boolean;
  inboxOutput?: boolean;
  notifyProviders?: string[];
  runtime?: string;
}

interface AppDefaults {
  thinkingLevel: string;
  bypassAllPermissions: boolean;
  diffStyle: string;
  dismissKeyboardOnSend: boolean;
  thinkingExpanded: boolean;
  readExpanded: boolean;
  editExpanded: boolean;
  toolCallsExpanded: boolean;
  modelSlots: Record<string, string>;
  messageStitching: boolean;
  reviewsEnabled: boolean;
}

interface Provider {
  id: string;
  name: string;
  envVars: Record<string, string>;
  models: unknown[];
  isBuiltin?: boolean;
}

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const jobsStore = mcpEntry<{ jobs: ScheduledJob[] }>(path.join(COCKPIT_DIR, "scheduled-jobs.json"), { jobs: [] });
const settingsStore = mcpEntry<Partial<AppDefaults>>(path.join(COCKPIT_DIR, "defaults.json"), {});
const providersStore = mcpEntry<Provider[]>(path.join(COCKPIT_DIR, "providers.json"), []);
const notificationsStore = mcpEntry<{ providers: unknown[] }>(path.join(COCKPIT_DIR, "notifications.json"), { providers: [] });
const mcpServersStore = mcpEntry<{ mcpServers: Record<string, McpServerEntry> }>(CLAUDE_FILE, { mcpServers: {} });

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
      },
      required: ["name", "schedule", "prompt", "cwd"],
    },
  },
  {
    name: "update_job",
    description: "Update an existing scheduled job",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_job",
    description: "Delete a scheduled job by ID",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_settings",
    description: "Get current application settings",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_settings",
    description: "Update application settings",
    inputSchema: { type: "object", properties: { thinkingLevel: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] } } },
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
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

function handleToolCall(name: string, args: Record<string, unknown>): { content: { type: string; text: string }[]; isError?: boolean } {
  try {
    switch (name) {
      case "list_jobs": {
        return { content: [{ type: "text", text: JSON.stringify(jobsStore.read().jobs, null, 2) }] };
      }
      case "get_job": {
        const { id } = args;
        const job = jobsStore.read().jobs.find((j) => j.id === id);
        if (!job) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${id}` }) }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
      }
      case "create_job": {
        const data = jobsStore.read();
        const now = Date.now();
        const job: ScheduledJob = {
          id: uuid(),
          name: args.name as string,
          schedule: args.schedule as ScheduledJob["schedule"],
          prompt: args.prompt as string,
          cwd: args.cwd as string,
          enabled: (args.enabled as boolean) ?? true,
          createdAt: now,
          updatedAt: now,
        };
        data.jobs.push(job);
        jobsStore.write(data);
        return { content: [{ type: "text", text: JSON.stringify({ created: job }, null, 2) }] };
      }
      case "update_job": {
        const data = jobsStore.read();
        const idx = data.jobs.findIndex((j) => j.id === args.id);
        if (idx === -1) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        const before = { ...data.jobs[idx] };
        const update = { ...args };
        delete (update as Record<string, unknown>).id;
        data.jobs[idx] = { ...data.jobs[idx], ...update, updatedAt: Date.now() };
        jobsStore.write(data);
        return { content: [{ type: "text", text: JSON.stringify({ before, after: data.jobs[idx] }, null, 2) }] };
      }
      case "delete_job": {
        const data = jobsStore.read();
        const idx = data.jobs.findIndex((j) => j.id === args.id);
        if (idx === -1) return { content: [{ type: "text", text: JSON.stringify({ error: `Job not found: ${args.id}` }) }], isError: true };
        const deleted = data.jobs.splice(idx, 1)[0];
        jobsStore.write(data);
        return { content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }] };
      }
      case "get_settings": {
        const fallback: AppDefaults = {
          thinkingLevel: "high",
          bypassAllPermissions: false,
          diffStyle: "split",
          dismissKeyboardOnSend: true,
          thinkingExpanded: false,
          readExpanded: false,
          editExpanded: false,
          toolCallsExpanded: false,
          modelSlots: { main: "sonnet" },
          messageStitching: true,
          reviewsEnabled: true,
        };
        return { content: [{ type: "text", text: JSON.stringify({ ...fallback, ...settingsStore.read() }, null, 2) }] };
      }
      case "update_settings": {
        const before = settingsStore.read();
        const after = { ...before, ...args };
        settingsStore.write(after);
        return { content: [{ type: "text", text: JSON.stringify({ before, after }, null, 2) }] };
      }
      case "list_providers": {
        return { content: [{ type: "text", text: JSON.stringify(providersStore.read(), null, 2) }] };
      }
      case "add_provider": {
        const providers = providersStore.read();
        const provider: Provider = {
          id: uuid(),
          name: args.name as string,
          envVars: args.envVars as Record<string, string>,
          models: (args.models as unknown[]) ?? [],
        };
        providers.push(provider);
        providersStore.write(providers);
        return { content: [{ type: "text", text: JSON.stringify({ created: provider }, null, 2) }] };
      }
      case "update_provider": {
        const providers = providersStore.read();
        const idx = providers.findIndex((p) => p.id === args.id);
        if (idx === -1)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        const before = { ...providers[idx] };
        const update = { ...args };
        delete (update as Record<string, unknown>).id;
        providers[idx] = { ...providers[idx], ...update };
        providersStore.write(providers);
        return { content: [{ type: "text", text: JSON.stringify({ before, after: providers[idx] }, null, 2) }] };
      }
      case "delete_provider": {
        const providers = providersStore.read();
        const idx = providers.findIndex((p) => p.id === args.id);
        if (idx === -1)
          return { content: [{ type: "text", text: JSON.stringify({ error: `Provider not found: ${args.id}` }) }], isError: true };
        const deleted = providers.splice(idx, 1)[0];
        providersStore.write(providers);
        return { content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }] };
      }
      case "list_mcp_servers": {
        const entries = Object.entries(mcpServersStore.read().mcpServers).map(([name, config]) => ({
          name,
          command: config.command,
          args: config.args,
        }));
        return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
      }
      case "get_mcp_server": {
        const entry = mcpServersStore.read().mcpServers[args.name as string];
        if (!entry)
          return { content: [{ type: "text", text: JSON.stringify({ error: `MCP server not found: ${args.name}` }) }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify({ name: args.name, ...entry }, null, 2) }] };
      }
      case "save_mcp_server": {
        const mcpData = mcpServersStore.read();
        const entryName = args.name as string;
        const before = mcpData.mcpServers[entryName] ? { ...mcpData.mcpServers[entryName] } : null;
        mcpData.mcpServers[entryName] = {
          command: args.command as string,
          args: args.args as string[],
          env: args.env as Record<string, string> | undefined,
        };
        mcpServersStore.write(mcpData);
        return { content: [{ type: "text", text: JSON.stringify({ before, after: mcpData.mcpServers[entryName] }, null, 2) }] };
      }
      case "delete_mcp_server": {
        const mcpData = mcpServersStore.read();
        if (!mcpData.mcpServers[args.name as string])
          return { content: [{ type: "text", text: JSON.stringify({ error: `MCP server not found: ${args.name}` }) }], isError: true };
        const deleted = mcpData.mcpServers[args.name as string];
        delete mcpData.mcpServers[args.name as string];
        mcpServersStore.write(mcpData);
        return { content: [{ type: "text", text: JSON.stringify({ deleted }, null, 2) }] };
      }
      case "get_notification_settings": {
        return { content: [{ type: "text", text: JSON.stringify(notificationsStore.read(), null, 2) }] };
      }
      case "update_notification_settings": {
        const before = notificationsStore.read();
        const after = { ...before, ...args };
        notificationsStore.write(after);
        return { content: [{ type: "text", text: JSON.stringify({ before, after }, null, 2) }] };
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

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", (line: string) => {
  if (!line.trim()) return;

  let request: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const id = request.id;
  const method = request.method;

  // Handle JSON-RPC notifications (no id)
  if (!id) return;

  function sendResponse(
    result:
      | Record<string, unknown>
      | { content: { type: string; text: string }[]; isError?: boolean }
      | { serverInfo: { name: string; version: string }; capabilities: { tools: Record<string, unknown> } },
  ) {
    const response = { jsonrpc: "2.0", id, result };
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  function sendError(code: number, message: string) {
    const response = { jsonrpc: "2.0", id, error: { code, message } };
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  switch (method) {
    case "initialize":
      sendResponse({
        serverInfo: { name: "cockpit-config", version: "1.0.0" },
        capabilities: { tools: {} },
      });
      break;

    case "notifications/initialized":
      // no response expected
      break;

    case "tools/list":
      sendResponse({ tools: TOOL_DEFINITIONS });
      break;

    case "tools/call": {
      const toolName = request.params?.name as string;
      const toolArgs = (request.params?.arguments as Record<string, unknown>) || {};
      const result = handleToolCall(toolName, toolArgs);
      sendResponse(result);
      break;
    }

    default:
      sendError(-32601, `Method not found: ${method}`);
  }
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`cockpit-config-server fatal: ${err}\n`);
  process.exit(1);
});
