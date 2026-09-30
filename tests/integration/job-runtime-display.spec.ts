// A job saved with no runtime runs on the server's default, PTY, and its page
// has to say so rather than name a runtime it does not use.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test("a job with no stored runtime shows PTY on its page", async ({ page, harness }) => {
  const now = Date.now();
  const job = {
    id: "job-no-runtime",
    name: "no-runtime-job",
    schedules: [{ type: "simple", frequency: "daily", time: "07:00" }],
    prompt: "p",
    cwd: harness.configDir,
    enabled: false,
    createdAt: now,
    updatedAt: now,
  };
  writeFileSync(path.join(harness.configDir, "scheduled-jobs.json"), JSON.stringify({ jobs: [job] }, null, 2) + "\n");

  await page.goto(`${harness.cockpitUrl}/jobs/${job.id}`);
  const runtime = page.getByText("Runtime", { exact: true }).locator("xpath=following-sibling::span[1]");
  await expect(runtime).toHaveText("pty");
});
