// Regression: gauge denominator must stay at 1M after a message round-trip
// in PTY mode when the session is configured for 1M context.
//
// Background — commit f0f51d6 (May 2026): a user sets context size to 1M via
// the UI, the gauge briefly shows percentage of 1M, then flips back to 200K
// after the first message. Root causes:
//   - createSession/ensureSession hardcoded contextWindowSize=200_000 while
//     info.contextSize correctly tracked the user's pick
//   - PTY transcript-watcher emitted lastUsage.total from parseLines, which
//     defaults to 200_000 because the persisted JSONL has no result.modelUsage
//   - stream-mode extractContextWindowSize overwrote the user's pick with the
//     CLI's reported model.contextWindow (catalog default)
//
// Fix: session.contextWindowSize is now the single source of truth, derived
// from info.contextSize. This test exercises the PTY transcript-watcher path
// end-to-end — if the denominator regresses to 200k after a message, this
// test catches it.

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

test("gauge denominator stays at 1M after a message round-trip in PTY mode", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-ctx-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    harness.mock.setScript([{ events: textResponse("ack") }]);

    // Create the session with contextSize=1m so it starts in the configuration
    // that historically regressed to 200k after the first message.
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: "mock:claude-sonnet-4-6", contextSize: "1m" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    // Send a turn — this exercises the transcript-watcher → usage emit path
    // that was the regression site.
    await page.getByTestId("message-input").fill("hi");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("ack")).toBeVisible({ timeout: 30_000 });

    // Open the context indicator modal and read the total. formatTokens
    // renders any value >= 1000 as "<value/1000>.0k", so 1_000_000 → "1000.0k".
    await page.getByTestId("context-indicator").click();
    await expect(page.getByTestId("context-total")).toBeVisible();
    const totalText = await page.getByTestId("context-total").textContent();
    expect(totalText).toBe("1000.0k total");
    // Sanity: ensure we didn't regress to 200k.
    expect(totalText).not.toBe("200.0k total");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
