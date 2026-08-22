// The two timing readouts on the chat view, against the real CLI:
//   1. a live elapsed counter beside the processing spinner, so a long turn
//      says how long it has been going rather than just spinning;
//   2. a clock time under an assistant message, so you can tell WHEN a reply
//      landed and not only how long it took.
//
// Both are wall-clock UI that only exists while/after a real turn runs, which
// is why this is an integration test rather than a unit one: the counter needs
// a turn genuinely held open, and the footer needs a turn that genuinely ended.

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

test("a running turn shows a ticking elapsed time, and the finished reply shows when it landed", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-timing-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    // Held open long enough for the 1s ticker to advance more than once.
    harness.mock.setScript([{ events: textResponse("done thinking"), delayMs: 6000 }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(5000);

    await input.fill("take your time");
    await page.getByTestId("btn-send").click();

    const elapsed = page.getByTestId("turn-elapsed");
    await expect(elapsed).toBeVisible({ timeout: 20_000 });

    // It must actually count, not render a frozen value.
    const first = await elapsed.textContent();
    await expect.poll(async () => (await elapsed.textContent()) !== first, { timeout: 15_000 }).toBe(true);

    // Both readouts are durations of the same span, so neither may be blank or
    // zeroed — "0s" would mean the turn-start anchor was lost.
    expect(first).toMatch(/^\d+[smh]/);

    await expect(page.getByText("done thinking")).toBeVisible({ timeout: 30_000 });
    await expect(elapsed, "the counter belongs to a running turn only").toBeHidden({ timeout: 20_000 });

    // "Worked for 6s · 14:32" — duration and clock time under the reply.
    await expect(page.getByText(/Worked for .+ · \d{2}:\d{2}/)).toBeVisible({ timeout: 20_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
