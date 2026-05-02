import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { JobRun, JobRunToolUse, ScheduledJob } from "@/types";
import { findMissedRun, getJobSchedules, matchesCron, scheduleToCron } from "./cron-utils";
import { getLatestRun, loadJobs, loadRuns, pruneAllRuns, saveRun } from "./job-storage";
import type { SessionManager } from "./session-manager";
import { countTranscriptMessages } from "./transcript";

const SCRATCHPAD_DIR = path.join(homedir(), ".cockpit", "jobs");

const JOB_PROMPT_HEADER = [
  "You are running as an autonomous scheduled job. There is no human operator in this session.",
  "Do not ask clarifying questions. Do not wait for user input. Make reasonable assumptions and proceed.",
  "Complete the task fully, then stop. If you cannot complete the task, explain why in your final message.",
].join("\n");

function buildJobPrompt(job: ScheduledJob): string {
  const parts = [JOB_PROMPT_HEADER, ""];

  if (job.bypassPermissions) {
    parts.push("Permissions: All tools and MCP servers are available.");
  } else {
    const tools = job.allowedTools || [];
    const servers = job.mcpServers || [];
    parts.push("Permissions: Only the tools and MCP servers listed below are allowed. Do not attempt to use any others.");
    if (tools.length > 0) parts.push(`Allowed tools: ${tools.join(", ")}`);
    if (servers.length > 0) parts.push(`Allowed MCP servers: ${servers.join(", ")}`);
    if (tools.length === 0 && servers.length === 0) parts.push("No tools or MCP servers are allowed.");
  }

  parts.push("", "Task:", job.prompt);
  return parts.join("\n");
}

const SHELL_OPERATORS = /(?:;|&&|\|\||>|<|`|\$\(|<\()/;
const BACKGROUND_AMPERSAND = /(?:^|[^|])&(?!&)/;

function hasShellOperators(cmd: string): boolean {
  return SHELL_OPERATORS.test(cmd) || BACKGROUND_AMPERSAND.test(cmd);
}

function parseToolRule(rule: string): { tool: string; restriction?: string } {
  const spaceIdx = rule.indexOf(" ");
  if (spaceIdx > 0) return { tool: rule.slice(0, spaceIdx), restriction: rule.slice(spaceIdx + 1) };
  return { tool: rule };
}

function isToolAllowed(toolName: string, toolInput: string, rules: string[]): boolean {
  for (const rule of rules) {
    const { tool, restriction } = parseToolRule(rule);
    if (tool !== toolName) continue;
    if (!restriction) return true;
    if (toolName === "Bash") {
      let cmd = "";
      try {
        cmd = (JSON.parse(toolInput) as { command?: string }).command || "";
      } catch {
        cmd = toolInput;
      }
      const trimmed = cmd.trim();
      if (hasShellOperators(trimmed)) continue;
      if (trimmed === restriction || trimmed.startsWith(`${restriction} `)) return true;
    }
  }
  return false;
}

function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

function isMcpToolAllowed(
  toolName: string,
  toolInput: string,
  enabledServers: Set<string>,
  mcpToolFilters?: Record<string, string[]>,
): boolean | null {
  if (!toolName.startsWith("mcp__")) return null;
  const remainder = toolName.slice(5);

  for (const serverName of enabledServers) {
    const normalized = normalizeMcpName(serverName);
    const prefix = `${normalized}__`;
    if (!remainder.startsWith(prefix)) continue;
    const tool = remainder.slice(prefix.length);
    if (!mcpToolFilters || !(serverName in mcpToolFilters)) return true;
    const filters = mcpToolFilters[serverName];
    for (const filter of filters) {
      if (filter === tool) return true;
      if (filter.includes(":")) {
        let parsed: { server?: string; tool?: string };
        try {
          parsed = JSON.parse(toolInput) as { server?: string; tool?: string };
        } catch {
          continue;
        }
        const [filterServer, filterTool] = filter.split(":", 2);
        if (parsed.server === filterServer) {
          if (filterTool === "*" || parsed.tool === filterTool) return true;
        }
      }
    }
    return false;
  }

  return false;
}

export class JobScheduler {
  private sessionManager: SessionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFiredAt = new Map<string, Date>();
  private runningJobs = new Map<string, JobRun>();
  private lastPruneAt = 0;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  start(): void {
    this.recoverState();
    this.timer = setInterval(() => this.tick(), 60_000);
    console.log("[scheduler] started, ticking every 60s");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[scheduler] stopped");
  }

  reloadJobs(): void {
    // no-op: jobs are read from disk on each tick
  }

  getRunningJobs(): Map<string, JobRun> {
    return new Map(this.runningJobs);
  }

  async triggerJob(jobId: string): Promise<JobRun> {
    const jobs = loadJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    return this.executeJob(job);
  }

  private recoverState(): void {
    pruneAllRuns();
    const now = Date.now();
    const jobs = loadJobs();
    for (const job of jobs) {
      const latest = getLatestRun(job.id);
      if (latest) {
        this.lastFiredAt.set(job.id, new Date(latest.startedAt));
      }
      for (const run of loadRuns(job.id)) {
        if (run.status === "running") {
          run.status = "failure";
          run.error = "Server restarted while job was running";
          run.completedAt = now;
          run.durationMs = now - run.startedAt;
          saveRun(run);
        }
      }
    }
  }

  private tick(): void {
    const now = new Date();
    now.setSeconds(0, 0);

    const nowMs = now.getTime();
    if (nowMs - this.lastPruneAt >= 3_600_000) {
      this.lastPruneAt = nowMs;
      pruneAllRuns();
    }

    for (const [jobId, run] of this.runningJobs) {
      if (!this.sessionManager.hasRunningProcess(run.sessionId)) {
        console.log(`[scheduler] run ${run.id} for job ${jobId} has no running process, marking as failure`);
        run.status = "failure";
        run.error = "Session process exited unexpectedly";
        run.completedAt = Date.now();
        run.durationMs = run.completedAt - run.startedAt;
        if (run.cwd) run.messageCount = countTranscriptMessages(run.sessionId, run.cwd);
        saveRun(run);
        this.runningJobs.delete(jobId);
      }
    }

    const jobs = loadJobs();

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.runningJobs.has(job.id)) continue;

      const lastFired = this.lastFiredAt.get(job.id);
      let shouldFire = false;

      for (const sched of getJobSchedules(job)) {
        const cronExpr = scheduleToCron(sched);
        if (matchesCron(cronExpr, now)) {
          if (!lastFired || lastFired.getTime() < now.getTime()) {
            shouldFire = true;
            break;
          }
        } else if (lastFired && findMissedRun(cronExpr, lastFired, now)) {
          if (!job.skipIfMissed) {
            shouldFire = true;
            break;
          }
        }
      }

      if (shouldFire) {
        this.lastFiredAt.set(job.id, now);
        this.executeJob(job).catch((err) => {
          console.error(`[scheduler] failed to execute job ${job.name}:`, err);
        });
      }
    }
  }

  async executeJob(job: ScheduledJob): Promise<JobRun> {
    const runId = uuidv4();
    const jobCwd = job.cwd || SCRATCHPAD_DIR;
    if (!job.cwd) {
      mkdirSync(SCRATCHPAD_DIR, { recursive: true });
    }
    const sessionInfo = this.sessionManager.createSession(jobCwd, `[job] ${job.name}`, {
      bypassPermissions: !!job.bypassPermissions,
    });
    const sessionId = sessionInfo.id;

    const run: JobRun = {
      id: runId,
      jobId: job.id,
      sessionId,
      status: "running",
      startedAt: Date.now(),
      toolsUsed: [],
      messageCount: 0,
      prompt: job.prompt,
      cwd: jobCwd,
    };

    saveRun(run);
    this.runningJobs.set(job.id, run);

    const toolTracker = new Map<string, JobRunToolUse>();

    const unsubEvent = this.sessionManager.subscribe(sessionId, (event) => {
      if (event.type === "tool_use_start" && event.toolId) {
        toolTracker.set(event.toolId, {
          name: event.toolName || "unknown",
          input: event.toolInput || "",
          output: "",
          timestamp: Date.now(),
        });
      } else if (event.type === "tool_result" && event.toolId) {
        const entry = toolTracker.get(event.toolId);
        if (entry) {
          entry.output = event.toolOutput || "";
          entry.durationMs = Date.now() - entry.timestamp;
          run.toolsUsed.push(entry);
          toolTracker.delete(event.toolId);
        }
      } else if (event.type === "message_done") {
        run.messageCount++;
      } else if (event.type === "permission_request" && event.requestId) {
        if (job.bypassPermissions) {
          this.sessionManager.respondToPermission(sessionId, event.requestId, true, event.rawToolInput);
        } else {
          const toolName = event.toolName || "unknown";
          const inputStr = event.toolInput || "";
          const mcpResult = isMcpToolAllowed(toolName, inputStr, enabledServers, job.mcpToolFilters);
          const allowed = mcpResult !== null ? mcpResult : isToolAllowed(toolName, inputStr, job.allowedTools || []);
          this.sessionManager.respondToPermission(sessionId, event.requestId, allowed, allowed ? event.rawToolInput : undefined);

          const permEntry: JobRunToolUse = {
            name: toolName,
            input: inputStr,
            output: "",
            timestamp: Date.now(),
            permitted: allowed,
          };
          run.toolsUsed.push(permEntry);
        }
      }
    });

    const enabledServers = new Set(job.mcpServers || []);
    const initCleanup = this.sessionManager.onInit(sessionId, (initData) => {
      for (const server of initData.mcpServers) {
        if (!enabledServers.has(server.name)) {
          this.sessionManager.mcpToggle(sessionId, server.name, false).catch(() => {});
        }
      }
    });

    if (job.model) {
      this.sessionManager.setModel(sessionId, job.model);
    }
    if (job.thinkingLevel) {
      this.sessionManager.setThinkingLevel(sessionId, job.thinkingLevel);
    }

    return new Promise<JobRun>((resolve) => {
      const maxMs = (job.maxDurationMinutes || 30) * 60 * 1000;
      const timeout = setTimeout(() => {
        cleanup("timeout");
      }, maxMs);

      const unsubStatus = this.sessionManager.onStatus(sessionId, (status) => {
        if (status === "idle") {
          cleanup("success");
        }
      });

      const unsubError = this.sessionManager.onError(sessionId, (error) => {
        run.error = error;
        cleanup("failure");
      });

      let cleaned = false;
      const cleanup = (finalStatus: "success" | "failure" | "timeout") => {
        if (cleaned) return;
        cleaned = true;
        clearTimeout(timeout);
        unsubEvent?.();
        unsubStatus?.();
        unsubError?.();
        initCleanup?.();

        run.status = finalStatus;
        run.completedAt = Date.now();
        run.durationMs = run.completedAt - run.startedAt;
        if (finalStatus === "timeout") {
          run.error = `Exceeded max duration of ${job.maxDurationMinutes || 30} minutes`;
          this.sessionManager.destroySession(sessionId);
        }

        const transcriptCount = countTranscriptMessages(sessionId, jobCwd);
        if (transcriptCount > run.messageCount) run.messageCount = transcriptCount;

        saveRun(run);
        this.runningJobs.delete(job.id);
        resolve(run);
      };

      this.sessionManager.sendMessage(sessionId, buildJobPrompt(job));
    });
  }
}
