import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.COCKPIT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cockpit-test-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-test-"));

vi.mock("@/server/singleton", () => ({ getJobScheduler: vi.fn() }));

import { getInboxMessages } from "@/server/inbox";
import { saveRun } from "@/server/job-storage";
import { CockpitMcpServer } from "@/server/mcp/cockpit-config-server";
import { registerAuthToken, registerRunContext, registerSessionContext } from "@/server/mcp/run-context";
import { setNotificationSettings } from "@/server/notification-settings";
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
      "stop_job",
      "list_running_jobs",
      "get_job_transcript",
    ]) {
      expect(names).toContain(name);
    }
    // The job/session-only tools are the mirror image: the assistant must not
    // see them, proven directly rather than merely absent-from-the-list-above.
    expect(names).not.toContain("add_inbox_message");
    expect(names).not.toContain("list_notify_targets");
  });

  describe("jobs", () => {
    it("list_jobs returns empty array initially", async () => {
      const result = await callToolParsed("list_jobs");
      expect(Array.isArray(result)).toBe(true);
    });

    it("create_job writes via job-storage", async () => {
      const result = (await callToolParsed("create_job", {
        name: "test-job",
        schedules: [{ type: "simple", frequency: "hourly" }],
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

    it("update_job replaces schedules", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "updated-job")!;
      const result = (await callToolParsed("update_job", {
        id: job.id,
        schedules: [{ type: "simple", frequency: "daily", time: "05:00" }],
      })) as { after: { schedules: { time?: string }[] } };
      expect(result.after.schedules?.[0]?.time).toBe("05:00");
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

    it("create_job persists every field its schema advertises", async () => {
      // The regression this guards: create_job documented nineteen fields and
      // assigned five, so a job the assistant made came out with no tool
      // access, no inbox output and no notification providers, silently. The
      // list is read off tools/list rather than hardcoded, so a field added to
      // the schema and forgotten in the handler fails here.
      const listed = await mcpPost({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} });
      const schema = (
        (listed.body as { result?: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } })?.result?.tools ??
        []
      ).find((t) => t.name === "create_job");
      const advertised = Object.keys(schema?.inputSchema.properties ?? {});
      expect(advertised.length).toBeGreaterThan(15);

      const sent: Record<string, unknown> = {
        name: "fully-specified",
        schedules: [{ type: "simple", frequency: "daily", time: "17:00" }],
        prompt: "Scrape the forecast.",
        cwd: "/tmp",
        enabled: false,
        model: "claude-opus-5",
        contextSize: "1m",
        thinkingLevel: "max",
        bypassPermissions: true,
        maxDurationMinutes: 45,
        maxRetries: 3,
        retentionDays: 30,
        skipIfMissed: true,
        inboxOutput: true,
        runtime: "pty",
        allowedTools: ["WebFetch"],
        mcpServers: ["graphene"],
        mcpToolFilters: { graphene: ["status"] },
        notifyProviders: ["ntfy-provider-id"],
      };
      // Every advertised field must be exercised, or the test would pass while
      // ignoring the one that regressed.
      expect(Object.keys(sent).sort()).toEqual(advertised.sort());

      const created = (await callToolParsed("create_job", sent)) as { created: Record<string, unknown> };
      const id = created.created.id as string;
      const stored = (await callToolParsed("get_job", { id })) as Record<string, unknown>;

      for (const [key, value] of Object.entries(sent)) {
        expect(stored[key], `create_job dropped "${key}"`).toEqual(value);
      }

      await callToolParsed("delete_job", { id });
    });

    it("create_job applies the same safety defaults as the REST route", async () => {
      const created = (await callToolParsed("create_job", {
        name: "bare-minimum",
        schedules: [{ type: "simple", frequency: "daily", time: "09:00" }],
        prompt: "Do a thing.",
      })) as { created: Record<string, unknown> };

      // An unbounded job is the dangerous default; the others just match the UI.
      expect(created.created.maxDurationMinutes).toBe(30);
      expect(created.created.retentionDays).toBe(90);
      expect(created.created.bypassPermissions).toBe(false);
      expect(created.created.inboxOutput).toBe(false);
      expect(created.created.skipIfMissed).toBe(false);
      expect(created.created.enabled).toBe(true);

      await callToolParsed("delete_job", { id: created.created.id as string });
    });

    it("create_job refuses to make a job with no name, schedule or prompt", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        params: { name: "create_job", arguments: { cwd: "/tmp" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed.error).toContain("Missing required field");
      expect(parsed.error).toContain("name");
      expect(parsed.error).toContain("schedules");
      expect(parsed.error).toContain("prompt");
    });

    it("update_job discards fields outside its schema", async () => {
      const jobs = (await callToolParsed("list_jobs")) as { id: string; name: string }[];
      const job = jobs.find((j) => j.name === "updated-job")!;
      const result = (await callToolParsed("update_job", {
        id: job.id,
        prompt: "kept",
        // Both have been seen invented by the agent alongside the real fields.
        // A wholesale spread of args wrote them onto the job.
        schedule: JSON.stringify({ type: "simple", frequency: "weekly" }),
        cron: "0 7 * * 5",
      })) as { after: Record<string, unknown> };
      expect(result.after.prompt).toBe("kept");
      expect(result.after).not.toHaveProperty("schedule");
      expect(result.after).not.toHaveProperty("cron");
      expect(result.after.id).toBe(job.id);

      // normalizeJob strips a legacy singular `schedule` on read, so `schedule`
      // alone cannot tell a dropped write from a masked one. `cron` is not a
      // field it knows about, so its absence after a reload proves the write
      // path discarded it.
      const reloaded = (await callToolParsed("get_job", { id: job.id })) as Record<string, unknown>;
      expect(reloaded).not.toHaveProperty("cron");
      expect(reloaded.prompt).toBe("kept");
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
        schedules: [{ type: "simple", frequency: "hourly" }],
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
        schedules: [{ type: "simple", frequency: "hourly" }],
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
        schedules: [{ type: "simple", frequency: "hourly" }],
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };
      const b = (await callToolParsed("create_job", {
        name: "batch-run-b",
        schedules: [{ type: "simple", frequency: "hourly" }],
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
        schedules: [{ type: "simple", frequency: "hourly" }],
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };
      const b = (await callToolParsed("create_job", {
        name: "batch-del-b",
        schedules: [{ type: "simple", frequency: "hourly" }],
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
        schedules: [{ type: "simple", frequency: "hourly" }],
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };
      const b = (await callToolParsed("create_job", {
        name: "batch-upd-b",
        schedules: [{ type: "simple", frequency: "hourly" }],
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

    it("update_job batch discards fields outside its schema", async () => {
      const a = (await callToolParsed("create_job", {
        name: "batch-strip-a",
        schedules: [{ type: "simple", frequency: "hourly" }],
        prompt: "echo a",
        cwd: "/tmp",
      })) as { created: { id: string } };

      const result = (await callToolParsed("update_job", {
        updates: [{ id: a.created.id, name: "batch-strip-renamed", cron: "0 7 * * 5", schedule: "{}" }],
      })) as { results: { after?: Record<string, unknown> }[] };
      const after = result.results[0].after as Record<string, unknown>;
      expect(after.name).toBe("batch-strip-renamed");
      expect(after).not.toHaveProperty("cron");
      expect(after).not.toHaveProperty("schedule");

      const reloaded = (await callToolParsed("get_job", { id: a.created.id })) as Record<string, unknown>;
      expect(reloaded).not.toHaveProperty("cron");
    });
  });

  describe("scheduled-job confinement", () => {
    const RUN_TOKEN = "run-token-for-job-xyz";

    beforeAll(() => {
      registerRunContext(RUN_TOKEN, { jobId: "job-xyz", jobName: "Tech roundup", runId: "run-1" });
    });

    async function asJob(name: string, args: Record<string, unknown> = {}) {
      const res = await mcpPost({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, RUN_TOKEN);
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      return JSON.parse(text);
    }

    it("shows a job its scoped tools (add_inbox_message, list_notify_targets), and hides them from everyone else", async () => {
      const jobList = await mcpPost({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }, RUN_TOKEN);
      const jobTools = ((jobList.body as { result?: { tools: { name: string }[] } })?.result?.tools ?? []).map((t) => t.name);
      expect(jobTools).toEqual(["add_inbox_message", "list_notify_targets"]);

      const adminList = await mcpPost({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
      const adminTools = ((adminList.body as { result?: { tools: { name: string }[] } })?.result?.tools ?? []).map((t) => t.name);
      expect(adminTools).toContain("delete_job");
      expect(adminTools).not.toContain("add_inbox_message");
      expect(adminTools).not.toContain("list_notify_targets");
    });

    it("refuses a config tool even though the job named it directly", async () => {
      // The filtered list is not the boundary: a model can name a tool it was
      // never shown, so the call itself has to be refused too, through the
      // same scope map (TOOL_SCOPES) that filtered tools/list.
      for (const tool of ["delete_job", "list_providers", "update_settings", "get_job_transcript"]) {
        const out = await asJob(tool, { id: "job-xyz" });
        expect(out.error).toContain("only available to: assistant");
      }
      expect(vi.mocked(getJobScheduler)).not.toHaveBeenCalled();
    });

    it("delivers a message attributed to the job that called it", async () => {
      const out = await asJob("add_inbox_message", { title: "Roundup", body: "# Findings\n\nLots of them.", priority: "warning" });
      expect(out.delivered).toBe(true);
      expect(typeof out.id).toBe("string");
      // No provider configured for this run and no explicit notifyProviders,
      // so nothing is attempted — but the response shape still reports it,
      // which is the whole point of 1.6 (report what was actually sent).
      expect(out.notified).toEqual([]);
      expect(out.skipped).toBeUndefined();

      const delivered = getInboxMessages().find((m) => m.title === "Roundup");
      expect(delivered?.jobId).toBe("job-xyz");
      expect(delivered?.jobName).toBe("Tech roundup");
      expect(delivered?.runId).toBe("run-1");
      expect(delivered?.sessionId).toBeUndefined();
    });

    it("returns a readable error the model can retry on, rather than dropping the report", async () => {
      const out = await asJob("add_inbox_message", { title: "  ", body: "text" });
      expect(out.error).toContain("title and body");
    });

    it("refuses the inbox tool (and list_notify_targets) when the caller is the assistant, not a job or session", async () => {
      for (const name of ["add_inbox_message", "list_notify_targets"]) {
        const res = await mcpPost({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name, arguments: { title: "t", body: "b" } },
        });
        const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
        expect(JSON.parse(text).error).toBe(`${name} is only available to: job, session`);
      }
    });
  });

  describe("session confinement", () => {
    const SESSION_TOKEN = "session-token-for-my-session";
    const SESSION_ID = "session-abc-123";
    const SESSION_NAME = "My Working Session";

    beforeAll(() => {
      registerSessionContext(SESSION_TOKEN, SESSION_ID, SESSION_NAME);
    });

    // dispatchNotification fires a real (fire-and-forget, uncounted) fetch to
    // 127.0.0.1:1 for any enabled provider below, which fails fast (nothing
    // listens there) without being awaited — deliberately not stubbed, because
    // globalThis.fetch is also what mcpPost uses to reach the MCP server under
    // test, so mocking it here would intercept the test's own HTTP calls, not
    // just dispatchNotification's. The "notified"/"skipped" outcome the tool
    // reports is computed synchronously before that fetch even starts, so it
    // is unaffected either way.

    async function asSession(name: string, args: Record<string, unknown> = {}) {
      const res = await mcpPost({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name, arguments: args } }, SESSION_TOKEN);
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      return JSON.parse(text);
    }

    it("shows a session the same scoped tools as a job, and hides everything else", async () => {
      const sessionList = await mcpPost({ jsonrpc: "2.0", id: 22, method: "tools/list", params: {} }, SESSION_TOKEN);
      const sessionTools = ((sessionList.body as { result?: { tools: { name: string }[] } })?.result?.tools ?? []).map((t) => t.name);
      expect(sessionTools).toEqual(["add_inbox_message", "list_notify_targets"]);
    });

    it("refuses delete_job, list_providers and update_settings, both by absence and by call", async () => {
      const list = await mcpPost({ jsonrpc: "2.0", id: 23, method: "tools/list", params: {} }, SESSION_TOKEN);
      const names = ((list.body as { result?: { tools: { name: string }[] } })?.result?.tools ?? []).map((t) => t.name);
      for (const tool of ["delete_job", "list_providers", "update_settings"]) {
        expect(names).not.toContain(tool);
        const out = await asSession(tool, { id: "whatever" });
        expect(out.error).toBe(`${tool} is only available to: assistant`);
      }
      expect(vi.mocked(getJobScheduler)).not.toHaveBeenCalled();
    });

    it("delivers a message attributed to the session, not a job", async () => {
      const out = await asSession("add_inbox_message", { title: "Session report", body: "Body text" });
      expect(out.delivered).toBe(true);

      const delivered = getInboxMessages().find((m) => m.title === "Session report");
      expect(delivered?.sessionId).toBe(SESSION_ID);
      expect(delivered?.sessionName).toBe(SESSION_NAME);
      expect(delivered?.jobId).toBeUndefined();
      expect(delivered?.jobName).toBeUndefined();
    });

    it("with no notifyProviders, nothing is pushed even though a live provider is configured", async () => {
      setNotificationSettings({
        providers: [
          { id: "quiet-1", type: "ntfy", name: "Quiet Ntfy", enabled: true, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } },
        ],
      });
      const out = await asSession("add_inbox_message", { title: "Quiet report", body: "b" });
      expect(out.notified).toEqual([]);
      expect(out.skipped).toBeUndefined();
    });

    it("with notifyProviders naming a live provider, the result reports it in notified", async () => {
      setNotificationSettings({
        providers: [
          { id: "live-1", type: "ntfy", name: "Live Ntfy", enabled: true, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } },
        ],
      });
      const out = await asSession("add_inbox_message", { title: "Live report", body: "b", notifyProviders: ["live-1"] });
      expect(out.notified).toEqual(["Live Ntfy"]);
      expect(out.skipped).toBeUndefined();
    });

    it("with a disabled provider named, notified is empty and skipped explains why", async () => {
      setNotificationSettings({
        providers: [
          { id: "dead-1", type: "ntfy", name: "Dead Ntfy", enabled: false, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } },
        ],
      });
      const out = await asSession("add_inbox_message", { title: "Dead report", body: "b", notifyProviders: ["dead-1"] });
      expect(out.notified).toEqual([]);
      expect(out.skipped).toEqual(["Dead Ntfy: disabled"]);
    });

    it("with an unknown provider id named, skipped reports it as unknown", async () => {
      setNotificationSettings({ providers: [] });
      const out = await asSession("add_inbox_message", { title: "Unknown-target report", body: "b", notifyProviders: ["no-such-id"] });
      expect(out.notified).toEqual([]);
      expect(out.skipped).toEqual(["no-such-id: unknown"]);
    });

    it("list_notify_targets returns only id/name/type/enabled, not filter or credentials", async () => {
      setNotificationSettings({
        providers: [
          {
            id: "target-1",
            type: "telegram",
            name: "Telegram (personal)",
            enabled: true,
            config: { botToken: "secret-token", chatId: "12345" },
            filter: { priorities: ["error"] },
          },
        ],
      });
      const targets = (await asSession("list_notify_targets")) as Record<string, unknown>[];
      expect(targets).toEqual([{ id: "target-1", name: "Telegram (personal)", type: "telegram", enabled: true }]);
      const serialised = JSON.stringify(targets);
      expect(serialised).not.toContain("secret-token");
      expect(serialised).not.toContain("chatId");
      expect(serialised).not.toContain("filter");
    });
  });

  describe("session push rate limit", () => {
    const RATE_TOKEN = "session-token-for-rate-limit";
    const RATE_SESSION_ID = "session-rate-limit-1";

    beforeAll(() => {
      registerSessionContext(RATE_TOKEN, RATE_SESSION_ID, "Rate Limited Session");
      setNotificationSettings({
        providers: [{ id: "rl-1", type: "ntfy", name: "RL Ntfy", enabled: true, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } }],
      });
    });

    // See the comment in "session confinement" above: fetch is deliberately
    // left unmocked here too, for the same reason (mcpPost needs the real one).

    async function pushAsRateLimitedSession(title: string): Promise<{ body: Record<string, unknown>; isError: boolean }> {
      const res = await mcpPost(
        {
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: { name: "add_inbox_message", arguments: { title, body: "b", notifyProviders: ["rl-1"] } },
        },
        RATE_TOKEN,
      );
      const result = (res.body as { result?: { content: { text: string }[]; isError?: boolean } })?.result;
      return { body: JSON.parse(result?.content?.[0]?.text ?? "{}"), isError: result?.isError ?? false };
    }

    it("allows 10 pushes per hour, then refuses the 11th while still saving to the inbox", async () => {
      for (let i = 0; i < 10; i++) {
        const { body, isError } = await pushAsRateLimitedSession(`Push ${i}`);
        expect(isError).toBe(false);
        expect(body.notified).toEqual(["RL Ntfy"]);
      }

      const { body, isError } = await pushAsRateLimitedSession("Push 10 (over the cap)");
      expect(isError).toBe(true);
      expect(body.error).toContain("capped at 10 per hour");
      expect(body.delivered).toBe(true);
      expect(typeof body.id).toBe("string");

      // The inbox write is not rate limited — the 11th report still landed.
      const delivered = getInboxMessages().find((m) => m.title === "Push 10 (over the cap)");
      expect(delivered).toBeTruthy();
      expect(delivered?.sessionId).toBe(RATE_SESSION_ID);
    });
  });

  describe("get_job_transcript", () => {
    const CWD = "/tmp";

    function writeTranscript(sessionId: string, lines: Record<string, unknown>[]): void {
      // Mirrors getTranscriptPath: the project key is the cwd with / and . replaced by -.
      const dir = join(process.env.CLAUDE_CONFIG_DIR as string, "projects", CWD.replace(/[/.]/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    }

    async function jobWithRun(name: string, sessionId: string, status: string): Promise<string> {
      const created = (await callToolParsed("create_job", {
        name,
        schedules: [{ type: "simple", frequency: "hourly" }],
        prompt: "find things to do",
        cwd: CWD,
      })) as { created: { id: string } };
      saveRun({
        id: `run-${sessionId}`,
        jobId: created.created.id,
        sessionId,
        status: status as "running" | "success",
        startedAt: Date.now(),
        toolsUsed: [],
        messageCount: 2,
        prompt: "find things to do",
        cwd: CWD,
      });
      return created.created.id;
    }

    it("returns the latest run's transcript, including while the run is still going", async () => {
      const sessionId = "sess-live-1";
      writeTranscript(sessionId, [
        { type: "user", message: { id: "u1", content: "find things to do" }, timestamp: "2026-07-25T09:00:00Z", cwd: CWD },
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "text", text: "found three farms" }] },
          timestamp: "2026-07-25T09:00:05Z",
          cwd: CWD,
        },
      ]);
      const jobId = await jobWithRun("transcript-live", sessionId, "running");

      const result = (await callToolParsed("get_job_transcript", { id: jobId })) as {
        job: string;
        status: string;
        totalMessages: number;
        messages: { role: string; text: string }[];
      };
      expect(result.job).toBe("transcript-live");
      // A run is persisted as "running" before it finishes, which is what makes
      // this readable mid-flight rather than only after completion.
      expect(result.status).toBe("running");
      expect(result.totalMessages).toBe(2);
      expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(result.messages[1].text).toContain("found three farms");
    });

    it("honours tailMessages and reports how many it held back", async () => {
      const sessionId = "sess-tail-1";
      writeTranscript(
        sessionId,
        Array.from({ length: 5 }, (_, i) => ({
          type: "user",
          message: { id: `u${i}`, content: `message ${i}` },
          timestamp: `2026-07-25T09:0${i}:00Z`,
          cwd: CWD,
        })),
      );
      const jobId = await jobWithRun("transcript-tail", sessionId, "success");

      const result = (await callToolParsed("get_job_transcript", { id: jobId, tailMessages: 2 })) as {
        totalMessages: number;
        returnedMessages: number;
        messages: { text: string }[];
      };
      expect(result.totalMessages).toBe(5);
      expect(result.returnedMessages).toBe(2);
      expect(result.messages[1].text).toContain("message 4");
    });

    it("errors for an unknown job", async () => {
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_job_transcript", arguments: { id: "nonexistent" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("not found");
    });

    it("errors when the job has never run", async () => {
      const created = (await callToolParsed("create_job", {
        name: "never-run",
        schedules: [{ type: "simple", frequency: "hourly" }],
        prompt: "idle",
        cwd: CWD,
      })) as { created: { id: string } };
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_job_transcript", arguments: { id: created.created.id } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("No runs recorded");
    });

    it("errors for a run id that does not belong to the job", async () => {
      const jobId = await jobWithRun("transcript-badrun", "sess-badrun-1", "success");
      const res = await mcpPost({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "get_job_transcript", arguments: { id: jobId, runId: "run-does-not-exist" } },
      });
      const text = (res.body as { result?: { content: { text: string }[] } })?.result?.content?.[0]?.text ?? "";
      expect(JSON.parse(text).error).toContain("Run not found");
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

    it("never returns a stored secret to the caller", async () => {
      const created = (await callToolParsed("add_provider", {
        name: "secret-provider",
        envVars: { OPENROUTER_API_KEY: "sk-or-v1-realsecret", ANTHROPIC_BASE_URL: "https://example.test", ANTHROPIC_API_KEY: "" },
      })) as { created: { id: string; envVars: Record<string, string> } };

      // The key is masked, the non-secret URL is not, and a deliberately empty
      // value stays empty so the assistant can still tell configured from not.
      expect(created.created.envVars.OPENROUTER_API_KEY).toBe("<redacted>");
      expect(created.created.envVars.ANTHROPIC_BASE_URL).toBe("https://example.test");
      expect(created.created.envVars.ANTHROPIC_API_KEY).toBe("");

      const listed = (await callToolParsed("list_providers")) as { name: string; envVars: Record<string, string> }[];
      const found = listed.find((p) => p.name === "secret-provider")!;
      expect(found.envVars.OPENROUTER_API_KEY).toBe("<redacted>");
      expect(JSON.stringify(listed)).not.toContain("sk-or-v1-realsecret");

      await callToolParsed("delete_provider", { id: created.created.id });
    });

    it("does not overwrite a real secret when the caller echoes the placeholder back", async () => {
      const created = (await callToolParsed("add_provider", {
        name: "roundtrip-provider",
        envVars: { OPENROUTER_API_KEY: "sk-or-v1-keepme" },
      })) as { created: { id: string } };
      const id = created.created.id;

      // Exactly what an assistant does after reading: echo the shape back with
      // one field changed. The masked key must survive.
      const updated = (await callToolParsed("update_provider", {
        id,
        name: "roundtrip-renamed",
        envVars: { OPENROUTER_API_KEY: "<redacted>", EXTRA: "added" },
      })) as { after: { name: string; envVars: Record<string, string> } };

      expect(updated.after.name).toBe("roundtrip-renamed");
      expect(updated.after.envVars.OPENROUTER_API_KEY).toBe("<redacted>");
      expect(updated.after.envVars.EXTRA).toBe("added");

      // Read the raw store, since every tool response is redacted by design.
      const stored = JSON.parse(readFileSync(join(process.env.COCKPIT_CONFIG_DIR as string, "providers.json"), "utf-8"));
      const raw = (Array.isArray(stored) ? stored : (stored.providers ?? [])).find((p: { id: string }) => p.id === id);
      expect(raw.envVars.OPENROUTER_API_KEY).toBe("sk-or-v1-keepme");

      await callToolParsed("delete_provider", { id });
    });

    it("masks an mcp server's env values too", async () => {
      await callToolParsed("save_mcp_server", {
        name: "secret-mcp",
        command: "node",
        args: ["server.js"],
        env: { GITHUB_TOKEN: "ghp_realtoken", LOG_LEVEL: "debug" },
      });
      const got = (await callToolParsed("get_mcp_server", { name: "secret-mcp" })) as { env: Record<string, string> };
      expect(got.env.GITHUB_TOKEN).toBe("<redacted>");
      expect(got.env.LOG_LEVEL).toBe("debug");

      // And the placeholder round trip leaves the stored token intact.
      await callToolParsed("save_mcp_server", {
        name: "secret-mcp",
        command: "node",
        args: ["server.js", "--verbose"],
        env: { GITHUB_TOKEN: "<redacted>", LOG_LEVEL: "info" },
      });
      const config = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR as string, ".claude.json"), "utf-8"));
      expect(config.mcpServers["secret-mcp"].env.GITHUB_TOKEN).toBe("ghp_realtoken");
      expect(config.mcpServers["secret-mcp"].env.LOG_LEVEL).toBe("info");

      await callToolParsed("delete_mcp_server", { name: "secret-mcp" });
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
