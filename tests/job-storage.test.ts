// Unit tests for the file-based job/run store. Exercises the CRUD and run
// functions against a real tmpdir via COCKPIT_CONFIG_DIR (getCockpitDir reads
// the env var per call, so no fs mocking is needed). The legacy [1m] model
// migration on read is covered separately in job-storage-context.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProject, saveProject } from "@/server/issue-storage";
import {
  deleteJob,
  getJob,
  getJobSessionIds,
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
    schedules: [{ type: "simple", frequency: "daily" }],
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

describe("getJobSessionIds", () => {
  it("collects sessionIds across all job run files", () => {
    saveRun(makeRun("job-1", "r1", { sessionId: "sess-a" }));
    saveRun(makeRun("job-1", "r2", { sessionId: "sess-b" }));
    saveRun(makeRun("job-2", "r3", { sessionId: "sess-c" }));
    expect([...getJobSessionIds()].sort()).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  it("returns an empty set when no runs exist", () => {
    expect(getJobSessionIds().size).toBe(0);
  });

  it("skips runs without a sessionId, non-json files, and unreadable files", () => {
    const dirRuns = path.join(dir, "job-runs");
    mkdirSync(dirRuns, { recursive: true });
    writeFileSync(
      path.join(dirRuns, "job-x.json"),
      JSON.stringify({
        runs: [
          { id: "r1", jobId: "job-x" },
          { id: "r2", jobId: "job-x", sessionId: "sess-x" },
        ],
      }),
    );
    writeFileSync(path.join(dirRuns, "notes.txt"), "ignore me");
    writeFileSync(path.join(dirRuns, "broken.json"), "{not valid json");
    expect([...getJobSessionIds()]).toEqual(["sess-x"]);
  });
});

describe("legacy `schedule` migration on read", () => {
  function writeRawJobsFile(jobs: unknown[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "scheduled-jobs.json"), JSON.stringify({ jobs }));
  }

  it("fills schedules from a pre-migration job that only has the old singular schedule field", () => {
    writeRawJobsFile([
      {
        id: "legacy-1",
        name: "legacy job",
        schedule: { type: "simple", frequency: "daily", time: "02:00" },
        prompt: "do the thing",
        cwd: "/tmp/work",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const job = getJob("legacy-1")!;
    expect(job.schedules).toEqual([{ type: "simple", frequency: "daily", time: "02:00" }]);
    expect(job).not.toHaveProperty("schedule");
  });

  it("prefers the already-migrated schedules array when both fields are present on disk", () => {
    writeRawJobsFile([
      {
        id: "legacy-2",
        name: "legacy job",
        schedule: { type: "simple", frequency: "daily", time: "02:00" },
        schedules: [{ type: "simple", frequency: "daily", time: "05:00" }],
        prompt: "do the thing",
        cwd: "/tmp/work",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const job = getJob("legacy-2")!;
    expect(job.schedules).toEqual([{ type: "simple", frequency: "daily", time: "05:00" }]);
  });

  it("saving a migrated job persists the new shape, so migration self-heals the file over time", () => {
    writeRawJobsFile([
      {
        id: "legacy-3",
        name: "legacy job",
        schedule: { type: "simple", frequency: "daily", time: "02:00" },
        prompt: "do the thing",
        cwd: "/tmp/work",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    saveJob(getJob("legacy-3")!);
    const onDisk = JSON.parse(readFileSync(path.join(dir, "scheduled-jobs.json"), "utf-8"));
    expect(onDisk.jobs[0].schedules).toEqual([{ type: "simple", frequency: "daily", time: "02:00" }]);
    expect(onDisk.jobs[0]).not.toHaveProperty("schedule");
  });
});

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

  it("deleteJob removes the job's scratchpad, state files and all", () => {
    const pad = path.join(dir, "jobs", "a");
    mkdirSync(path.join(pad, "nested"), { recursive: true });
    writeFileSync(path.join(pad, "state.json"), '{"suggested":[]}');
    writeFileSync(path.join(pad, "nested", "cache.txt"), "x");
    saveJob(makeJob("a"));

    deleteJob("a");
    expect(existsSync(pad)).toBe(false);
  });

  it("deleteJob leaves other jobs' scratchpads alone", () => {
    const keep = path.join(dir, "jobs", "b");
    mkdirSync(keep, { recursive: true });
    writeFileSync(path.join(keep, "state.json"), "{}");
    saveJob(makeJob("a"));
    saveJob(makeJob("b"));

    deleteJob("a");
    expect(existsSync(keep)).toBe(true);
  });

  it("deleteJob copes with a job that never wrote a scratchpad", () => {
    saveJob(makeJob("a"));
    expect(existsSync(path.join(dir, "jobs", "a"))).toBe(false);
    expect(deleteJob("a")).toBe(true);
  });

  it("deleteJob does not touch the scratchpad when the job is unknown", () => {
    const pad = path.join(dir, "jobs", "ghost");
    mkdirSync(pad, { recursive: true });
    expect(deleteJob("ghost")).toBe(false);
    expect(existsSync(pad)).toBe(true);
  });

  it("deleteJob cannot escape the scratchpad root via a traversing id", () => {
    // The id would resolve to <config>/jobs/../.. and take the tmpdir with it.
    const traversingId = "../..";
    const sibling = path.join(dir, "scheduled-jobs.json");
    saveJob({ ...makeJob("a"), id: traversingId });
    expect(deleteJob(traversingId)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });
});

describe("saveJob: onIssueStatus schedule validation (phase 4, storage boundary)", () => {
  // saveJob is the one function every job write funnels through (REST's PUT
  // route and the MCP update_job tool both bypass buildJob entirely with a
  // raw field spread), so this is where an onIssueStatus schedule's shape has
  // to be caught — see job-storage.ts's assertValidSchedules comment.

  it("accepts an onIssueStatus schedule with a valid status and no project", () => {
    const job = makeJob("a", { schedules: [{ type: "onIssueStatus", status: "Backlog" }] });
    expect(() => saveJob(job)).not.toThrow();
    expect(getJob("a")?.schedules).toEqual([{ type: "onIssueStatus", status: "Backlog" }]);
  });

  it("accepts an onIssueStatus schedule whose project id names a real project", () => {
    const project = buildProject({ name: "Cockpit", prefix: "CK" });
    saveProject(project);
    const job = makeJob("a", { schedules: [{ type: "onIssueStatus", status: "Backlog", project: project.id }] });
    expect(() => saveJob(job)).not.toThrow();
  });

  it("rejects an onIssueStatus schedule with a status outside ISSUE_STATUSES", () => {
    const job = makeJob("a", {
      // @ts-expect-error deliberately invalid status, mirroring an unvalidated REST/MCP payload
      schedules: [{ type: "onIssueStatus", status: "Definitely Not A Status" }],
    });
    expect(() => saveJob(job)).toThrow(/invalid status/i);
    expect(loadJobs()).toEqual([]); // rejected write never reaches disk
  });

  it("rejects an onIssueStatus schedule whose project does not name a real project", () => {
    const job = makeJob("a", { schedules: [{ type: "onIssueStatus", status: "Backlog", project: "no-such-project" }] });
    expect(() => saveJob(job)).toThrow(/unknown project/i);
    expect(loadJobs()).toEqual([]);
  });

  it("rejects a cron schedule whose expression is nonsense (would silently never fire)", () => {
    for (const expression of ["not a cron expression", "banana * * * *", "61 * * * *", "* * *", ""]) {
      const job = makeJob("a", { schedules: [{ type: "cron", expression }] });
      expect(() => saveJob(job), `expression: "${expression}"`).toThrow();
    }
    expect(loadJobs()).toEqual([]);
  });

  it("accepts well-formed cron expressions", () => {
    for (const expression of ["0 9 * * 1", "*/15 * * * *", "30 6 1 * *"]) {
      const job = makeJob(`ok-${expression}`, { schedules: [{ type: "cron", expression }] });
      expect(() => saveJob(job)).not.toThrow();
    }
  });

  it("rejects a simple schedule with a bogus frequency, time, dayOfWeek or dayOfMonth", () => {
    const cases: Array<Record<string, unknown>> = [
      { type: "simple", frequency: "fortnightly" },
      { type: "simple", frequency: "daily", time: "25:00" },
      { type: "simple", frequency: "daily", time: "9am" },
      { type: "simple", frequency: "weekly", dayOfWeek: 7 },
      { type: "simple", frequency: "monthly", dayOfMonth: 32 },
    ];
    for (const schedule of cases) {
      const job = makeJob("a", { schedules: [schedule as never] });
      expect(() => saveJob(job), JSON.stringify(schedule)).toThrow();
    }
    expect(loadJobs()).toEqual([]);
  });

  it("accepts valid simple schedules of every frequency", () => {
    const cases = [
      { type: "simple", frequency: "hourly" },
      { type: "simple", frequency: "daily", time: "09:30" },
      { type: "simple", frequency: "weekly", dayOfWeek: 0, time: "8:00" },
      { type: "simple", frequency: "monthly", dayOfMonth: 31 },
    ] as never[];
    for (const [i, schedule] of cases.entries()) {
      expect(() => saveJob(makeJob(`s-${i}`, { schedules: [schedule] }))).not.toThrow();
    }
  });

  it("rejects a schedule with an unknown type", () => {
    const job = makeJob("a", { schedules: [{ type: "yearly" } as never] });
    expect(() => saveJob(job)).toThrow(/unknown type/i);
  });

  it("does not persist a job at all when its onIssueStatus schedule is invalid", () => {
    saveJob(makeJob("keep")); // a pre-existing valid job
    const bad = makeJob("bad", { schedules: [{ type: "onIssueStatus", status: "Backlog", project: "ghost" }] });
    expect(() => saveJob(bad)).toThrow();
    expect(loadJobs().map((j) => j.id)).toEqual(["keep"]);
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
