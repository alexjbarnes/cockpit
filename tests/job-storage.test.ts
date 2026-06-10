// Unit tests for the file-based job/run store. Exercises the CRUD and run
// functions against a real tmpdir via COCKPIT_CONFIG_DIR (getCockpitDir reads
// the env var per call, so no fs mocking is needed). The legacy [1m] model
// migration on read is covered separately in job-storage-context.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteJob,
  getJob,
  getLatestRun,
  getRecentFailureCount,
  getRun,
  loadJobs,
  loadRuns,
  pruneAllRuns,
  saveJob,
  saveRun,
} from "@/server/job-storage";
import type { JobRun, JobRunStatus, ScheduledJob } from "@/types";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-jobstore-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeJob(id: string, overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id,
    name: `job ${id}`,
    schedule: { type: "simple", frequency: "daily" },
    prompt: "do the thing",
    cwd: "/tmp/work",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRun(jobId: string, id: string, overrides: Partial<JobRun> = {}): JobRun {
  return {
    id,
    jobId,
    sessionId: `sess-${id}`,
    status: "success" as JobRunStatus,
    // Recent by default: saveRun prunes runs older than the job's retention
    // (90 days when no job exists), so ancient timestamps would vanish on write.
    startedAt: Date.now(),
    toolsUsed: [],
    messageCount: 0,
    prompt: "do the thing",
    cwd: "/tmp/work",
    ...overrides,
  };
}

describe("job CRUD", () => {
  it("returns [] when no jobs file exists", () => {
    expect(loadJobs()).toEqual([]);
    expect(getJob("nope")).toBeUndefined();
  });

  it("saveJob inserts a new job and getJob/loadJobs read it back", () => {
    saveJob(makeJob("a"));
    expect(loadJobs()).toHaveLength(1);
    expect(getJob("a")?.name).toBe("job a");
  });

  it("saveJob updates an existing job in place (no duplicate)", () => {
    saveJob(makeJob("a"));
    saveJob(makeJob("a", { name: "renamed" }));
    const jobs = loadJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("renamed");
  });

  it("saveJob appends additional jobs", () => {
    saveJob(makeJob("a"));
    saveJob(makeJob("b"));
    expect(
      loadJobs()
        .map((j) => j.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("deleteJob removes an existing job and returns true", () => {
    saveJob(makeJob("a"));
    saveJob(makeJob("b"));
    expect(deleteJob("a")).toBe(true);
    expect(loadJobs().map((j) => j.id)).toEqual(["b"]);
  });

  it("deleteJob returns false for an unknown id", () => {
    saveJob(makeJob("a"));
    expect(deleteJob("ghost")).toBe(false);
    expect(loadJobs()).toHaveLength(1);
  });

  it("deleteJob also removes the job's runs file", () => {
    saveJob(makeJob("a"));
    saveRun(makeRun("a", "r1"));
    expect(loadRuns("a")).toHaveLength(1);
    deleteJob("a");
    expect(loadRuns("a")).toEqual([]);
  });
});

describe("run CRUD", () => {
  it("returns [] when no runs file exists", () => {
    expect(loadRuns("a")).toEqual([]);
    expect(getRun("a", "r1")).toBeUndefined();
  });

  it("saveRun inserts and getRun reads it back", () => {
    saveRun(makeRun("a", "r1"));
    expect(loadRuns("a")).toHaveLength(1);
    expect(getRun("a", "r1")?.sessionId).toBe("sess-r1");
  });

  it("saveRun updates an existing run in place", () => {
    saveRun(makeRun("a", "r1", { status: "running" }));
    saveRun(makeRun("a", "r1", { status: "success" }));
    const runs = loadRuns("a");
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
  });

  it("saveRun with stopped status round-trips", () => {
    saveRun(makeRun("a", "r-stopped", { status: "stopped", error: "Stopped by user" }));
    const runs = loadRuns("a");
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("stopped");
    expect(runs[0].error).toBe("Stopped by user");
  });
});

describe("getLatestRun", () => {
  it("returns undefined when there are no runs", () => {
    expect(getLatestRun("a")).toBeUndefined();
  });

  it("returns the run with the greatest startedAt", () => {
    const now = Date.now();
    saveRun(makeRun("a", "old", { startedAt: now - 3_000 }));
    saveRun(makeRun("a", "new", { startedAt: now }));
    saveRun(makeRun("a", "mid", { startedAt: now - 1_000 }));
    expect(getLatestRun("a")?.id).toBe("new");
  });
});

describe("getRecentFailureCount", () => {
  it("counts jobs whose latest run failed or timed out", () => {
    saveJob(makeJob("ok"));
    saveJob(makeJob("failed"));
    saveJob(makeJob("timed"));
    saveJob(makeJob("norun"));

    const now = Date.now();
    saveRun(makeRun("ok", "r", { status: "success", startedAt: now }));
    saveRun(makeRun("failed", "r", { status: "failure", startedAt: now }));
    saveRun(makeRun("timed", "r", { status: "timeout", startedAt: now }));
    // "norun" has no runs and must not count.

    expect(getRecentFailureCount()).toBe(2);
  });

  it("only considers the latest run per job", () => {
    const now = Date.now();
    saveJob(makeJob("j"));
    saveRun(makeRun("j", "older", { status: "failure", startedAt: now - 10_000 }));
    saveRun(makeRun("j", "newer", { status: "success", startedAt: now }));
    expect(getRecentFailureCount()).toBe(0);
  });

  it("does not count stopped runs as failures", () => {
    const now = Date.now();
    saveJob(makeJob("stopped-job"));
    saveRun(makeRun("stopped-job", "r", { status: "stopped", startedAt: now }));
    expect(getRecentFailureCount()).toBe(0);
  });
});

describe("pruneAllRuns", () => {
  it("drops runs older than the job's retentionDays", () => {
    const now = Date.now();
    // Save both runs while retention is long so saveRun's own prune keeps them,
    // then shorten retention and let pruneAllRuns drop the stale one.
    saveJob(makeJob("a", { retentionDays: 90 }));
    saveRun(makeRun("a", "fresh", { startedAt: now }));
    saveRun(makeRun("a", "stale", { startedAt: now - 30 * 24 * 60 * 60 * 1000 }));
    expect(loadRuns("a")).toHaveLength(2);

    saveJob(makeJob("a", { retentionDays: 7 }));
    pruneAllRuns();

    const ids = loadRuns("a").map((r) => r.id);
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("stale");
  });

  it("keeps runs within the retention window", () => {
    saveJob(makeJob("a", { retentionDays: 90 }));
    const now = Date.now();
    saveRun(makeRun("a", "recent", { startedAt: now - 1000 }));
    pruneAllRuns();
    expect(loadRuns("a").map((r) => r.id)).toEqual(["recent"]);
  });
});
