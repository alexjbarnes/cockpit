import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { JobRun, JobRunToolUse, ScheduledJob } from "@/types";
import { findMissedRun, getJobSchedules, matchesCron, scheduleToCron } from "./cron-utils";
import { addInboxMessage, parseErrorBlock, parseInboxBlock } from "./inbox";
import { acquireJobLock, clearStaleLocks, releaseJobLock } from "./job-lock";
import { getLatestRun, loadJobs, loadRuns, pruneAllRuns, saveRun } from "./job-storage";
import type { SessionManager } from "./session-manager";
import { countTranscriptMessages } from "./transcript";

const SCRATCHPAD_DIR = path.join(homedir(), ".cockpit", "jobs");

const JOB_PROMPT_HEADER = [
  "You are running as an autonomous scheduled job. There is no human operator in this session.",
  "Do not ask clarifying questions. Do not wait for user input. Make reasonable assumptions and proceed.",
  "Complete the task fully, then stop.",
  "",
  "Error reporting: If you cannot complete the task due to permission errors, tool failures, missing data, or any other reason,",
  "your final message MUST include a cockpit-error block explaining the failure.",
  "Format it as a fenced code block tagged cockpit-error containing a JSON object:",
  "",
  "```cockpit-error",
  '{"error":"Brief description of what went wrong","details":"Longer explanation of which tools failed and why"}',
  "```",
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

  if (job.cwd) {
    const storageDir = path.join(SCRATCHPAD_DIR, job.id);
    parts.push("");
    parts.push(`Storage: If you need to persist any files between runs (state, cache, data), save them in ${storageDir}`);
    parts.push("Do not store persistent files in the working directory as it is a git repository.");
  }

  if (job.inboxOutput) {
    parts.push("");
    parts.push("Output: When you have results to report, include a cockpit-inbox block in your final message.");
    parts.push("If there is nothing to report (e.g. no new data to process), do NOT include an inbox block.");
    parts.push("Format it as a fenced code block tagged cockpit-inbox containing a JSON object:");
    parts.push("");
    parts.push("```cockpit-inbox");
    parts.push(JSON.stringify({ title: "Short descriptive title", body: "Markdown body with your full output", priority: "info" }));
    parts.push("```");
    parts.push("");
    parts.push('The body field supports full markdown. Set priority to "info", "warning", or "error" as appropriate.');
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
    for (const jobId of this.runningJobs.keys()) {
      releaseJobLock(jobId);
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
    clearStaleLocks();
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
        releaseJobLock(jobId);
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

    if (!acquireJobLock(job.id, runId)) {
      console.log(`[scheduler] skipping job ${job.name}: another process holds the lock`);
      throw new Error("Could not acquire job lock - another process is running this job");
    }

    const jobCwd = job.cwd || path.join(SCRATCHPAD_DIR, job.id);
    mkdirSync(path.join(SCRATCHPAD_DIR, job.id), { recursive: true });
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
    let lastAssistantText = "";

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
        if (event.message) {
          let text = event.message.content;
          if (!text && event.message.blocks) {
            text = event.message.blocks
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          if (text) lastAssistantText = text;
        }
      } else if (event.type === "permission_request" && event.requestId) {
        if (job.bypassPermissions) {
          this.sessionManager.respondToPermission(sessionId, event.requestId, true, event.rawToolInput);
        } else {
          const toolName = event.toolName || "unknown";
          const inputStr = event.toolInput || "";
          const mcpResult = isMcpToolAllowed(toolName, inputStr, enabledServers, job.mcpToolFilters);
          const allowed = mcpResult !== null ? mcpResult : isToolAllowed(toolName, inputStr, job.allowedTools || []);
          console.log(`[scheduler] permission: ${toolName} mcpResult=${mcpResult} allowed=${allowed} servers=[${[...enabledServers]}]`);
          this.sessionManager.respondToPermission(sessionId, event.requestId, allowed, allowed ? (event.rawToolInput ?? {}) : undefined);

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

        run.completedAt = Date.now();
        run.durationMs = run.completedAt - run.startedAt;
        if (finalStatus === "timeout") {
          run.error = `Exceeded max duration of ${job.maxDurationMinutes || 30} minutes`;
          this.sessionManager.destroySession(sessionId);
        }

        if (finalStatus === "success" && lastAssistantText) {
          const errorBlock = parseErrorBlock(lastAssistantText);
          if (errorBlock) {
            finalStatus = "failure";
            run.error = errorBlock.details ? `${errorBlock.error}: ${errorBlock.details}` : errorBlock.error;
          }
        }

        run.status = finalStatus;

        const transcriptCount = countTranscriptMessages(sessionId, jobCwd);
        if (transcriptCount > run.messageCount) run.messageCount = transcriptCount;

        saveRun(run);

        if (job.inboxOutput && lastAssistantText) {
          const inbox = parseInboxBlock(lastAssistantText);
          if (inbox) {
            addInboxMessage({ ...inbox, jobId: job.id, jobName: job.name, runId: run.id, notifyProviders: job.notifyProviders });
          }
        }
        if (finalStatus === "failure" || finalStatus === "timeout") {
          addInboxMessage({
            title: `Job failed: ${job.name}`,
            body: `**Status:** ${finalStatus}\n\n${run.error || "Job failed with no error message"}`,
            priority: "error",
            jobId: job.id,
            jobName: job.name,
            runId: run.id,
            notifyProviders: job.notifyProviders,
          });
        }

        this.runningJobs.delete(job.id);
        releaseJobLock(job.id);
        resolve(run);
      };

      this.sessionManager.sendMessage(sessionId, buildJobPrompt(job));
    });
  }
}
