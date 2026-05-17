import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/job-lock", () => ({
  acquireJobLock: vi.fn(() => true),
  releaseJobLock: vi.fn(),
  clearStaleLocks: vi.fn(),
}));

vi.mock("@/server/job-storage", () => ({
  loadJobs: vi.fn(() => []),
  getJob: vi.fn(),
  saveRun: vi.fn(),
  loadRuns: vi.fn(() => []),
  getLatestRun: vi.fn(() => undefined),
  pruneAllRuns: vi.fn(),
}));

vi.mock("@/server/transcript", () => ({
  countTranscriptMessages: vi.fn(() => 0),
  transcriptExists: vi.fn(() => false),
}));

vi.mock("@/server/inbox", () => ({
  addInboxMessage: vi.fn(),
  parseInboxBlock: vi.fn(() => null),
  parseErrorBlock: vi.fn(() => null),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, mkdirSync: vi.fn() };
});

import { addInboxMessage, parseErrorBlock, parseInboxBlock } from "@/server/inbox";
import { acquireJobLock, releaseJobLock } from "@/server/job-lock";
import { JobScheduler } from "@/server/job-scheduler";
import { loadJobs, loadRuns, saveRun } from "@/server/job-storage";
import type { JobRunStatus, ScheduledJob } from "@/types";

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: "job-1",
    name: "Test Job",
    schedule: { type: "simple", frequency: "daily", time: "09:00" },
    prompt: "Do something",
    cwd: "/tmp/test",
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeMockSessionManager() {
  const emitter = new EventEmitter();
  let statusCb: ((status: string) => void) | null = null;
  let errorCb: ((error: string) => void) | null = null;
  let eventCb: ((event: Record<string, unknown>) => void) | null = null;
  let initCb: ((data: Record<string, unknown>) => void) | null = null;

  return {
    emitter,
    createSession: vi.fn(() => ({ id: "session-1" })),
    destroySession: vi.fn(),
    sendMessage: vi.fn((_id: string, _text: string) => true),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    respondToPermission: vi.fn(),
    mcpToggle: vi.fn(() => Promise.resolve()),
    hasRunningProcess: vi.fn(() => true),
    subscribe: vi.fn((_id: string, cb: (event: Record<string, unknown>) => void) => {
      eventCb = cb;
      return () => {
        eventCb = null;
      };
    }),
    onStatus: vi.fn((_id: string, cb: (status: string) => void) => {
      statusCb = cb;
      return () => {
        statusCb = null;
      };
    }),
    onError: vi.fn((_id: string, cb: (error: string) => void) => {
      errorCb = cb;
      return () => {
        errorCb = null;
      };
    }),
    onInit: vi.fn((_id: string, cb: (data: Record<string, unknown>) => void) => {
      initCb = cb;
      return () => {
        initCb = null;
      };
    }),
    emitStatus: (status: string) => statusCb?.(status),
    emitError: (error: string) => errorCb?.(error),
    emitEvent: (event: Record<string, unknown>) => eventCb?.(event),
    emitInit: (data: Record<string, unknown>) => initCb?.(data),
  };
}

describe("JobScheduler", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  describe("executeJob", () => {
    it("creates session, sends prompt, and resolves on idle status", async () => {
      const job = makeJob();
      const promise = scheduler.executeJob(job);

      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
      sm.emitStatus("idle");

      const run = await promise;
      expect(run.status).toBe("success");
      expect(run.jobId).toBe("job-1");
      expect(run.sessionId).toBe("session-1");
      expect(run.completedAt).toBeDefined();
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(saveRun)).toHaveBeenCalled();
      expect(vi.mocked(releaseJobLock)).toHaveBeenCalledWith("job-1");
    });

    it("sets model and thinking level when job specifies them", async () => {
      const job = makeJob({ model: "opus", thinkingLevel: "high" });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
      sm.emitStatus("idle");
      await promise;

      expect(sm.setModel).toHaveBeenCalledWith("session-1", "opus");
      expect(sm.setThinkingLevel).toHaveBeenCalledWith("session-1", "high");
    });

    it("marks run as failure on error", async () => {
      const job = makeJob();
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
      sm.emitError("CLI crashed");

      const run = await promise;
      expect(run.status).toBe("failure");
      expect(run.error).toBe("CLI crashed");
      expect(vi.mocked(addInboxMessage)).toHaveBeenCalled();
    });

    it("marks run as timeout when max duration exceeded", async () => {
      const job = makeJob({ maxDurationMinutes: 0.001 });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      const run = await promise;
      expect(run.status).toBe("timeout");
      expect(run.error).toContain("Exceeded max duration");
      expect(sm.destroySession).toHaveBeenCalledWith("session-1");
    });

    it("throws when lock cannot be acquired", async () => {
      vi.mocked(acquireJobLock).mockReturnValueOnce(false);
      await expect(scheduler.executeJob(makeJob())).rejects.toThrow("Could not acquire job lock");
    });

    it("detects cockpit-error in final assistant text", async () => {
      const job = makeJob();
      vi.mocked(parseErrorBlock).mockReturnValueOnce({ error: "Tool failed", details: "No permission" });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.emitEvent({
        type: "message_done",
        message: { content: "```cockpit-error\n{}\n```", blocks: [] },
      });
      sm.emitStatus("idle");

      const run = await promise;
      expect(run.status).toBe("failure");
      expect(run.error).toBe("Tool failed: No permission");
    });

    it("tracks tool use and results", async () => {
      const job = makeJob();
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.emitEvent({ type: "tool_use_start", toolId: "t1", toolName: "Bash", toolInput: "ls" });
      sm.emitEvent({ type: "tool_result", toolId: "t1", toolOutput: "file.txt" });
      sm.emitStatus("idle");

      const run = await promise;
      expect(run.toolsUsed).toHaveLength(1);
      expect(run.toolsUsed[0].name).toBe("Bash");
      expect(run.toolsUsed[0].output).toBe("file.txt");
    });

    it("increments messageCount on message_done", async () => {
      const job = makeJob();
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.emitEvent({ type: "message_done", message: { content: "First" } });
      sm.emitEvent({ type: "message_done", message: { content: "Second" } });
      sm.emitStatus("idle");

      const run = await promise;
      expect(run.messageCount).toBeGreaterThanOrEqual(2);
    });

    it("auto-approves permissions when bypassPermissions is true", async () => {
      const job = makeJob({ bypassPermissions: true });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.emitEvent({
        type: "permission_request",
        requestId: "perm-1",
        toolName: "Bash",
        toolInput: JSON.stringify({ command: "rm -rf /" }),
        rawToolInput: { command: "rm -rf /" },
      });
      sm.emitStatus("idle");

      await promise;
      expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "perm-1", true, { command: "rm -rf /" });
    });

    it("checks allowedTools for permission requests when not bypassing", async () => {
      const job = makeJob({ allowedTools: ["Read", "Bash ls"], bypassPermissions: false });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.emitEvent({
        type: "permission_request",
        requestId: "perm-read",
        toolName: "Read",
        toolInput: "",
        rawToolInput: {},
      });
      sm.emitEvent({
        type: "permission_request",
        requestId: "perm-write",
        toolName: "Write",
        toolInput: "",
        rawToolInput: {},
      });
      sm.emitStatus("idle");

      await promise;
      expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "perm-read", true, {});
      expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "perm-write", false, undefined);
    });

    it("creates session with bypass when bypassPermissions is true", async () => {
      const job = makeJob({ bypassPermissions: true });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
      sm.emitStatus("idle");
      await promise;

      expect(sm.createSession).toHaveBeenCalledWith(expect.any(String), "[job] Test Job", { bypassPermissions: true });
    });

    it("disables MCP servers not in the job's allowed list", async () => {
      const job = makeJob({ mcpServers: ["allowed-server"] });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.emitInit({ mcpServers: [{ name: "allowed-server" }, { name: "blocked-server" }] });
      sm.emitStatus("idle");

      await promise;
      expect(sm.mcpToggle).toHaveBeenCalledWith("session-1", "blocked-server", false);
      expect(sm.mcpToggle).not.toHaveBeenCalledWith("session-1", "allowed-server", false);
    });

    it("sends inbox error message on failure", async () => {
      const job = makeJob({ name: "Failing Job" });
      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
      sm.emitError("something broke");

      await promise;
      expect(vi.mocked(addInboxMessage)).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Job failed: Failing Job",
          priority: "error",
        }),
      );
    });
  });

  describe("triggerJob", () => {
    it("throws when job not found", async () => {
      vi.mocked(loadJobs).mockReturnValueOnce([]);
      await expect(scheduler.triggerJob("nonexistent")).rejects.toThrow("Job not found");
    });

    it("executes found job", async () => {
      const job = makeJob();
      vi.mocked(loadJobs).mockReturnValueOnce([job]);
      const promise = scheduler.triggerJob("job-1");
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
      sm.emitStatus("idle");
      const run = await promise;
      expect(run.status).toBe("success");
    });
  });

  describe("start and stop", () => {
    it("starts ticking and can be stopped", () => {
      scheduler.start();
      expect(scheduler.getRunningJobs().size).toBe(0);
      scheduler.stop();
    });
  });

  describe("tick: detects dead job sessions", () => {
    it("marks running job as failure when process is gone", async () => {
      const job = makeJob();
      vi.mocked(loadJobs).mockReturnValue([job]);
      sm.hasRunningProcess.mockReturnValue(true);

      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      expect(scheduler.getRunningJobs().size).toBe(1);

      sm.hasRunningProcess.mockReturnValue(false);
      (scheduler as any).tick();

      expect(scheduler.getRunningJobs().size).toBe(0);
      const savedCalls = vi.mocked(saveRun).mock.calls;
      const lastSaved = savedCalls[savedCalls.length - 1][0];
      expect(lastSaved.status).toBe("failure");
      expect(lastSaved.error).toContain("exited unexpectedly");

      sm.emitStatus("idle");
      await promise;
    });
  });

  describe("tick: fires scheduled jobs", () => {
    it("fires an enabled job whose cron matches now", () => {
      const now = new Date();
      now.setSeconds(0, 0);
      const minute = now.getMinutes();
      const hour = now.getHours();

      const job = makeJob({
        schedule: { type: "cron", expression: `${minute} ${hour} * * *` },
      });
      vi.mocked(loadJobs).mockReturnValue([job]);

      (scheduler as any).tick();

      expect(sm.createSession).toHaveBeenCalled();
    });

    it("skips disabled jobs", () => {
      const now = new Date();
      now.setSeconds(0, 0);
      const job = makeJob({
        enabled: false,
        schedule: { type: "cron", expression: `${now.getMinutes()} ${now.getHours()} * * *` },
      });
      vi.mocked(loadJobs).mockReturnValue([job]);

      (scheduler as any).tick();

      expect(sm.createSession).not.toHaveBeenCalled();
    });

    it("skips jobs that are already running", async () => {
      const now = new Date();
      now.setSeconds(0, 0);
      const job = makeJob({
        schedule: { type: "cron", expression: `${now.getMinutes()} ${now.getHours()} * * *` },
      });
      vi.mocked(loadJobs).mockReturnValue([job]);

      const promise = scheduler.executeJob(job);
      await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

      sm.createSession.mockClear();
      (scheduler as any).tick();

      expect(sm.createSession).not.toHaveBeenCalled();

      sm.emitStatus("idle");
      await promise;
    });
  });

  describe("recoverState", () => {
    it("marks stale running runs as failure on startup", () => {
      const staleRun = {
        id: "run-stale",
        jobId: "job-1",
        sessionId: "s1",
        status: "running" as JobRunStatus,
        startedAt: Date.now() - 3600000,
        toolsUsed: [],
        messageCount: 0,
        prompt: "do stuff",
        cwd: "/tmp",
      };
      vi.mocked(loadJobs).mockReturnValue([makeJob()]);
      vi.mocked(loadRuns).mockReturnValue([staleRun]);

      (scheduler as any).recoverState();

      expect(vi.mocked(saveRun)).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "run-stale",
          status: "failure",
          error: "Server restarted while job was running",
        }),
      );
    });
  });
});

describe("isToolAllowed (via permission flow)", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("allows exact tool name match", async () => {
    const job = makeJob({ allowedTools: ["Read"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({ type: "permission_request", requestId: "p1", toolName: "Read", toolInput: "", rawToolInput: {} });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, {});
  });

  it("allows Bash with matching command prefix", async () => {
    const job = makeJob({ allowedTools: ["Bash git"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "git status" }),
      rawToolInput: { command: "git status" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, { command: "git status" });
  });

  it("denies Bash with shell operators even when command prefix matches", async () => {
    const job = makeJob({ allowedTools: ["Bash ls"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "ls && rm -rf /" }),
      rawToolInput: { command: "ls && rm -rf /" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });

  it("denies unlisted tools", async () => {
    const job = makeJob({ allowedTools: ["Read"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({ type: "permission_request", requestId: "p1", toolName: "Write", toolInput: "", rawToolInput: {} });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });
});

describe("message_done text extraction fallback to blocks", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("extracts text from blocks when content is empty", async () => {
    const job = makeJob();
    vi.mocked(parseErrorBlock).mockReturnValueOnce({ error: "Found in blocks" });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "message_done",
      message: {
        content: "",
        blocks: [
          { type: "text", text: "line one" },
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "line two" },
        ],
      },
    });
    sm.emitStatus("idle");

    const run = await promise;
    expect(run.status).toBe("failure");
    expect(run.error).toBe("Found in blocks");
  });

  it("uses content when both content and blocks are present", async () => {
    const job = makeJob();
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "message_done",
      message: { content: "direct content", blocks: [{ type: "text", text: "block text" }] },
    });
    sm.emitStatus("idle");

    const run = await promise;
    expect(run.status).toBe("success");
  });
});

describe("job prompt construction", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("includes allowed tools in prompt when not bypassing", async () => {
    const job = makeJob({
      allowedTools: ["Read", "Bash git"],
      mcpServers: ["my-mcp"],
      bypassPermissions: false,
    });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
    sm.emitStatus("idle");
    await promise;

    const prompt = sm.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("Allowed tools: Read, Bash git");
    expect(prompt).toContain("Allowed MCP servers: my-mcp");
  });

  it("includes bypass message when bypassPermissions is true", async () => {
    const job = makeJob({ bypassPermissions: true });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
    sm.emitStatus("idle");
    await promise;

    const prompt = sm.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("All tools and MCP servers are available");
  });

  it("includes no-tools message when allowedTools and mcpServers are empty", async () => {
    const job = makeJob({ allowedTools: [], mcpServers: [], bypassPermissions: false });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
    sm.emitStatus("idle");
    await promise;

    const prompt = sm.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("No tools or MCP servers are allowed");
  });

  it("includes inbox output instructions when inboxOutput is true", async () => {
    const job = makeJob({ inboxOutput: true });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
    sm.emitStatus("idle");
    await promise;

    const prompt = sm.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("cockpit-inbox");
  });

  it("includes storage dir when cwd is set", async () => {
    const job = makeJob({ cwd: "/my/project" });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());
    sm.emitStatus("idle");
    await promise;

    const prompt = sm.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("Storage:");
    expect(prompt).toContain(job.id);
  });
});

describe("Bash tool restriction edge cases", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("allows exact Bash command match", async () => {
    const job = makeJob({ allowedTools: ["Bash ls"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "ls" }),
      rawToolInput: { command: "ls" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, { command: "ls" });
  });

  it("falls back to raw toolInput when JSON parse fails", async () => {
    const job = makeJob({ allowedTools: ["Bash ls"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: "ls -la",
      rawToolInput: { command: "ls -la" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, { command: "ls -la" });
  });

  it("denies Bash with pipe operator", async () => {
    const job = makeJob({ allowedTools: ["Bash cat"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "cat /etc/passwd > /tmp/out" }),
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });

  it("denies Bash with background operator", async () => {
    const job = makeJob({ allowedTools: ["Bash sleep"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "sleep 999 &" }),
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });

  it("denies Bash when command does not match restriction prefix", async () => {
    const job = makeJob({ allowedTools: ["Bash git"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Bash",
      toolInput: JSON.stringify({ command: "rm -rf /" }),
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });
});

describe("MCP tool permissions (via permission flow)", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("allows MCP tool when server is in mcpServers list", async () => {
    const job = makeJob({ mcpServers: ["my-server"], allowedTools: [] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__my_server__do_thing",
      toolInput: "{}",
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, {});
  });

  it("denies MCP tool when server is not in mcpServers list", async () => {
    const job = makeJob({ mcpServers: ["allowed-server"], allowedTools: [] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__blocked_server__do_thing",
      toolInput: "{}",
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });

  it("filters MCP tools by mcpToolFilters when provided", async () => {
    const job = makeJob({
      mcpServers: ["my-server"],
      mcpToolFilters: { "my-server": ["allowed_tool"] },
      allowedTools: [],
    });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__my_server__allowed_tool",
      toolInput: "{}",
      rawToolInput: {},
    });
    sm.emitEvent({
      type: "permission_request",
      requestId: "p2",
      toolName: "mcp__my_server__blocked_tool",
      toolInput: "{}",
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, {});
    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p2", false, undefined);
  });

  it("allows MCP tool via colon filter with server:tool match", async () => {
    const job = makeJob({
      mcpServers: ["conduit"],
      mcpToolFilters: { conduit: ["linear:list_issues"] },
      allowedTools: [],
    });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__conduit__call_tool",
      toolInput: JSON.stringify({ server: "linear", tool: "list_issues" }),
      rawToolInput: { server: "linear", tool: "list_issues" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, { server: "linear", tool: "list_issues" });
  });

  it("allows MCP tool via colon filter with server:* wildcard", async () => {
    const job = makeJob({
      mcpServers: ["conduit"],
      mcpToolFilters: { conduit: ["linear:*"] },
      allowedTools: [],
    });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__conduit__call_tool",
      toolInput: JSON.stringify({ server: "linear", tool: "anything" }),
      rawToolInput: { server: "linear", tool: "anything" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, { server: "linear", tool: "anything" });
  });

  it("denies MCP tool when colon filter server does not match", async () => {
    const job = makeJob({
      mcpServers: ["conduit"],
      mcpToolFilters: { conduit: ["linear:list_issues"] },
      allowedTools: [],
    });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__conduit__call_tool",
      toolInput: JSON.stringify({ server: "github", tool: "list_issues" }),
      rawToolInput: { server: "github", tool: "list_issues" },
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });

  it("skips colon filter when toolInput is invalid JSON", async () => {
    const job = makeJob({
      mcpServers: ["conduit"],
      mcpToolFilters: { conduit: ["linear:list_issues"] },
      allowedTools: [],
    });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__conduit__call_tool",
      toolInput: "not json",
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", false, undefined);
  });

  it("returns null for non-MCP tools", async () => {
    const job = makeJob({ mcpServers: ["my-server"], allowedTools: ["Read"] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "Read",
      toolInput: "",
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, {});
  });

  it("normalizes server names with special characters", async () => {
    const job = makeJob({ mcpServers: ["my-special.server"], allowedTools: [] });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "permission_request",
      requestId: "p1",
      toolName: "mcp__my_special_server__do_thing",
      toolInput: "{}",
      rawToolInput: {},
    });
    sm.emitStatus("idle");
    await promise;

    expect(sm.respondToPermission).toHaveBeenCalledWith("session-1", "p1", true, {});
  });
});

describe("inbox output on success", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("parses inbox block from final text when inboxOutput is enabled", async () => {
    const { parseInboxBlock } = await import("@/server/inbox");
    vi.mocked(parseInboxBlock).mockReturnValueOnce({ title: "Report", body: "Data here", priority: "info" });

    const job = makeJob({ inboxOutput: true });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({ type: "message_done", message: { content: "```cockpit-inbox\n{}\n```" } });
    sm.emitStatus("idle");

    await promise;
    expect(vi.mocked(addInboxMessage)).toHaveBeenCalledWith(expect.objectContaining({ title: "Report", body: "Data here" }));
  });

  it("does not send inbox when inboxOutput is false", async () => {
    const job = makeJob({ inboxOutput: false });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({ type: "message_done", message: { content: "some output" } });
    sm.emitStatus("idle");

    await promise;
    expect(vi.mocked(addInboxMessage)).not.toHaveBeenCalled();
  });
});

describe("inbox suppression on cockpit-error reclassification", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("does not send inbox output when job is reclassified as failure via cockpit-error", async () => {
    vi.mocked(parseErrorBlock).mockReturnValue({ error: "Task failed", details: "No access" });
    vi.mocked(parseInboxBlock).mockReturnValue({ title: "Report", body: "Stale data", priority: "info" });

    const job = makeJob({ inboxOutput: true });
    const promise = scheduler.executeJob(job);
    await vi.waitFor(() => expect(sm.sendMessage).toHaveBeenCalled());

    sm.emitEvent({
      type: "message_done",
      message: { content: "```cockpit-error\n{}\n```\n```cockpit-inbox\n{}\n```" },
    });
    sm.emitStatus("idle");

    const run = await promise;
    expect(run.status).toBe("failure");
    const inboxCalls = vi.mocked(addInboxMessage).mock.calls;
    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0][0]).toEqual(expect.objectContaining({ title: "Job failed: Test Job" }));
  });
});

describe("tick: missed run handling", () => {
  let sm: ReturnType<typeof makeMockSessionManager>;
  let scheduler: JobScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = makeMockSessionManager();
    scheduler = new JobScheduler(sm as any);
  });

  it("skips missed runs when skipIfMissed is true", () => {
    const pastHour = new Date();
    pastHour.setHours(pastHour.getHours() - 2);
    const cronMinute = pastHour.getMinutes();
    const cronHour = pastHour.getHours();

    const job = makeJob({
      skipIfMissed: true,
      schedule: { type: "cron", expression: `${cronMinute} ${cronHour} * * *` },
    });
    vi.mocked(loadJobs).mockReturnValue([job]);

    (scheduler as any).lastFiredAt.set(job.id, new Date(pastHour.getTime() - 7200000));
    (scheduler as any).tick();

    expect(sm.createSession).not.toHaveBeenCalled();
  });
});
