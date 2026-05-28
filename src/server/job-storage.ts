import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobRun, ScheduledJob } from "@/types";
import { splitLegacyModel } from "@/lib/models";

const PREFS_DIR = join(homedir(), ".cockpit");
const JOBS_FILE = join(PREFS_DIR, "scheduled-jobs.json");
const RUNS_DIR = join(PREFS_DIR, "job-runs");

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function runsFile(jobId: string): string {
  return join(RUNS_DIR, `${jobId}.json`);
}

function normalizeJob(raw: ScheduledJob): ScheduledJob {
  if (raw.model && raw.model.includes("[")) {
    const split = splitLegacyModel(raw.model);
    return { ...raw, model: split.model, contextSize: raw.contextSize ?? split.contextSize };
  }
  return raw;
}

export function loadJobs(): ScheduledJob[] {
  try {
    const data = JSON.parse(readFileSync(JOBS_FILE, "utf-8"));
    const jobs: ScheduledJob[] = data.jobs || [];
    return jobs.map(normalizeJob);
  } catch {
    return [];
  }
}

export function getJob(id: string): ScheduledJob | undefined {
  return loadJobs().find((j) => j.id === id);
}

export function saveJob(job: ScheduledJob): void {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = job;
  } else {
    jobs.push(job);
  }
  ensureDir(PREFS_DIR);
  writeFileSync(JOBS_FILE, JSON.stringify({ jobs }, null, 2) + "\n");
}

export function deleteJob(id: string): boolean {
  const jobs = loadJobs();
  const filtered = jobs.filter((j) => j.id !== id);
  if (filtered.length === jobs.length) return false;
  ensureDir(PREFS_DIR);
  writeFileSync(JOBS_FILE, JSON.stringify({ jobs: filtered }, null, 2) + "\n");

  const rf = runsFile(id);
  try {
    if (existsSync(rf)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(rf);
    }
  } catch {}

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

  ensureDir(RUNS_DIR);
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
      ensureDir(RUNS_DIR);
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
