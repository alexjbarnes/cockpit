// The freeze this guards against: in plan mode the CLI consults its
// server-side auto-mode classifier, and when that is unavailable — a session
// on a provider no Anthropic account backs, which is every session here — it
// puts up a dialog asking the user to acknowledge a classifier billing
// notice, and blocks the turn until someone presses Enter. Nothing reported
// the wait: no PermissionRequest fires, and the CLI's own idle notification is
// suppressed while a dialog is on screen.
//
// cockpit's answer is to keep such a session out of auto mode altogether
// (disableAutoMode:"disable" + useAutoModeDuringPlan:false in its settings
// file, written when the model is not Anthropic's — a file with any invalid
// setting is skipped whole, so the value matters). This drives the real CLI
// into the exact state that used to freeze — plan mode, a shell command with a
// command substitution in it — and asserts the turn completes.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
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

test("plan mode on a provider session does not stall on the classifier dialog", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-autodialog-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  writeFileSync(path.join(workDir, "x.go"), "package main\n\nfunc main() {}\n");
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([
      {
        events: toolUseResponse("Bash", {
          command: `sed -n "$(grep -n 'func main' x.go | cut -d: -f1),+2p" x.go`,
          description: "read with substitution",
        }),
      },
      { events: textResponse("done with the read") },
    ]);

    // Pin the model to the mock provider explicitly: the session's model is what
    // decides whether auto mode is available at all, and a bare id inherited
    // from the surrounding environment would resolve to nothing.
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: "mock:claude-sonnet-4-6" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    // Plan mode is where the classifier is consulted (useAutoModeDuringPlan).
    await page.getByTitle("Switch to Plan mode (Tab)").click();
    await expect(page.getByTitle("Switch to Build mode (Tab)")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(5000);

    await page.getByTestId("message-input").fill("read the file");
    await page.getByTestId("btn-send").click();

    // Answer the card if plan mode raised one; the point is that no dialog
    // stops the CLI from getting this far.
    const card = page.getByTestId("permission-prompt");
    if (await card.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await page.getByTestId("btn-allow").click();
    }

    // The model only replies a second time if the tool call completed.
    await expect(page.getByText("done with the read")).toBeVisible({ timeout: 45_000 });

    // The turn completing is the assertion: with the classifier in play the
    // CLI blocks on its notice and this text never arrives.
    const debug = readFileSync(path.join(harness.configDir, "debug.jsonl"), "utf-8");
    expect(debug, "no dialog needed answering this time").not.toContain("pty:dialog-notification");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
