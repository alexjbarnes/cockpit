// A job with an After jobs schedule runs by itself once the job it waits on
// has completed, and the editor refuses waiting that loops back. It counts
// only runs that started after its own last start, and it does not start
// while a job it waits on is still running.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { JobRun } from "../../src/types";
import { textResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

test("a job waiting on another runs once that job completes", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-chain-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("Done.") }]);

    // Saved a minute ago, so only runs from now on count.
    const savedAt = Date.now() - 60_000;
    const base = {
      cwd: workDir,
      enabled: true,
      createdAt: savedAt,
      updatedAt: savedAt,
      bypassPermissions: false,
      maxDurationMinutes: 5,
      retentionDays: 90,
      skipIfMissed: true,
      inboxOutput: false,
      runtime: "pty",
    };
    const collect = {
      ...base,
      id: "job-collect",
      name: "Collect",
      // A time that is never now, so only the manual run below starts it.
      schedules: [{ type: "simple", frequency: "monthly", dayOfMonth: 31, time: "03:17" }],
      prompt: "Say collected.",
    };
    const report = {
      ...base,
      id: "job-report",
      name: "Report",
      schedules: [{ type: "afterJobs", jobIds: [collect.id] }],
      prompt: "Say reported.",
    };
    writeFileSync(path.join(harness.configDir, "scheduled-jobs.json"), JSON.stringify({ jobs: [collect, report] }, null, 2) + "\n");

    await page.goto(`${harness.cockpitUrl}/jobs`);
    await expect(page.getByText("After Collect").first()).toBeVisible({ timeout: 15_000 });

    // The editor refuses making Collect wait on Report, which waits on Collect.
    await page.goto(`${harness.cockpitUrl}/jobs/${collect.id}/edit`);
    await page.getByTestId("schedule-after-jobs").click();
    await expect(page.getByText("After Report")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("job-save-error")).toContainText("loop");

    const trigger = await page.request.post(`${harness.cockpitUrl}/api/jobs/${collect.id}/trigger`);
    expect(trigger.ok()).toBe(true);

    const latestStatus = async (jobId: string) => {
      const res = await page.request.get(`${harness.cockpitUrl}/api/jobs/${jobId}/runs`);
      const { runs } = (await res.json()) as { runs: { status: string }[] };
      return runs[0]?.status ?? "none";
    };
    await expect.poll(() => latestStatus(collect.id), { timeout: 90_000, intervals: [2_000] }).toBe("success");
    await expect.poll(() => latestStatus(report.id), { timeout: 90_000, intervals: [2_000] }).toBe("success");

    const prompts = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages");
    expect(prompts.some((r) => r.body.includes("Say reported."))).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

const QUICK = "job-quick";
const SLOW = "job-slow";
const FOLD = "job-fold";
const SLOW_PROMPT = "Collect the slow source.";

/**
 * Fold waits on Quick and Slow, and last started at foldStart. Each collect
 * job's last success is the one given, so a test sets up what Fold has
 * already seen.
 */
function seedFold(
  harness: Harness,
  workDir: string,
  foldStart: number,
  last: Record<"quick" | "slow", { startedAt: number; completedAt: number }>,
): void {
  const base = {
    cwd: workDir,
    enabled: true,
    createdAt: foldStart - 86_400_000,
    updatedAt: foldStart - 86_400_000,
    bypassPermissions: false,
    maxDurationMinutes: 5,
    retentionDays: 90,
    skipIfMissed: true,
    inboxOutput: false,
    runtime: "pty",
  };
  // A time that is never now, so only a manual run starts the collect jobs.
  const never = [{ type: "simple", frequency: "monthly", dayOfMonth: 31, time: "03:17" }];
  const jobs = [
    { ...base, id: QUICK, name: "Quick", schedules: never, prompt: "Collect the quick source." },
    { ...base, id: SLOW, name: "Slow", schedules: never, prompt: SLOW_PROMPT },
    { ...base, id: FOLD, name: "Fold", schedules: [{ type: "afterJobs", jobIds: [QUICK, SLOW] }], prompt: "Fold what was collected." },
  ];
  writeFileSync(path.join(harness.configDir, "scheduled-jobs.json"), JSON.stringify({ jobs }, null, 2) + "\n");

  const runsDir = path.join(harness.configDir, "job-runs");
  mkdirSync(runsDir, { recursive: true });
  const seeded = { [QUICK]: last.quick, [SLOW]: last.slow, [FOLD]: { startedAt: foldStart, completedAt: foldStart + 60_000 } };
  for (const [jobId, times] of Object.entries(seeded)) {
    const run: JobRun = {
      id: `${jobId}-seeded`,
      jobId,
      sessionId: "",
      status: "success",
      ...times,
      durationMs: times.completedAt - times.startedAt,
      toolsUsed: [],
      messageCount: 1,
      prompt: "",
      cwd: workDir,
    };
    writeFileSync(path.join(runsDir, `${jobId}.json`), JSON.stringify({ runs: [run] }, null, 2) + "\n");
  }
}

function jobRuns(page: Page, harness: Harness) {
  const latest = async (jobId: string): Promise<JobRun> => {
    const res = await page.request.get(`${harness.cockpitUrl}/api/jobs/${jobId}/runs?limit=1`);
    return ((await res.json()) as { runs: JobRun[] }).runs[0];
  };
  const trigger = async (jobId: string) => {
    const res = await page.request.post(`${harness.cockpitUrl}/api/jobs/${jobId}/trigger`, { timeout: 5_000 }).catch(() => null);
    // The trigger answers when the run ends; only a refusal matters here.
    if (res) expect(res.ok()).toBe(true);
  };
  /** The latest run once it is a new one in the given status. */
  const until = async (jobId: string, status: string, after: number): Promise<JobRun> => {
    let run: JobRun | undefined;
    await expect
      .poll(
        async () => {
          run = await latest(jobId);
          return run.startedAt > after ? run.status : "not started";
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe(status);
    return run as JobRun;
  };
  return { latest, trigger, until };
}

test("a run already going when the waiting job last started does not count toward its next start", async ({ page, harness }) => {
  test.setTimeout(240_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-chain-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    harness.mock.setScript([{ events: textResponse("Done.") }]);
    // Slow's last run started a minute before Fold did and finished five
    // minutes after, so Fold could not have seen what it collected.
    const foldStart = Date.now() - 3_600_000;
    seedFold(harness, workDir, foldStart, {
      quick: { startedAt: foldStart - 120_000, completedAt: foldStart - 90_000 },
      slow: { startedAt: foldStart - 60_000, completedAt: foldStart + 300_000 },
    });
    const { latest, trigger, until } = jobRuns(page, harness);

    const started = Date.now();
    await trigger(QUICK);
    await until(QUICK, "success", started - 1);
    await page.waitForTimeout(5_000);
    expect((await latest(FOLD)).startedAt, "Fold started before Slow ran again").toBe(foldStart);

    await trigger(SLOW);
    const slow = await until(SLOW, "success", started - 1);
    const fold = await until(FOLD, "success", foldStart);
    expect(fold.startedAt).toBeGreaterThanOrEqual(slow.completedAt as number);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a job waiting on others does not start while one of them is running", async ({ page, harness }) => {
  test.setTimeout(240_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-chain-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    harness.mock.setScript([
      { match: '"json_schema"', events: textResponse('{"title":"Job"}') },
      // Slow's turn is held long enough for Quick to run from start to end.
      { match: SLOW_PROMPT, events: textResponse("Done."), delayMs: 45_000 },
      { events: textResponse("Done.") },
    ]);
    // Slow's last success started after Fold last did, so it counts; but
    // Slow is running again when Quick succeeds.
    const foldStart = Date.now() - 3_600_000;
    seedFold(harness, workDir, foldStart, {
      quick: { startedAt: foldStart - 120_000, completedAt: foldStart - 90_000 },
      slow: { startedAt: foldStart + 60_000, completedAt: foldStart + 120_000 },
    });
    const { latest, trigger, until } = jobRuns(page, harness);

    const started = Date.now();
    await trigger(SLOW);
    await until(SLOW, "running", started - 1);
    await trigger(QUICK);
    await until(QUICK, "success", started - 1);
    expect((await latest(SLOW)).status, "Slow is still running").toBe("running");
    await page.waitForTimeout(5_000);
    expect((await latest(FOLD)).startedAt, "Fold started while Slow was running").toBe(foldStart);

    const slow = await until(SLOW, "success", started - 1);
    const fold = await until(FOLD, "success", foldStart);
    expect(fold.startedAt).toBeGreaterThanOrEqual(slow.completedAt as number);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
