// A job with an After jobs schedule runs by itself once the job it waits on
// has completed, and the editor refuses waiting that loops back.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";

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
