// Integration test: the cockpit assistant's footer dot.
//
// The assistant is not a pinned session, so before this feature nothing
// watched it: a question it was waiting on, or a task it finished while its
// modal was closed, was invisible. The dot must show working while a turn is
// in flight, unread once it ends with the modal closed, and clear when the
// modal is opened.
//
// Skips cleanly if no CLI on PATH.

import { execSync } from "node:child_process";
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

test("assistant dot goes working, then unread, and clears when the modal opens", async ({ page, harness }) => {
  // The assistant's cwd is the cockpit dir itself.
  harness.trustWorkDir(harness.configDir);
  // Hold the turn open long enough to close the modal while it runs.
  harness.mock.setScript([{ events: textResponse("Assistant reply"), delayMs: 8000 }]);

  await page.goto(`${harness.cockpitUrl}/`);

  const button = page.getByTestId("assistant-button");
  const dot = page.getByTestId("assistant-dot");
  await expect(button).toBeVisible();
  // Nothing has happened yet: no session, no dot.
  await expect(dot).toHaveCount(0);

  // First open creates the assistant session (GET /api/assistant-session).
  await button.click();
  const input = page.getByTestId("message-input");
  await expect(input).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(5000);

  await input.fill("hi");
  await page.getByTestId("btn-send").click();

  // Working while the turn is in flight, modal open or not.
  await expect(dot).toHaveAttribute("data-state", "working", { timeout: 15_000 });

  // Close the modal; the reply lands unseen, so the dot turns green.
  await page.keyboard.press("Escape");
  await page
    .getByTestId("message-input")
    .waitFor({ state: "hidden", timeout: 10_000 })
    .catch(() => {});
  await expect(dot).toHaveAttribute("data-state", "unread", { timeout: 30_000 });

  // Opening the assistant counts as reading it.
  await button.click();
  await expect(page.getByTestId("message-input")).toBeVisible({ timeout: 15_000 });
  await expect(dot).toHaveCount(0, { timeout: 10_000 });
});
