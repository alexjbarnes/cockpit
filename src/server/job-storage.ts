import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { splitLegacyModel } from "@/lib/models";
import { getProject } from "@/server/issue-storage";
import { getCockpitDir, getJobsScratchpadRoot } from "@/server/paths";
import type { JobRun, JobSchedule, ScheduledJob } from "@/types";
import { ISSUE_STATUSES } from "@/types";

/** Everything a caller may supply when creating a job. */
export type JobInput = Partial<Omit<ScheduledJob, "id" | "createdAt" | "updatedAt">>;

/**
 * Build a stored job from caller input, applying the defaults it needs to be
 * safe to run.
 *
 * Shared because the two creation paths had silently drifted. The REST route
 * assigned all nineteen fields; the MCP create_job tool advertised the same
 * nineteen in its schema and assigned five, so a job the assistant created came
 * out with no tool access, no inbox output and no notification providers, and
 * nothing said so. Anything that creates a job goes through here.
 */
export function buildJob(input: JobInput): ScheduledJob {
  const now = Date.now();
  return {
    id: randomUUID(),
    name: input.name ?? "",
    schedules: input.schedules ?? [],
    prompt: input.prompt ?? "",
    cwd: input.cwd || "",
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
    model: input.model,
    contextSize: input.contextSize,
    thinkingLevel: input.thinkingLevel,
    allowedTools: input.allowedTools,
    mcpServers: input.mcpServers,
    mcpToolFilters: input.mcpToolFilters,
    bypassPermissions: input.bypassPermissions ?? false,
    maxDurationMinutes: input.maxDurationMinutes ?? 30,
    maxRetries: input.maxRetries,
    retentionDays: input.retentionDays ?? 90,
    skipIfMissed: input.skipIfMissed ?? false,
    inboxOutput: input.inboxOutput ?? false,
    notifyProviders: input.notifyProviders,
    runtime: input.runtime,
  };
}

function prefsDir(): string {
  return getCockpitDir();
}
function jobsFile(): string {
  return join(prefsDir(), "scheduled-jobs.json");
}
function runsDir(): string {
  return join(prefsDir(), "job-runs");
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function runsFile(jobId: string): string {
  return join(runsDir(), `${jobId}.json`);
}

// Pre-deprecation on-disk shape: some jobs may still carry the old singular
// `schedule` field instead of (or in addition to, if written by code from
// before the two were fully unified) `schedules`.
type LegacyJobShape = ScheduledJob & { schedule?: JobSchedule };

function normalizeJob(raw: LegacyJobShape): ScheduledJob {
  let job: LegacyJobShape = raw;
  if (job.model?.includes("[")) {
    const split = splitLegacyModel(job.model);
    job = { ...job, model: split.model, contextSize: job.contextSize ?? split.contextSize };
  }
  if (!job.schedules?.length && job.schedule) {
    job = { ...job, schedules: [job.schedule] };
  }
  const { schedule: _legacySchedule, ...normalized } = job;
  return normalized;
}

export function loadJobs(): ScheduledJob[] {
  try {
    const data = JSON.parse(readFileSync(jobsFile(), "utf-8"));
    const jobs: ScheduledJob[] = data.jobs || [];
    return jobs.map(normalizeJob);
  } catch {
    return [];
  }
}

export function getJob(id: string): ScheduledJob | undefined {
  return loadJobs().find((j) => j.id === id);
}

/**
 * Reject an onIssueStatus schedule with a bogus status or an unknown project.
 * saveJob() is the one function every job write funnels through: the REST
 * POST route builds via buildJob() first, but PUT does a raw
 * `{...existing, ...body}` spread with no construction path at all, and the
 * MCP update_job tool's own field-picking (cockpit-config-server.ts) only
 * controls which keys survive an update, never whether their values are any
 * good. Validating in buildJob() alone would miss both of those, so this
 * lives at the actual write boundary instead — the same lesson
 * issue-storage.ts already paid for once (see its "Value validation" comment
 * and commit 2857515).
 *
 * Deliberately scoped to only the new onIssueStatus shape: simple/cron
 * schedules — and every other job field — have never been validated on this
 * path and stay that way; fixing that generally is a separate, larger change.
 */
function assertValidSchedules(schedules: JobSchedule[] | undefined): void {
  for (const s of schedules ?? []) {
    if (s.type !== "onIssueStatus") continue;
    if (!(ISSUE_STATUSES as readonly string[]).includes(s.status)) {
      throw new Error(`onIssueStatus schedule has an invalid status "${s.status}"; must be one of: ${ISSUE_STATUSES.join(", ")}`);
    }
    if (s.project !== undefined && !getProject(s.project)) {
      throw new Error(`onIssueStatus schedule references unknown project "${s.project}"`);
    }
  }
}

export function saveJob(job: ScheduledJob): void {
  assertValidSchedules(job.schedules);
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.push(job);
  }
  ensureDir(prefsDir());
  writeFileSync(jobsFile(), JSON.stringify({ jobs }, null, 2) + "\n");
}

/**
 * Remove a job's scratchpad, the directory it persisted state between runs in.
 * Deleting a job used to leave it behind, so `~/.cockpit/jobs` accumulated
 * orphan directories with no job left to explain them.
 *
 * `id` has already been matched against a stored job by the time this runs, so
 * it is one cockpit generated. The containment check is belt and braces so a
 * crafted id could never resolve outside the scratchpad root and take an
 * unrelated directory with it.
 */
function deleteJobScratchpad(id: string): void {
  const root = resolve(getJobsScratchpadRoot());
  const dir = resolve(root, id);
  if (dir === root || !dir.startsWith(root + sep)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export function deleteJob(id: string): boolean {
  const jobs = loadJobs();
  const filtered = jobs.filter((j) => j.id !== id);
  if (filtered.length === jobs.length) return false;
  ensureDir(prefsDir());
  writeFileSync(jobsFile(), JSON.stringify({ jobs: filtered }, null, 2) + "\n");

  const rf = runsFile(id);
  try {
    if (existsSync(rf)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(rf);
    }
  } catch {}

  deleteJobScratchpad(id);

  return true;
}

export function loadRuns(jobId: string): JobRun[] {
  try {
    const data = JSON.parse(readFileSync(runsFile(jobId), "utf-8"));
    return data.runs || [];
  } catch {
    return [];
  }
}

export function getRun(jobId: string, runId: string): JobRun | undefined {
  return loadRuns(jobId).find((r) => r.id === runId);
}

/**
 * Every session id recorded across all job runs. Used to hide scheduled-job
 * sessions from the all-sessions feed: a job spawns a real CLI session whose
 * transcript lands in the project dir like any other, so the run's recorded
 * sessionId (which equals the transcript filename) is the only reliable join.
 * A session reappears in the feed if its run record is pruned by retention.
 */
export function getJobSessionIds(): Set<string> {
  const ids = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(runsDir());
  } catch {
    return ids; // no runs dir yet
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(runsDir(), file), "utf-8"));
      for (const run of data.runs || []) {
        if (run.sessionId) ids.add(run.sessionId);
      }
    } catch {
      // skip unreadable/corrupt run files
    }
  }
  return ids;
}

export function saveRun(run: JobRun): void {
  const runs = loadRuns(run.jobId);
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx >= 0) {
    runs[idx] = run;
  } else {
    runs.push(run);
  }

  const job = getJob(run.jobId);
  const maxAgeDays = job?.retentionDays ?? 90;
  pruneRuns(runs, 500, maxAgeDays);

  ensureDir(runsDir());
  writeFileSync(runsFile(run.jobId), JSON.stringify({ runs }, null, 2) + "\n");
}

function pruneRuns(runs: JobRun[], maxCount: number, maxAgeDays: number): void {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].startedAt < cutoff) {
      runs.splice(i, 1);
    }
  }

  if (runs.length > maxCount) {
    runs.sort((a, b) => b.startedAt - a.startedAt);
    runs.length = maxCount;
  }
}

export function pruneAllRuns(): void {
  const jobs = loadJobs();
  for (const job of jobs) {
    const runs = loadRuns(job.id);
    const before = runs.length;
    pruneRuns(runs, 500, job.retentionDays ?? 90);
    if (runs.length < before) {
      ensureDir(runsDir());
      writeFileSync(runsFile(job.id), JSON.stringify({ runs }, null, 2) + "\n");
    }
  }
}

export function getLatestRun(jobId: string): JobRun | undefined {
  const runs = loadRuns(jobId);
  if (runs.length === 0) return undefined;
  return runs.reduce((latest, r) => (r.startedAt > latest.startedAt ? r : latest));
}

export function getRecentFailureCount(): number {
  const jobs = loadJobs();
  let count = 0;
  for (const job of jobs) {
    const latest = getLatestRun(job.id);
    if (latest && (latest.status === "failure" || latest.status === "timeout")) {
      count++;
    }
  }
  return count;
}
