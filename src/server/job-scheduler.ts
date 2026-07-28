import { mkdirSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { getJobScratchpadDir } from "@/server/paths";
import type { JobRun, JobRunToolUse, ScheduledJob } from "@/types";
import { findMissedRun, getJobSchedules, matchesCron, scheduleToCron } from "./cron-utils";
import { logDiag } from "./debug-logger";
import { addInboxMessage, parseErrorBlock } from "./inbox";
import { acquireJobLock, clearStaleLocks, forceReleaseJobLock, releaseJobLock } from "./job-lock";
import { getLatestRun, loadJobs, loadRuns, pruneAllRuns, saveRun } from "./job-storage";
import { checkJobModel } from "./provider-catalog";
import type { SessionManager } from "./session-manager";
import { countTranscriptMessages } from "./transcript";

/** Default extra attempts after a `failure` run when a job doesn't set maxRetries. */
const DEFAULT_JOB_MAX_RETRIES = 1;

/**
 * The MCP tool a job reports through. Replaces parsing a fenced block out of the
 * final message, which failed silently: a job could spend seventeen minutes on a
 * report, emit the block as YAML instead of JSON, and have it dropped with the
 * run still recorded a success. A tool call is schema-validated, and a rejection
 * comes back as an error the model can read and retry.
 */
const INBOX_TOOL_NAME = "mcp__cockpit-config__add_inbox_message";
/** Pause before a retry so a fresh session isn't spawned the instant the last one died. */
const RETRY_BACKOFF_MS = 5_000;

const JOB_PROMPT_HEADER = [
  "You are running as an autonomous scheduled job. There is no human operator in this session.",
  "Do not ask clarifying questions. Do not wait for user input. Make reasonable assumptions and proceed.",
  "Complete the task fully, then stop.",
  "",
  "Subagents: if you use the Agent tool you MUST pass run_in_background: false and wait for the result.",
  "A backgrounded agent ends your turn to wait for a task notification, and with no operator here to",
  "resume you the run is torn down and its work is lost. Never end a turn intending to be woken up.",
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
    const storageDir = getJobScratchpadDir(job.id);
    parts.push("");
    parts.push(`Storage: If you need to persist any files between runs (state, cache, data), save them in ${storageDir}`);
    parts.push("Do not store persistent files in the working directory as it is a git repository.");
  }

  if (job.inboxOutput) {
    parts.push("");
    parts.push(`Output: report your results by calling the ${INBOX_TOOL_NAME} tool. That is the only way your output reaches the user;`);
    parts.push("nothing in your final message is read. Call it once, before you finish.");
    parts.push("If there is nothing to report (e.g. no new data to process), do not call it at all.");
    parts.push("");
    parts.push("It takes title (a short one-line summary), body (full markdown, as long as you need), and an optional");
    parts.push('priority of "info", "warning" or "error". If the call returns an error, read it and call again with it fixed.');
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
  private jobResolvers = new Map<string, (run: JobRun) => void>();
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
    return this.executeJobWithRetries(job);
  }

  /**
   * Run a job, retrying up to `job.maxRetries` (default 1) more times if the run
   * ends in `failure` — the "went idle without an assistant message" / transient
   * class. `timeout` and `stopped` are terminal and never retried. Each attempt is
   * its own run record and inbox output; the failure alert is suppressed on attempts
   * that will be retried, so only the final outcome pages the operator.
   */
  private async executeJobWithRetries(job: ScheduledJob): Promise<JobRun> {
    // W6j: a job whose model is gone from the provider catalog fails before
    // the CLI spawns — no lock, no session, no substitution onto another
    // model, and no retry (the failure is deterministic). The operator fixes
    // it by picking a new model on the job.
    const modelCheck = checkJobModel(job.model);
    if (!modelCheck.ok) {
      const run: JobRun = {
        id: uuidv4(),
        jobId: job.id,
        sessionId: "",
        status: "failure",
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        error: modelCheck.reason,
        toolsUsed: [],
        messageCount: 0,
        prompt: job.prompt,
        cwd: job.cwd || "",
        configFailure: true,
      };
      saveRun(run);
      logDiag(job.id, "job:config-failure", { runId: run.id, model: job.model, error: modelCheck.reason });
      addInboxMessage({
        title: `Job failed: ${job.name}`,
        body: `**Status:** failure\n\n${modelCheck.reason}`,
        priority: "error",
        jobId: job.id,
        jobName: job.name,
        runId: run.id,
        notifyProviders: job.notifyProviders,
      });
      return run;
    }

    const maxRetries = Math.max(0, job.maxRetries ?? DEFAULT_JOB_MAX_RETRIES);
    let run: JobRun;
    for (let attempt = 0; ; attempt++) {
      const isFinal = attempt >= maxRetries;
      run = await this.executeJob(job, { suppressFailureAlert: !isFinal });
      if (run.status !== "failure" || isFinal) break;
      logDiag(job.id, "job:retry", { attempt: attempt + 1, maxRetries, prevRunId: run.id, error: run.error });
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
    return run;
  }

  stopJob(jobId: string): JobRun {
    const run = this.runningJobs.get(jobId);
    if (!run) throw new Error("Job is not currently running");
    // Guard against the cleanup timeout having already fired.
    // cleanup ALWAYS sets completedAt (line 469), so this is a race-free signal.
    if (run.completedAt) throw new Error("Job is no longer running");

    // Set status BEFORE destroySession -- same object reference as closure's run
    run.status = "stopped";
    run.error = "Stopped by user";
    run.completedAt = Date.now();
    run.durationMs = run.completedAt - run.startedAt;

    // Count transcript BEFORE destroySession -- destroySession stops the watcher
    const transcriptCount = countTranscriptMessages(run.sessionId, run.cwd);

    this.sessionManager.destroySession(run.sessionId);
    if (transcriptCount > run.messageCount) run.messageCount = transcriptCount;

    saveRun(run);

    addInboxMessage({
      title: `Job stopped: ${run.jobId}`,
      body: `**Status:** stopped\n\nStopped by user after ${Math.round((run.durationMs ?? 0) / 1000)}s`,
      priority: "info",
      jobId: run.jobId,
      runId: run.id,
    });

    this.runningJobs.delete(jobId);
    releaseJobLock(jobId);

    // Resolve the executeJob Promise. If cleanup already resolved it
    // (via the guard), this is a no-op (Promise can only settle once).
    const resolve = this.jobResolvers.get(jobId);
    if (resolve) {
      resolve(run);
      this.jobResolvers.delete(jobId);
    }

    logDiag(jobId, "job:stopped", {
      runId: run.id,
      messageCount: run.messageCount,
      toolCount: run.toolsUsed.length,
    });
    return run;
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
          forceReleaseJobLock(job.id);
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
        this.executeJobWithRetries(job).catch((err) => {
          console.error(`[scheduler] failed to execute job ${job.name}:`, err);
        });
      }
    }
  }

  async executeJob(job: ScheduledJob, opts?: { suppressFailureAlert?: boolean }): Promise<JobRun> {
    const runId = uuidv4();
    logDiag(job.id, "job:execute-start", {
      runId,
      name: job.name,
      // Not the resolved runtime: an unset job falls through to the session
      // manager's default. The session-created entry below logs what it became.
      runtime: job.runtime ?? "(default)",
      model: job.model,
      thinkingLevel: job.thinkingLevel,
      contextSize: job.contextSize,
      mcpServers: job.mcpServers ?? [],
      allowedTools: job.allowedTools ?? [],
      bypassPermissions: !!job.bypassPermissions,
      inboxOutput: !!job.inboxOutput,
      maxDurationMinutes: job.maxDurationMinutes ?? 30,
    });

    if (!acquireJobLock(job.id, runId)) {
      logDiag(job.id, "job:lock-failed", { runId });
      console.log(`[scheduler] skipping job ${job.name}: another process holds the lock`);
      throw new Error("Could not acquire job lock - another process is running this job");
    }
    logDiag(job.id, "job:lock-acquired", { runId });

    const jobCwd = job.cwd || getJobScratchpadDir(job.id);
    mkdirSync(getJobScratchpadDir(job.id), { recursive: true });
    const sessionInfo = this.sessionManager.createSession(jobCwd, `[job] ${job.name}`, {
      bypassPermissions: !!job.bypassPermissions,
      runtime: job.runtime,
      // Only an inbox-reporting job gets a run context, and only a run context
      // gets the cockpit MCP server. A job that never reports keeps no reach
      // into cockpit at all.
      ...(job.inboxOutput ? { runContext: { jobId: job.id, jobName: job.name, runId, notifyProviders: job.notifyProviders } } : {}),
    });
    const sessionId = sessionInfo.id;
    const jlog = (label: string, data?: Record<string, unknown>) => logDiag(sessionId, `job:${label}`, { jobId: job.id, runId, ...data });
    jlog("session-created", { cwd: jobCwd, runtime: sessionInfo.runtime });

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
    const enabledServers = new Set(job.mcpServers || []);
    // Background subagents outlive the turn that launched them. If the turn
    // ends with any still running, the model was waiting for a notification
    // that nothing here will deliver, and cleanup is about to kill the PTY.
    const pendingTasks = new Set<string>();

    const unsubEvent = this.sessionManager.subscribe(sessionId, (event) => {
      if (event.type === "tool_use_start" && event.toolId) {
        toolTracker.set(event.toolId, {
          name: event.toolName || "unknown",
          input: event.toolInput || "",
          output: "",
          timestamp: Date.now(),
        });
        jlog("tool-start", { toolId: event.toolId, toolName: event.toolName ?? "unknown" });
      } else if (event.type === "tool_result" && event.toolId) {
        const entry = toolTracker.get(event.toolId);
        if (entry) {
          entry.output = event.toolOutput || "";
          entry.durationMs = Date.now() - entry.timestamp;
          run.toolsUsed.push(entry);
          toolTracker.delete(event.toolId);
          jlog("tool-result", { toolId: event.toolId, name: entry.name, durationMs: entry.durationMs, outputLen: entry.output.length });
        }
      } else if (event.type === "message_done") {
        run.messageCount++;
        let textLen = 0;
        if (event.message) {
          let text = event.message.content;
          if (!text && event.message.blocks) {
            text = event.message.blocks
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("\n");
          }
          if (text) {
            lastAssistantText = text;
            textLen = text.length;
          }
        }
        // JOB-DEBUG: a message_done carrying tool uses but no text is the turn that
        // ends after a tool_use without a final answer — the failure signature.
        jlog("message-done", {
          count: run.messageCount,
          textLen,
          toolUses: event.message?.toolUses?.length ?? 0,
          updatedLastText: textLen > 0,
        });
      } else if (event.type === "task_update" && event.taskInfo?.taskId) {
        const { taskId, status } = event.taskInfo;
        if (status === "running") pendingTasks.add(taskId);
        else pendingTasks.delete(taskId);
        jlog("task-update", { taskId, status, pending: pendingTasks.size });
      } else if (event.type === "permission_request" && event.requestId) {
        if (job.bypassPermissions) {
          jlog("permission", { toolName: event.toolName ?? "unknown", requestId: event.requestId, bypass: true, allowed: true });
          this.sessionManager.respondToPermission(sessionId, event.requestId, true, event.rawToolInput);
        } else {
          const toolName = event.toolName || "unknown";
          const inputStr = event.toolInput || "";
          // The inbox tool is cockpit's own reporting channel, not something the
          // user configures per job, so it bypasses the mcpServers allowlist it
          // would otherwise fail. The MCP server still confines a run token to
          // this one tool, so allowing it here grants nothing else.
          const isInboxTool = toolName === INBOX_TOOL_NAME;
          const mcpResult = isInboxTool ? !!job.inboxOutput : isMcpToolAllowed(toolName, inputStr, enabledServers, job.mcpToolFilters);
          const allowed = mcpResult !== null ? mcpResult : isToolAllowed(toolName, inputStr, job.allowedTools || []);
          jlog("permission", {
            toolName,
            requestId: event.requestId,
            mcpResult,
            allowed,
            enabledServers: [...enabledServers],
          });
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

    // JOB-DEBUG: the scheduler currently ignores compaction entirely. Track it from
    // the system-message stream and surface every system message the run receives,
    // so a teardown can be correlated with a compaction window.
    let compacting = false;
    let lastCompactAt = 0;
    const unsubSystem = this.sessionManager.onSystem(sessionId, (text) => {
      if (text === "__compact::start") compacting = true;
      else if (text === "__compact::done") {
        compacting = false;
        lastCompactAt = Date.now();
      }
      jlog("system-msg", { text: text.slice(0, 140), compacting });
    });

    const initCleanup = this.sessionManager.onInit(sessionId, (initData) => {
      const disabling: string[] = [];
      for (const server of initData.mcpServers) {
        if (!enabledServers.has(server.name)) {
          disabling.push(server.name);
          this.sessionManager.mcpToggle(sessionId, server.name, false).catch(() => {});
        }
      }
      jlog("init", { available: initData.mcpServers.map((s) => s.name), disabling, enabled: [...enabledServers] });
    });

    if (job.model) {
      this.sessionManager.setModel(sessionId, job.model, job.contextSize);
      jlog("set-model", { model: job.model, contextSize: job.contextSize });
    }
    if (job.thinkingLevel) {
      this.sessionManager.setThinkingLevel(sessionId, job.thinkingLevel);
      jlog("set-thinking", { thinkingLevel: job.thinkingLevel });
    }

    return new Promise<JobRun>((resolve) => {
      this.jobResolvers.set(job.id, resolve);
      const maxMs = (job.maxDurationMinutes || 30) * 60 * 1000;
      const sentAt = Date.now();
      let sawRunning = false;
      let statusEvents = 0;

      const timeout = setTimeout(() => {
        jlog("watchdog-fired", {
          maxMs,
          elapsedMs: Date.now() - sentAt,
          sawRunning,
          messageCount: run.messageCount,
          toolCount: run.toolsUsed.length,
        });
        cleanup("timeout");
      }, maxMs);

      const unsubStatus = this.sessionManager.onStatus(sessionId, (status) => {
        statusEvents++;
        if (status === "running") sawRunning = true;
        // An "idle" that arrives while the process is still alive is the orphan
        // signature: the run gets marked done but the PTY keeps going untracked.
        const processAlive = this.sessionManager.hasRunningProcess(sessionId);
        jlog("status-event", {
          status,
          n: statusEvents,
          elapsedMs: Date.now() - sentAt,
          sawRunning,
          processAlive,
          // JOB-DEBUG: state that determines whether this idle is real or spurious.
          compacting,
          msSinceCompact: lastCompactAt ? Date.now() - lastCompactAt : null,
          lastAssistantTextLen: lastAssistantText.length,
          pendingTasks: pendingTasks.size,
          messageCount: run.messageCount,
          toolCount: run.toolsUsed.length,
        });
        if (status === "idle") {
          // JOB-DEBUG: this is the exact decision that ends the run. If the CLI is
          // still alive, or we just compacted, or there is no assistant text, this
          // idle is the prime suspect for a premature teardown.
          jlog("idle-cleanup-decision", {
            processAlive,
            compacting,
            msSinceCompact: lastCompactAt ? Date.now() - lastCompactAt : null,
            lastAssistantTextLen: lastAssistantText.length,
            lastAssistantTextHead: lastAssistantText.slice(0, 160),
            pendingTasks: pendingTasks.size,
            elapsedMs: Date.now() - sentAt,
          });
          cleanup("success");
        }
      });

      const unsubError = this.sessionManager.onError(sessionId, (error) => {
        jlog("error-event", { error, elapsedMs: Date.now() - sentAt });
        run.error = error;
        cleanup("failure");
      });

      let cleaned = false;
      const cleanup = (finalStatus: "success" | "failure" | "timeout") => {
        if (cleaned) {
          jlog("cleanup-skipped", { requestedStatus: finalStatus, elapsedMs: Date.now() - sentAt });
          return;
        }
        if (run.status === "stopped") {
          cleaned = true;
          jlog("cleanup-guard-stopped", { elapsedMs: Date.now() - sentAt });
          clearTimeout(timeout);
          resolve(run);
          this.jobResolvers.delete(job.id);
          return;
        }
        cleaned = true;
        jlog("cleanup-begin", {
          finalStatus,
          elapsedMs: Date.now() - sentAt,
          sawRunning,
          statusEvents,
          messageCount: run.messageCount,
          toolCount: run.toolsUsed.length,
          lastTextLen: lastAssistantText.length,
        });
        clearTimeout(timeout);
        unsubEvent?.();
        unsubStatus?.();
        unsubError?.();
        unsubSystem?.();
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
            jlog("error-block-detected", { error: run.error });
          }
        }

        // A completed turn always ends with an assistant message. Reaching idle
        // without one means the turn was cut short rather than finished — the
        // signature of a run torn down mid-compaction, which reported "success"
        // for three days while producing nothing. Fail loudly instead: the
        // failure branch below raises an inbox alert.
        if (finalStatus === "success" && !lastAssistantText) {
          finalStatus = "failure";
          run.error = "Job went idle without producing any assistant message, so the turn never completed";
          jlog("no-assistant-message", { toolCount: run.toolsUsed.length });
        }

        if (finalStatus === "success" && pendingTasks.size > 0) {
          finalStatus = "failure";
          run.error = `Job ended its turn with ${pendingTasks.size} background subagent(s) still running, so their work was never collected`;
          jlog("pending-background-tasks", { pending: pendingTasks.size });
        }

        run.status = finalStatus;

        const transcriptCount = countTranscriptMessages(sessionId, jobCwd);
        jlog("transcript-count", { transcriptCount, runMessageCount: run.messageCount });
        if (transcriptCount > run.messageCount) run.messageCount = transcriptCount;

        saveRun(run);

        // A `failure` alert is suppressed on attempts that will be retried (the retry
        // wrapper passes suppressFailureAlert); the final attempt still alerts. A
        // `timeout` is terminal and never retried, so it always alerts.
        if (finalStatus === "timeout" || (finalStatus === "failure" && !opts?.suppressFailureAlert)) {
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

        jlog("cleanup-done", {
          finalStatus,
          durationMs: run.durationMs,
          messageCount: run.messageCount,
          toolCount: run.toolsUsed.length,
          error: run.error,
        });

        // A one-shot job's PTY claude sits idle at the prompt after answering;
        // without this it never exits and leaks ~310MB per run until the next
        // server restart. Idempotent — a timeout already destroyed it above.
        this.sessionManager.destroySession(sessionId);

        this.runningJobs.delete(job.id);
        releaseJobLock(job.id);
        resolve(run);
        this.jobResolvers.delete(job.id);
      };

      const promptText = buildJobPrompt(job);
      jlog("send-message", { promptLen: promptText.length, maxMs });
      this.sessionManager.sendMessage(sessionId, promptText);
    });
  }
}
