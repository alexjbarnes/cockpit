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
import type { SSEScriptEvent } from "../mock-api/types";
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

/** One assistant message launching two agents, so both are in flight at once.
 *  toolUseResponse builds a whole message, so two of them cannot be joined. */
function twoAgentLaunches(agents: { description: string; prompt: string }[]): SSEScriptEvent[] {
  const events: SSEScriptEvent[] = [];
  events.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: `msg_multi_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-6",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  });
  events.push({
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  events.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Launching both." } },
  });
  events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });

  agents.forEach((agent, i) => {
    const index = i + 1;
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: `toolu_multi_${Date.now()}_${i}`, name: "Agent", input: {} },
      },
    });
    events.push({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ ...agent, subagent_type: "general-purpose" }) },
      },
    });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 150, output_tokens: 40 },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
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

test("two agents still running on return are both shown running", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-task-replay-2-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  const title = textResponse('{"title":"Two agents"}');
  const launches = twoAgentLaunches([
    { description: "Review the README", prompt: "SUBTASK ONE: read the README and report." },
    { description: "Review the styles", prompt: "SUBTASK TWO: read the CSS and report." },
  ]);
  // Each agent's own request is held open, so both are plainly still working
  // when the page comes back.
  const holdOne = textResponse("One's report.");
  const holdTwo = textResponse("Two's report.");

  try {
    const { url: sessionUrl } = await createSession(page, harness, workDir, "Reviewer");
    const { url: otherUrl } = await createSession(page, harness, workDir, "Other");
    await page.goto(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    harness.mock.setScript([
      { match: '"json_schema"', events: title },
      // The parent's follow-up after the launch carries the launch output; it
      // must end the turn, or the launch entry is served again forever.
      { match: "async agent launched", events: textResponse("Both launched.") },
      // The agents' own requests first: a subagent's context can include the
      // parent's conversation, so a launch entry ahead of these would launch
      // two more agents from every subagent.
      { match: "SUBTASK ONE", events: holdOne, delayMs: 120_000 },
      { match: "SUBTASK TWO", events: holdTwo, delayMs: 120_000 },
      { match: "KICKOFF BOTH", events: launches },
    ]);
    await page.getByTestId("message-input").fill("KICKOFF BOTH");
    await page.getByTestId("btn-send").click();

    await expect(page.getByTitle("2 background tasks")).toBeVisible({ timeout: 30_000 });

    await page.getByText("Other", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${otherUrl.split("?")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await page.waitForTimeout(1500);
    await page.getByText("Reviewer", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${sessionUrl.split("?")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await expect(page.getByTestId("message-input")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3000);

    await expect(page.getByTitle("2 background tasks")).toBeVisible({ timeout: 15_000 });
    await page.getByTitle("2 background tasks").click();
    const rows = page.getByTestId("background-task");
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) await expect(row).toHaveAttribute("data-status", "running");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
