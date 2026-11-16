// Coming back to a session whose agents are still running: the Background
// Tasks list must show them running, not finished. The transcript records an
// async agent's launch as done the moment it returns its agent id, so a
// returning page has only the server's replayed task list to go on. Before
// this test, that list arrived empty or stale and every running agent read as
// finished until its next progress update flipped it back.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

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

const PROMPT = "Read the README and report on every section.";

async function createSession(page: Page, harness: Harness, workDir: string, name: string): Promise<{ id: string; url: string }> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty", name } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.request.patch(`${harness.cockpitUrl}/api/sessions/pinned`, { data: { add: sessionId } });
  return { id: sessionId, url: `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}` };
}

test("a session reopened while its agent still runs shows the agent running", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-task-replay-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  // Built before setScript resets the id sequence.
  const title = textResponse('{"title":"README review"}');
  const launch = toolUseResponse("Agent", { description: "Review the README", prompt: PROMPT, subagent_type: "general-purpose" });
  // Held open long enough to leave and come back while it works.
  const report = textResponse("The agent's report, long after the return.");
  try {
    const { url: sessionUrl } = await createSession(page, harness, workDir, "Reviewer");
    const { url: otherUrl } = await createSession(page, harness, workDir, "Other");
    await page.goto(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    harness.mock.setScript([{ match: '"json_schema"', events: title }, { events: launch }, { events: report, delayMs: 45_000 }]);
    await page.getByTestId("message-input").fill("Have an agent review the README");
    await page.getByTestId("btn-send").click();

    // It is running before we leave: one background task, spinning.
    await expect(page.getByTitle("1 background task")).toBeVisible({ timeout: 30_000 });

    // Away to another session the way the sidebar does it, and back.
    await page.getByText("Other", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${otherUrl.split("?")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByText("Reviewer", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${sessionUrl.split("?")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(page.getByTestId("message-input")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3000);

    // The list still counts it as running...
    await expect(page.getByTitle("1 background task")).toBeVisible({ timeout: 15_000 });
    await page.getByTitle("1 background task").click();
    const row = page.getByTestId("background-task");
    await expect(row).toHaveCount(1);
    // ...and the row is a spinner, not a tick.
    await expect(row).toHaveAttribute("data-status", "running");
    await expect(row.locator(".animate-spin")).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
