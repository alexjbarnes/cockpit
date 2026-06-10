import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COCKPIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cockpit-test-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-test-"));

vi.mock("@/server/singleton", () => ({ getJobScheduler: vi.fn() }));

import { CockpitMcpServer } from "@/server/mcp/cockpit-config-server";
import { registerAuthToken } from "@/server/mcp/run-context";
import { getJobScheduler } from "@/server/singleton";

const HOST = "127.0.0.1";
let server: CockpitMcpServer;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  server = new CockpitMcpServer();
  await server.start(HOST, 0);
  baseUrl = server.getUrl(HOST);
  token = "test-token-abc123";
  registerAuthToken(token);
});

afterAll(async () => {
  await server.stop();
});

async function mcpPost(body: unknown, authToken = token): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/^data: (.+)$/m);
    if (match) {
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        parsed = text;
      }
    }
  }
  return { status: res.status, body: parsed };
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = await mcpPost({
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 10000),
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(res.status).toBe(200);
  return (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text;
}

async function callToolParsed(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const text = await callTool(name, args);
  return JSON.parse(text as string);
}

describe("cockpit-config MCP server (in-process HTTP)", () => {
  it("rejects request with no token", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "");
    expect(res.status).toBe(401);
  });

  it("rejects request with invalid token", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "invalid-token-xyz");
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-/mcp paths", async () => {
    const res = await fetch(`${baseUrl}/other`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for GET requests", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("responds to initialize", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    });
    expect(res.status).toBe(200);
    const body = res.body as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("cockpit-config");
  });

  it("tools/list returns all expected tool names", async () => {
    const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const body = res.body as { result?: { tools: { name: string }[] } };
    const names = (body.result?.tools ?? []).map((t) => t.name).sort();
    for (const name of [
      "list_jobs",
      "get_job",
      "create_job",
      "update_job",
      "delete_job",
      "get_settings",
      "update_settings",
      "list_providers",
      "add_provider",
      "update_provider",
      "delete_provider",
      "list_mcp_servers",
      "get_mcp_server",
      "save_mcp_server",
      "delete_mcp_server",
      "get_notification_settings",
      "update_notification_settings",
      "list_notification_providers",
      "add_notification_provider",
      "update_notification_provider",
      "delete_notification_provider",
      "run_job",
      "list_running_jobs",
    ]) {
      expect(names).toContain(name);
    }
  });

  describe("jobs", () => {
    it("list_jobs returns empty array initially", async () => {
      const result = await callToolParsed("list_jobs");
      expect(Array.isArray(result)).toBe(true);
    });

    it("create_job writes via job-storage", async () => {
      const result = (await callToolParsed("create_job", {
        name: "test-job",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "run tests",
        cwd: "/tmp",
      })) as { created: { name: string; id: string } };
      expect(result.created.name).toBe("test-job");
      expect(result.created.id).toBeDefined();
    });

    it("list_jobs returns the created job", async () => {
      const result = (await callToolParsed("list_jobs")) as { name: string }[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.some((j) => j.name === "test-job")).toBe(true);
    });

    it("get_job returns job by id", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "test-job")!;
      const result = (await callToolParsed("get_job", { id: job.id })) as { name: string };
      expect(result.name).toBe("test-job");
    });

    it("get_job returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_job", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("update_job modifies the job", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "test-job")!;
      const result = (await callToolParsed("update_job", { id: job.id, name: "updated-job" })) as { after: { name: string } };
      expect(result.after.name).toBe("updated-job");
    });

    it("update_job returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "update_job", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("delete_job removes the job", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "updated-job")!;
      const result = (await callToolParsed("delete_job", { id: job.id })) as { deleted: { name: string } };
      expect(result.deleted.name).toBe("updated-job");
      const after = (await callToolParsed("list_jobs")) as { name: string }[];
      expect(after.some((j) => j.name === "updated-job")).toBe(false);
    });

    it("delete_job returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "delete_job", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  describe("job tools (run_job / list_running_jobs / batch)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("run_job started", async () => {
      const stubScheduler = {
        getRunningJobs: () => new Map(),
        triggerJob: vi.fn(() => new Promise(() => {})),
      };
      vi.mocked(getJobScheduler).mockReturnValue(stubScheduler as never);

      const created = (await callToolParsed("create_job", {
        name: "run-test-job",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo hello",
        cwd: "/tmp",
      })) as { created: { id: string; name: string } };

      const result = (await callToolParsed("run_job", { id: created.created.id })) as { results: { id: string; status: string }[] };
      expect(result.results[0].status).toBe("started");
      expect(stubScheduler.triggerJob).toHaveBeenCalledWith(created.created.id);
    });

    it("run_job not_found", async () => {
      vi.mocked(getJobScheduler).mockReturnValue({
        getRunningJobs: () => new Map(),
        triggerJob: vi.fn(),
      } as never);

      const result = (await callToolParsed("run_job", { id: "nonexistent-id" })) as { results: { id: string; status: string }[] };
      expect(result.results[0].status).toBe("not_found");
    });

    it("run_job already_running", async () => {
      const runningMap = new Map();
      runningMap.set("running-job-id", { jobId: "running-job-id" });
      vi.mocked(getJobScheduler).mockReturnValue({
        getRunningJobs: () => runningMap,
        triggerJob: vi.fn(),
      } as never);

      const created = (await callToolParsed("create_job", {
        name: "already-running-test",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo hello",
        cwd: "/tmp",
      })) as { created: { id: string; name: string } };
      runningMap.set(created.created.id, { jobId: created.created.id });

      const result = (await callToolParsed("run_job", { id: created.created.id })) as { results: { id: string; status: string }[] };
      expect(result.results[0].status).toBe("already_running");
    });

    it("run_job no scheduler", async () => {
      vi.mocked(getJobScheduler).mockReturnValue(null as never);

      const result = (await callToolParsed("run_job", { id: "any-id" })) as { results: { id: string; status: string }[] };
      expect(result.results[0].status).toBe("scheduler not available");
    });

    it("run_job batch ids", async () => {
      const stubScheduler = {
        getRunningJobs: () => new Map(),
        triggerJob: vi.fn(() => new Promise(() => {})),
      };
      vi.mocked(getJobScheduler).mockReturnValue(stubScheduler as never);

      const a = (await callToolParsed("create_job", {
        name: "batch-run-a",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };
      const b = (await callToolParsed("create_job", {
        name: "batch-run-b",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo b",
        cwd: "/tmp",
      })) as { created: { id: string } };

      const result = (await callToolParsed("run_job", { ids: [a.created.id, "nonexistent", b.created.id] })) as {
        results: { id: string; status: string }[];
      };
      expect(result.results).toHaveLength(3);
      expect(result.results[0].status).toBe("started");
      expect(result.results[1].status).toBe("not_found");
      expect(result.results[2].status).toBe("started");
    });

    it("run_job no id provided", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "run_job", arguments: {} },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("no job id provided");
    });

    it("list_running_jobs empty", async () => {
      vi.mocked(getJobScheduler).mockReturnValue({
        getRunningJobs: () => new Map(),
      } as never);

      const result = (await callToolParsed("list_running_jobs")) as { running: unknown[]; count: number };
      expect(result.running).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it("list_running_jobs populated", async () => {
      vi.mocked(getJobScheduler).mockReturnValue({
        getRunningJobs: () =>
          new Map([
            [
              "job-1",
              {
                id: "run-1",
                jobId: "job-1",
                sessionId: "session-1",
                status: "running",
                startedAt: Date.now() - 5000,
                toolsUsed: [{ name: "Read" }],
                messageCount: 3,
              },
            ],
          ]),
      } as never);

      const result = (await callToolParsed("list_running_jobs")) as {
        running: { jobId: string; name: string; runId: string; sessionId: string; elapsedMs: number }[];
        count: number;
      };
      expect(result.count).toBe(1);
      expect(result.running[0].runId).toBe("run-1");
      expect(result.running[0].sessionId).toBe("session-1");
      expect(result.running[0].elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it("list_running_jobs no scheduler", async () => {
      vi.mocked(getJobScheduler).mockReturnValue(null as never);

      const result = (await callToolParsed("list_running_jobs")) as { running: unknown[]; count: number; note: string };
      expect(result.running).toHaveLength(0);
      expect(result.count).toBe(0);
      expect(result.note).toContain("scheduler not available");
    });

    it("stop_job returns stopped record for a running job", async () => {
      const stopJob = vi.fn(() => ({
        jobId: "job-1",
        id: "run-1",
        status: "stopped",
        startedAt: Date.now() - 5000,
        durationMs: 5000,
        messageCount: 3,
        toolsUsed: [{ name: "Read" }],
      }));
      vi.mocked(getJobScheduler).mockReturnValue({
        stopJob,
      } as never);

      const result = (await callToolParsed("stop_job", { id: "job-1" })) as {
        status: string;
        jobId: string;
        runId: string;
      };
      expect(result.status).toBe("stopped");
      expect(result.jobId).toBe("job-1");
      expect(result.runId).toBe("run-1");
    });

    it("stop_job returns error when job is not running", async () => {
      vi.mocked(getJobScheduler).mockReturnValue({
        stopJob: vi.fn(() => {
          throw new Error("Job is not currently running");
        }),
      } as never);

      const result = (await callToolParsed("stop_job", { id: "not-running" })) as { error: string };
      expect(result.error).toContain("Job is not currently running");
    });

    it("stop_job returns error for missing id", async () => {
      const result = (await callToolParsed("stop_job", {})) as { error: string };
      expect(result.error).toContain("no job id provided");
    });

    it("stop_job returns error when no scheduler", async () => {
      vi.mocked(getJobScheduler).mockReturnValue(null as never);

      const result = (await callToolParsed("stop_job", { id: "any" })) as { error: string };
      expect(result.error).toContain("scheduler not available");
    });

    it("delete_job batch", async () => {
      const a = (await callToolParsed("create_job", {
        name: "batch-del-a",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };
      const b = (await callToolParsed("create_job", {
        name: "batch-del-b",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo b",
        cwd: "/tmp",
      })) as { created: { id: string } };

      const result = (await callToolParsed("delete_job", { ids: [a.created.id, "nonexistent", b.created.id] })) as {
        results: { id: string; deleted?: boolean; error?: string }[];
      };
      expect(result.results).toHaveLength(3);
      expect(result.results[0].deleted).toBe(true);
      expect(result.results[1].error).toContain("not found");
      expect(result.results[2].deleted).toBe(true);
    });

    it("update_job batch", async () => {
      const a = (await callToolParsed("create_job", {
        name: "batch-upd-a",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };
      const b = (await callToolParsed("create_job", {
        name: "batch-upd-b",
        schedule: { type: "simple", frequency: "hourly" },
        prompt: "echo b",
        cwd: "/tmp",
      })) as { created: { id: string } };

      const result = (await callToolParsed("update_job", {
        updates: [
          { id: a.created.id, enabled: false },
          { id: "nonexistent", name: "x" },
          { id: b.created.id, name: "renamed-b" },
        ],
      })) as { results: { id: string; before?: Record<string, unknown>; after?: Record<string, unknown>; error?: string }[] };
      expect(result.results).toHaveLength(3);
      expect(result.results[0].after).toBeDefined();
      expect((result.results[0].after as { enabled: boolean }).enabled).toBe(false);
      expect(result.results[1].error).toContain("not found");
      expect((result.results[2].after as { name: string }).name).toBe("renamed-b");
    });
  });

  describe("settings", () => {
    it("get_settings returns defaults", async () => {
      const result = (await callToolParsed("get_settings")) as Record<string, unknown>;
      expect(result).toHaveProperty("thinkingLevel");
      expect(result).toHaveProperty("diffStyle");
    });

    it("update_settings changes thinkingLevel", async () => {
      const result = (await callToolParsed("update_settings", { thinkingLevel: "low" })) as {
        before: unknown;
        after: { thinkingLevel: string };
      };
      expect(result.after.thinkingLevel).toBe("low");
    });

    it("update_settings allows bypassAllPermissions", async () => {
      await callTool("update_settings", { bypassAllPermissions: true });
      const settings = (await callToolParsed("get_settings")) as { bypassAllPermissions?: boolean };
      expect(settings.bypassAllPermissions).toBe(true);
    });

    it("update_settings allows modelSlots", async () => {
      const modelSlots = { main: "claude-opus-4-5-20251101", mainContext: "100k" };
      await callTool("update_settings", { modelSlots });
      const settings = (await callToolParsed("get_settings")) as { modelSlots?: Record<string, string> };
      expect(settings.modelSlots?.main).toBe("claude-opus-4-5-20251101");
      expect(settings.modelSlots?.mainContext).toBe("100k");
    });
  });

  describe("providers", () => {
    it("list_providers returns empty array initially", async () => {
      const result = await callToolParsed("list_providers");
      expect(Array.isArray(result)).toBe(true);
    });

    it("add_provider creates a provider", async () => {
      const result = (await callToolParsed("add_provider", {
        name: "test-provider",
        envVars: { API_KEY: "test-key" },
      })) as { created: { name: string; id: string } };
      expect(result.created.name).toBe("test-provider");
      expect(result.created.id).toBeDefined();
    });

    it("list_providers returns created provider", async () => {
      const result = (await callToolParsed("list_providers")) as { name: string }[];
      expect(result.some((p) => p.name === "test-provider")).toBe(true);
    });

    it("update_provider modifies provider", async () => {
      const providers = (await callToolParsed("list_providers")) as { id: string; name: string }[];
      const p = providers.find((p) => p.name === "test-provider")!;
      const result = (await callToolParsed("update_provider", { id: p.id, name: "renamed-provider" })) as { after: { name: string } };
      expect(result.after.name).toBe("renamed-provider");
    });

    it("update_provider returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "update_provider", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("delete_provider removes provider", async () => {
      const providers = (await callToolParsed("list_providers")) as { id: string; name: string }[];
      const p = providers.find((p) => p.name === "renamed-provider")!;
      const result = (await callToolParsed("delete_provider", { id: p.id })) as { deleted: { name: string } };
      expect(result.deleted.name).toBe("renamed-provider");
    });

    it("delete_provider returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "delete_provider", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  describe("mcp-servers", () => {
    it("list_mcp_servers returns empty initially", async () => {
      const result = await callToolParsed("list_mcp_servers");
      expect(Array.isArray(result)).toBe(true);
    });

    it("save_mcp_server creates an entry", async () => {
      const result = (await callToolParsed("save_mcp_server", {
        name: "test-mcp",
        command: "node",
        args: ["/path/to/server.js"],
      })) as { after: { command: string } };
      expect(result.after.command).toBe("node");
    });

    it("get_mcp_server retrieves the entry", async () => {
      const result = (await callToolParsed("get_mcp_server", { name: "test-mcp" })) as { command: string };
      expect(result.command).toBe("node");
    });

    it("get_mcp_server returns error for unknown name", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_mcp_server", arguments: { name: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("delete_mcp_server removes the entry", async () => {
      const result = (await callToolParsed("delete_mcp_server", { name: "test-mcp" })) as { deleted: { command: string } };
      expect(result.deleted.command).toBe("node");
    });

    it("delete_mcp_server returns error for unknown name", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "delete_mcp_server", arguments: { name: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  describe("notification settings", () => {
    it("get_notification_settings returns settings", async () => {
      const result = (await callToolParsed("get_notification_settings")) as Record<string, unknown>;
      expect(result).toHaveProperty("providers");
    });

    it("update_notification_settings changes baseUrl", async () => {
      const result = (await callToolParsed("update_notification_settings", { baseUrl: "https://example.com/hook" })) as {
        after: { baseUrl?: string };
      };
      expect(result.after.baseUrl).toBe("https://example.com/hook");
    });

    it("add/update/delete notification provider round-trip", async () => {
      const empty = (await callToolParsed("list_notification_providers")) as unknown[];
      expect(Array.isArray(empty)).toBe(true);

      // add
      const added = (await callToolParsed("add_notification_provider", {
        type: "telegram",
        name: "My Bot",
        config: { botToken: "123:ABC", chatId: "-1001" },
      })) as { created: { id: string; name: string; type: string } };
      expect(added.created.name).toBe("My Bot");
      expect(added.created.type).toBe("telegram");
      const id = added.created.id;

      // update
      const updated = (await callToolParsed("update_notification_provider", { id, name: "Renamed Bot", enabled: false })) as {
        after: { name: string; enabled: boolean };
      };
      expect(updated.after.name).toBe("Renamed Bot");
      expect(updated.after.enabled).toBe(false);

      // delete
      const deleted = (await callToolParsed("delete_notification_provider", { id })) as { deleted: { id: string } };
      expect(deleted.deleted.id).toBe(id);

      const afterDel = (await callToolParsed("list_notification_providers")) as { id: string }[];
      expect(afterDel.find((p) => p.id === id)).toBeUndefined();
    });

    it("update_notification_provider returns error for unknown id", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 90,
        method: "tools/call",
        params: { name: "update_notification_provider", arguments: { id: "nonexistent-id" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });
  });

  it("returns error for unknown tool", async () => {
    const res = await mcpPost({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
    expect(JSON.parse(text).error).toContain("Unknown tool");
  });
});
