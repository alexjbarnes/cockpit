import { mkdirSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { checkClaudeUserConfig } from "@/server/claude-config-guard";
import { configuredMcpServerNames } from "@/server/mcp-discovery";
import { isConfiguredMcpServer } from "@/server/mcp-server-names";
import { getJobScratchpadDir } from "@/server/paths";
import { projectRunsWorkflow } from "@/server/workflow-storage";
import { trustDirectory } from "@/server/workspace-trust";
import type { AfterJobsSchedule, IssueStatusSchedule, JobRun, ScheduledJob } from "@/types";
import { startAgentRun } from "./agent-run";
import { findMissedRun, getJobSchedules, isTimeBasedSchedule, matchesCron, scheduleToCron } from "./cron-utils";
import { logDiag } from "./debug-logger";
import { addInboxMessage } from "./inbox";
import { type IssueStatusChangeEvent, onIssueStatusChange } from "./issue-events";
import { loadIssues, loadProjects } from "./issue-storage";
import { acquireJobLock, clearStaleLocks, forceReleaseJobLock, releaseJobLock } from "./job-lock";
import { getLatestRun, loadJobs, loadRuns, pruneAllRuns, saveRun } from "./job-storage";
import { checkJobModel } from "./provider-catalog";
import { INBOX_TOOL_NAME } from "./run-permissions";
import type { SessionManager } from "./session-manager";
import { countTranscriptMessages } from "./transcript";

/** Default extra attempts after a `failure` run when a job doesn't set maxRetries. */
const DEFAULT_JOB_MAX_RETRIES = 1;

/** Pause before a retry so a fresh session isn't spawned the instant the last one died. */
const RETRY_BACKOFF_MS = 5_000;

const JOB_PROMPT_HEADER = [
  "You are running as an autonomous scheduled job. There is no human operator in this session.",
  "Do not ask clarifying questions. Do not wait for user input. Make reasonable assumptions and proceed.",
  "Complete the task fully, then stop.",
  "",
  "Subagents: the Agent tool runs asynchronously. Launching one does not end this job: when your turn ends",
  "while it works, the run stays open and the CLI wakes you with a task notification when the agent reports.",
  "Read the result and finish every remaining step before your final message. Do not poll the task's output file,",
  "sleep in Bash or use Monitor to wait for it, and do not report results before the notification arrives.",
  "",
  "Error reporting: a cockpit-error block marks this run FAILED, so emit one only when you could not finish the task —",
  "permission errors, tool failures, missing data, anything that stopped you.",
  'If you completed the task, do not emit one at all: no block is how a run reports success. A block saying "none"',
  "still fails the run.",
  "When you do need it, put it last in your final message, as a fenced code block tagged cockpit-error holding JSON:",
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
    // A rule like "Bash curl" reads as a bare program name, so a run that hits
    // a refusal tends to retry the same command in cosmetic variations. Spell
    // out what the rule actually checks, and that retrying will not help.
    if (tools.some((t) => t.startsWith("Bash "))) {
      parts.push(
        "",
        'A "Bash <program>" entry allows commands starting with that program, but only when the command runs nothing else:',
        "no ; && || | > < & backticks or $( ) outside quotes. Inside quotes those characters are ordinary data and are fine,",
        'so a payload like --data-urlencode "notes=a; b" is allowed. A pipeline is never allowed by one entry — run the stages',
        "as separate commands via a temp file. If a command is refused, rephrasing it will not help: either drop the chaining,",
        "or report the missing permission in your cockpit-error block and stop. Do not widen your own permissions to get around a",
        "refusal — name the entry you needed in the error block and let the user decide.",
      );
    }
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

/** How many issues currently sit in the schedule's watched status (and
 *  project, if it names one). Used both to decide a match matters and, after
 *  the triggered run completes, to decide whether to drain another one. */
function countMatchingIssues(sched: IssueStatusSchedule): number {
  const projects = sched.project ? loadProjects().filter((p) => p.id === sched.project) : loadProjects();
  return projects.reduce((n, p) => n + loadIssues(p.id).filter((i) => i.status === sched.status).length, 0);
}

/** Whether a job succeeded in a run that started after `since`. */
function succeededSince(jobId: string, since: number): boolean {
  return loadRuns(jobId).some((r) => r.status === "success" && r.startedAt > since);
}

/**
 * Whether a job waiting on others is due: none of the jobs its afterJobs
 * schedules list is busy, and every job one of them lists has succeeded in a
 * run that started after this job last started, or after it was last saved
 * if it has never run. A run already going when this job started can end
 * after it, but this job could not have seen what it produced, so it waits
 * for the next. Measured from persisted runs, not from events, so a
 * completion the scheduler missed (a restart, or this job still running when
 * its last dependency finished) is still caught.
 */
function dependenciesMet(job: ScheduledJob, busy: (jobId: string) => boolean): boolean {
  const waits = getJobSchedules(job).filter((s): s is AfterJobsSchedule => s.type === "afterJobs");
  if (waits.length === 0 || waits.some((s) => s.jobIds.some(busy))) return false;
  const since = getLatestRun(job.id)?.startedAt ?? (job.updatedAt || job.createdAt);
  return waits.some((s) => s.jobIds.length > 0 && s.jobIds.every((id) => succeededSince(id, since)));
}

export class JobScheduler {
  private sessionManager: SessionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFiredAt = new Map<string, Date>();
  private runningJobs = new Map<string, JobRun>();
  /** Jobs started and not yet past their last attempt, the wait before a
   *  retry included, counted per start. */
  private activeJobs = new Map<string, number>();
  private jobResolvers = new Map<string, (run: JobRun) => void>();
  private lastPruneAt = 0;
  private lastConfigCheckAt = 0;
  private unsubIssueEvents: (() => void) | null = null;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  start(): void {
    this.recoverState();
    this.timer = setInterval(() => this.tick(), 60_000);
    // Phase 4 (docs/internal/issue-tracker-spec.md): saveIssue emits whenever
    // an issue's status changes, so an onIssueStatus job trigger doesn't wait
    // for the next tick.
    this.unsubIssueEvents = onIssueStatusChange((event) => this.handleIssueStatusChange(event));
    console.log("[scheduler] started, ticking every 60s");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubIssueEvents?.();
    this.unsubIssueEvents = null;
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

  /** Running, or started and waiting to retry. */
  private isBusy(jobId: string): boolean {
    return this.runningJobs.has(jobId) || this.activeJobs.has(jobId);
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
  /**
   * Servers the job needs that are configured nowhere, after one attempt to
   * restore a wiped config. Empty for a job that runs with no servers of its
   * own, which is most of them.
   */
  private missingJobMcpServers(job: ScheduledJob): string[] {
    const required = job.mcpServers ?? [];
    if (required.length === 0) return [];
    const cwd = job.cwd || getJobScratchpadDir(job.id);
    checkClaudeUserConfig();
    const configured = configuredMcpServerNames(cwd);
    return required.filter((name) => !isConfiguredMcpServer(name, configured));
  }

  private async executeJobWithRetries(job: ScheduledJob): Promise<JobRun> {
    this.activeJobs.set(job.id, (this.activeJobs.get(job.id) ?? 0) + 1);
    let run: JobRun;
    try {
      run = await this.runAttempts(job);
    } finally {
      const left = (this.activeJobs.get(job.id) ?? 1) - 1;
      if (left > 0) this.activeJobs.set(job.id, left);
      else this.activeJobs.delete(job.id);
    }
    // Only now that this job no longer counts as busy, or the jobs waiting on
    // it would keep waiting.
    if (run.status === "success") this.startJobsWaitingOn(job);
    return run;
  }

  private async runAttempts(job: ScheduledJob): Promise<JobRun> {
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

    // A job's MCP servers are definitions the CLI reads out of its own user
    // config, and the CLI resets that file from defaults after one unreadable
    // read (see claude-config-guard). When a wipe has taken them and the guard
    // cannot put them back, the run stops here, naming them, rather than
    // running without gmail or conduit and reporting success.
    const missingServers = this.missingJobMcpServers(job);
    if (missingServers.length > 0) {
      const reason = `MCP server(s) the job needs are configured nowhere: ${missingServers.join(", ")}. Check ~/.claude.json and the job's own server list.`;
      const run: JobRun = {
        id: uuidv4(),
        jobId: job.id,
        sessionId: "",
        status: "failure",
        startedAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 0,
        error: reason,
        toolsUsed: [],
        messageCount: 0,
        prompt: job.prompt,
        cwd: job.cwd || "",
        configFailure: true,
      };
      saveRun(run);
      logDiag(job.id, "job:config-failure", { runId: run.id, missingServers, error: reason });
      addInboxMessage({
        title: `Job failed: ${job.name}`,
        body: `**Status:** failure\n\n${reason}`,
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

  /** Start the jobs that were waiting on `finished` and now have everything
   *  they wait on. One still waiting on another job keeps waiting. */
  private startJobsWaitingOn(finished: ScheduledJob): void {
    for (const job of loadJobs()) {
      if (!job.enabled || this.isBusy(job.id)) continue;
      const waitsOnFinished = getJobSchedules(job).some((s) => s.type === "afterJobs" && s.jobIds.includes(finished.id));
      if (!waitsOnFinished || !dependenciesMet(job, (id) => this.isBusy(id))) continue;
      logDiag(job.id, "job:dependencies-met", { after: finished.id });
      console.log(`[scheduler] starting job ${job.name}: the jobs it waits on have completed`);
      this.lastFiredAt.set(job.id, new Date());
      this.executeJobWithRetries(job).catch((err) => {
        console.error(`[scheduler] failed to execute job ${job.name} after the jobs it waits on:`, err);
      });
    }
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

    // The CLI resets its user config from defaults after a single unparseable
    // read, and that silently strips the MCP servers a job runs with. The check
    // is one local JSON file, but there is no point doing it every minute.
    if (nowMs - this.lastConfigCheckAt >= 5 * 60_000) {
      this.lastConfigCheckAt = nowMs;
      try {
        checkClaudeUserConfig();
      } catch (err) {
        logDiag("config-guard", "check-failed", { error: String(err) });
      }
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
    const notDue: ScheduledJob[] = [];

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.runningJobs.has(job.id)) continue;

      const lastFired = this.lastFiredAt.get(job.id);
      // A job that has never run counts missed times from when it was last
      // saved. With nothing to measure from, one whose time always passes
      // while the server is down would never run at all.
      const missedSince = lastFired ?? new Date(job.updatedAt || job.createdAt);
      let shouldFire = false;

      for (const sched of getJobSchedules(job)) {
        if (!isTimeBasedSchedule(sched)) continue; // event-triggered; handled apart from the clock
        const cronExpr = scheduleToCron(sched);
        if (matchesCron(cronExpr, now)) {
          if (!lastFired || lastFired.getTime() < now.getTime()) {
            shouldFire = true;
            break;
          }
        } else if (findMissedRun(cronExpr, missedSince, now)) {
          if (!job.skipIfMissed) {
            shouldFire = true;
            break;
          }
        }
      }

      if (!shouldFire) {
        notDue.push(job);
        continue;
      }
      this.lastFiredAt.set(job.id, now);
      this.executeJobWithRetries(job).catch((err) => {
        console.error(`[scheduler] failed to execute job ${job.name}:`, err);
      });
    }

    // A job waiting on others is normally started the moment its last one
    // succeeds; checked here too for one missed then. Checked after the clock's
    // starts, so a job it waits on that is due this minute counts as busy.
    for (const job of notDue) {
      if (this.isBusy(job.id) || !dependenciesMet(job, (id) => this.isBusy(id))) continue;
      this.lastFiredAt.set(job.id, now);
      this.executeJobWithRetries(job).catch((err) => {
        console.error(`[scheduler] failed to execute job ${job.name}:`, err);
      });
    }
  }

  /**
   * Phase 4 (docs/internal/issue-tracker-spec.md): saveIssue emits whenever an
   * issue's status changes, including a brand new issue arriving in its
   * initial status. Mirrors tick()'s own job scan (enabled, not already
   * running) but matches against the event instead of the clock.
   */
  private handleIssueStatusChange(event: IssueStatusChangeEvent): void {
    // A project with a workflow has its issues worked by the workflow engine. A
    // job left over from before would work the same issue a second time.
    if (projectRunsWorkflow(event.projectId)) return;
    const jobs = loadJobs();
    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.runningJobs.has(job.id)) continue;

      const sched = getJobSchedules(job).find(
        (s): s is IssueStatusSchedule =>
          s.type === "onIssueStatus" && s.status === event.to && (!s.project || s.project === event.projectId),
      );
      if (!sched) continue;

      this.runIssueTriggeredJob(job, sched).catch((err) => {
        console.error(`[scheduler] failed to execute job ${job.name} on issue status change:`, err);
      });
    }
  }

  /**
   * The pipeline skills process one issue per run. If a second issue enters
   * the watched status while the first run is in flight, the job-lock
   * swallows its event and that issue would sit forever — so after the run
   * completes, re-check for remaining matches and trigger again. Bounded by
   * construction: `after` must be strictly less than `before` to keep
   * draining, and both are non-negative integers, so this cannot loop forever
   * even if the job fails or refuses to process the issue on every attempt —
   * it just stops on the first run that doesn't make progress.
   */
  private async runIssueTriggeredJob(job: ScheduledJob, sched: IssueStatusSchedule): Promise<void> {
    let before = countMatchingIssues(sched);
    for (;;) {
      await this.executeJobWithRetries(job);
      const after = countMatchingIssues(sched);
      if (after === 0) return; // drained
      if (after >= before) {
        logDiag(job.id, "job:drain-stalled", { status: sched.status, project: sched.project, before, after });
        console.log(`[scheduler] job ${job.name} drain stalled: ${before} -> ${after} issue(s) still in "${sched.status}"`);
        return;
      }
      before = after;
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
    // The CLI's trust dialog is one cockpit cannot answer — it would type the
    // prompt into it and die, reporting only "went idle without producing any
    // assistant message". A job runs unattended, so there is nobody to answer
    // it either: whichever directory the job's author pointed it at, that
    // choice is the trust decision, and it is a smaller grant than the agent
    // and tools they already scheduled to run there.
    if (trustDirectory(jobCwd)) {
      logDiag(job.id, "job:scratchpad-trusted", { runId, cwd: jobCwd });
    }
    const { done } = startAgentRun<JobRun>(this.sessionManager, {
      log: { prefix: "job", fields: { jobId: job.id, runId } },
      cwd: jobCwd,
      sessionName: `[job] ${job.name}`,
      prompt: buildJobPrompt(job),
      session: {
        bypassPermissions: !!job.bypassPermissions,
        // The job's own switch, never the session default: a default switched on
        // for interactive work must not reach a job whose author left it off.
        // Its storage folder travels with it, so a sandboxed run can write the
        // state its prompt tells it to keep there.
        sandbox: { enabled: job.sandbox === true, jobStorageDir: getJobScratchpadDir(job.id) },
        runtime: job.runtime,
        // Only an inbox-reporting job gets a run context, and with it the job
        // caller's confinement on the cockpit MCP server.
        ...(job.inboxOutput ? { runContext: { jobId: job.id, jobName: job.name, runId, notifyProviders: job.notifyProviders } } : {}),
      },
      model: job.model,
      contextSize: job.contextSize,
      thinkingLevel: job.thinkingLevel,
      permissions: job.bypassPermissions
        ? { kind: "bypass" }
        : { kind: "allowlist", allowedTools: job.allowedTools || [], mcpToolFilters: job.mcpToolFilters, inboxTool: !!job.inboxOutput },
      mcpServers: job.mcpServers || [],
      maxDurationMinutes: job.maxDurationMinutes || 30,
      record: (session) => ({
        id: runId,
        jobId: job.id,
        sessionId: session.id,
        status: "running",
        startedAt: Date.now(),
        toolsUsed: [],
        messageCount: 0,
        prompt: job.prompt,
        cwd: jobCwd,
      }),
      save: saveRun,
      started: (run, settle) => {
        this.runningJobs.set(job.id, run);
        this.jobResolvers.set(job.id, settle);
      },
      ended: (run) => {
        // A `failure` alert is suppressed on attempts that will be retried (the retry
        // wrapper passes suppressFailureAlert); the final attempt still alerts. A
        // `timeout` is terminal and never retried, so it always alerts.
        if (run.status === "timeout" || (run.status === "failure" && !opts?.suppressFailureAlert)) {
          addInboxMessage({
            title: `Job failed: ${job.name}`,
            body: `**Status:** ${run.status}\n\n${run.error || "Job failed with no error message"}`,
            priority: "error",
            jobId: job.id,
            jobName: job.name,
            runId: run.id,
            notifyProviders: job.notifyProviders,
          });
        }
      },
      released: () => {
        this.runningJobs.delete(job.id);
        releaseJobLock(job.id);
        this.jobResolvers.delete(job.id);
      },
      stopped: () => {
        this.jobResolvers.delete(job.id);
      },
    });
    return done;
  }
}
