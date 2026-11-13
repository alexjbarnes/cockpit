// Fish-style completion in the composer: once a prompt has been sent, typing
// its start shows the rest as ghost text, and Right, Tab or a tap accepts the
// most recent prompt that starts with what was typed.

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

test("typing a prompt's start shows the newest match, and Right, Tab or a tap accepts it", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-suggest-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("Pushed.") }, { events: textResponse("Tagged.") }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);

    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // Let session:connect's eager spawn settle before the first send.
    await page.waitForTimeout(5000);

    await input.fill("commit and push");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("Pushed.")).toBeVisible({ timeout: 30_000 });

    await input.fill("commit and tag");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("Tagged.")).toBeVisible({ timeout: 30_000 });

    // The ghost stays out of the value until it is accepted.
    await input.fill("co");
    await expect(input).toHaveValue("co");
    const suggestion = page.getByTestId("prompt-suggestion");
    await expect(suggestion).toBeVisible();
    await expect(suggestion).toContainText("mmit and tag");

    await input.press("ArrowRight");
    await expect(input).toHaveValue("commit and tag");
    await expect(suggestion).not.toBeVisible();

    // Tab accepts too, and while a ghost is showing it must not flip Plan/Build.
    await input.fill("co");
    await expect(suggestion).toBeVisible();
    await input.press("Tab");
    await expect(input).toHaveValue("commit and tag");
    await expect(page.getByTitle("Switch to Plan mode (Tab)")).toBeVisible();

    // A tap on the grey text accepts it, for a phone with no arrow keys.
    await input.fill("co");
    await page.getByTestId("prompt-suggestion-accept").click();
    await expect(input).toHaveValue("commit and tag");
    await expect(suggestion).not.toBeVisible();

    // On by default; turning it off in Settings hides the ghost.
    const patch = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { promptSuggestions: false } });
    expect(patch.ok()).toBe(true);
    await page.reload();
    await expect(input).toBeVisible();
    await page.waitForTimeout(1500);
    await input.fill("co");
    await expect(input).toHaveValue("co");
    await expect(suggestion).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
