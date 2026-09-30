// A scheduled job whose time passed while the server was down runs once the
// server is back, even if it has never run before.
//
// The scheduler catches up a missed time by looking back from the job's last
// run, and a job with none counts from when it was last saved. The first tick
// comes a minute after the server starts, so this test waits that long.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

test("a daily job that has never run catches up a time missed before the server started", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-missed-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("Caught up on the missed run.") }]);

    // Due half an hour ago, and saved days before that, as a job set up for a
    // time the server is never running at.
    const due = new Date(Date.now() - 30 * 60_000);
    const time = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
    const savedAt = Date.now() - 3 * 86_400_000;
    const job = {
      id: randomUUID(),
      name: "missed-morning-job",
      schedules: [{ type: "simple", frequency: "daily", time }],
      prompt: "Say you caught up.",
      cwd: workDir,
      enabled: true,
      createdAt: savedAt,
      updatedAt: savedAt,
      bypassPermissions: false,
      maxDurationMinutes: 5,
      retentionDays: 90,
      skipIfMissed: false,
      inboxOutput: false,
      runtime: "pty",
    };
    writeFileSync(path.join(harness.configDir, "scheduled-jobs.json"), JSON.stringify({ jobs: [job] }, null, 2) + "\n");

    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${harness.cockpitUrl}/api/jobs/${job.id}/runs`);
          const { runs } = (await res.json()) as { runs: { status: string }[] };
          return runs[0]?.status ?? "none";
        },
        { timeout: 150_000, intervals: [5_000] },
      )
      .toBe("success");

    const calls = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages");
    expect(calls.some((c) => c.body.includes("Say you caught up."))).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
