// A session opened in a directory the CLI has never seen.
//
// The CLI asks its own workspace-trust question in the terminal, and cockpit
// cannot answer it. It used to press Enter on seeing the word "trust" on
// screen, which was harmless while the dialog opened on "Yes, I trust this
// folder" and became destructive when it started opening on "No, exit": Enter
// chose Exit, the CLI quit with code 1 two seconds in, and the session showed
// "claude exited during startup" instead of asking about trust.
//
// Skips cleanly if no CLI on PATH.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("a session in an untrusted directory asks about trust instead of failing to start", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-trust-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  // Deliberately NOT trusted: no harness.trustWorkDir(workDir).

  try {
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);

    // The card names the directory the CLI will not open.
    const card = page.getByTestId("untrusted-dir-card");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).toContainText(workDir);

    // And the failure this replaces is not what the user gets.
    await expect(page.getByText(/exited during startup/i)).toHaveCount(0);
    await expect(page.getByText("API Error")).toHaveCount(0);

    // Saying yes records the trust and starts the session.
    await page.getByRole("button", { name: /Trust this directory/ }).click();
    await expect(page.getByTestId("untrusted-dir-card")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("message-input")).toBeVisible();

    // The CLI now knows the directory, so a second session there does not ask.
    const again = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    const second = (await again.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${second.sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("untrusted-dir-card")).toHaveCount(0);
    await expect(page.getByText(/exited during startup/i)).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
