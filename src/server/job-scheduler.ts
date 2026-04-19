import { v4 as uuidv4 } from "uuid";
import type { JobRun, JobRunToolUse, ScheduledJob } from "@/types";
import { findMissedRun, matchesCron, scheduleToCron } from "./cron-utils";
import { getLatestRun, loadJobs, saveRun } from "./job-storage";
import type { SessionManager } from "./session-manager";

export class JobScheduler {
  private sessionManager: SessionManager;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFiredAt = new Map<string, Date>();
  private runningJobs = new Map<string, JobRun>();

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
    const jobs = loadJobs();
    for (const job of jobs) {
      const latest = getLatestRun(job.id);
      if (latest) {
        this.lastFiredAt.set(job.id, new Date(latest.startedAt));
        if (latest.status === "running") {
          latest.status = "failure";
          latest.error = "Server restarted while job was running";
          latest.completedAt = Date.now();
          latest.durationMs = latest.completedAt - latest.startedAt;
          saveRun(latest);
        }
      }
    }
  }

  private tick(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    const jobs = loadJobs();

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (this.runningJobs.has(job.id)) continue;

      const cronExpr = scheduleToCron(job.schedule);
      const lastFired = this.lastFiredAt.get(job.id);

      let shouldFire = false;

      if (matchesCron(cronExpr, now)) {
        if (!lastFired || lastFired.getTime() < now.getTime()) {
          shouldFire = true;
        }
      } else if (lastFired && findMissedRun(cronExpr, lastFired, now)) {
        if (job.skipIfMissed) continue;
        shouldFire = true;
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
    const sessionInfo = this.sessionManager.createSession(job.cwd, `[job] ${job.name}`);
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
      cwd: job.cwd,
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
        if (!job.bypassPermissions) {
          const toolName = event.toolName || "unknown";
          let allowed = true;
          if (job.allowedTools && job.allowedTools.length > 0) {
            allowed = job.allowedTools.includes(toolName);
          }
          this.sessionManager.respondToPermission(sessionId, event.requestId, allowed);

          const permEntry: JobRunToolUse = {
            name: toolName,
            input: event.toolInput || "",
            output: "",
            timestamp: Date.now(),
            permitted: allowed,
          };
          run.toolsUsed.push(permEntry);
        }
      }
    });

    const initCleanup = job.mcpServers?.length
      ? this.sessionManager.onInit(sessionId, (initData) => {
          if (!job.mcpServers || job.mcpServers.length === 0) return;
          for (const server of initData.mcpServers) {
            if (!job.mcpServers.includes(server.name)) {
              this.sessionManager.mcpToggle(sessionId, server.name, false).catch(() => {});
            }
          }
        })
      : null;

    if (job.model) {
      this.sessionManager.setModel(sessionId, job.model);
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

        saveRun(run);
        this.runningJobs.delete(job.id);
        resolve(run);
      };

      this.sessionManager.sendMessage(sessionId, job.prompt);
    });
  }
}
