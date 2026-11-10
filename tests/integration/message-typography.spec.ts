// A user's message and the reply beside it are the same size. Installing the
// typography plugin made the reply's prose classes real, and the user bubble
// was left at text-base, so prompts started rendering larger than answers.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

test("a user message renders at the same size as the reply", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-type-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("The reply is prose.") }]);
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);

    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(5000);
    await input.fill("a plain user prompt");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("The reply is prose.")).toBeVisible({ timeout: 30_000 });

    const styles = await page.evaluate(() => {
      const user = [...document.querySelectorAll("p")].find((p) => p.textContent?.trim() === "a plain user prompt");
      const agent = document.querySelector(".message-prose p");
      if (!user || !agent) return null;
      const u = getComputedStyle(user);
      const a = getComputedStyle(agent);
      return { user: u.fontSize, agent: a.fontSize, userLine: u.lineHeight, agentLine: a.lineHeight };
    });
    expect(styles).not.toBeNull();
    expect(styles?.user).toBe(styles?.agent);
    expect(styles?.userLine).toBe(styles?.agentLine);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
