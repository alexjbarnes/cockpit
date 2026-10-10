// An agent's transcript opens in a modal over the session, from the agent's
// card in the chat or its row in Background Tasks. It opens at the latest
// message and follows the agent while it works. This drives a real subagent
// through the CLI and opens it both ways.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
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
const LAST_LINE = "That is the end of the agent's report.";
// Long enough to overflow the modal, so opening at the latest is a scroll.
const REPORT = [...Array.from({ length: 60 }, (_, i) => `Finding ${i + 1}: section ${i + 1} of the README reads fine.`), LAST_LINE].join(
  "\n\n",
);

function makeWorkDir(harness: Harness): string {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-agentmodal-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  return workDir;
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

/** Whether the transcript is scrolled to its end, and has an end to scroll to. */
async function atEnd(modal: Locator): Promise<{ overflows: boolean; atEnd: boolean }> {
  return modal.getByTestId("agent-transcript-scroll").evaluate((el) => ({
    overflows: el.scrollHeight > el.clientHeight + 200,
    atEnd: el.scrollHeight - el.scrollTop - el.clientHeight <= 2,
  }));
}

test("an agent's transcript opens in a modal from Background Tasks and from its card", async ({ page, harness }) => {
  test.setTimeout(150_000);
  const workDir = makeWorkDir(harness);
  // Every response is built before the first setScript, which resets the
  // builder's id sequence.
  const title = textResponse('{"title":"README review"}');
  const launch = toolUseResponse("Agent", { description: "Review the README", prompt: PROMPT, subagent_type: "general-purpose" });
  const report = textResponse(REPORT);
  const finished = textResponse("The agent has finished.");
  try {
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(res.ok()).toBe(true);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const sessionUrl = `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
    await page.goto(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // Let the eager PTY spawn settle before the first send.
    await page.waitForTimeout(5000);

    // The launch, then the agent's reply, held so the agent is seen working.
    // The parent's next request is answered alongside it with the same entry,
    // and the turn the agent's completion resumes by the last. The title
    // request the CLI sends beside a turn has its own reply, so it cannot take
    // one of these.
    harness.mock.setScript([
      { match: '"json_schema"', events: title },
      { events: launch },
      { events: report, delayMs: 8000 },
      { events: finished },
    ]);
    await send(page, "Have an agent review the README");
    const card = page.getByTestId("agent-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    const modal = page.getByTestId("agent-transcript");

    // From Background Tasks while it works: the list makes way for the
    // transcript, which shows the agent's prompt and that it is working.
    await expect(page.getByTitle("1 background task")).toBeVisible({ timeout: 15_000 });
    await page.getByTitle("1 background task").click();
    await page.getByTestId("background-task").click();
    await expect(page.getByRole("heading", { name: "Background Tasks" })).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(modal.getByText(PROMPT)).toBeVisible({ timeout: 15_000 });
    await expect(modal.getByTestId("agent-transcript-working")).toBeVisible();

    // The agent's reply arrives while it is open, and the modal follows it down.
    await expect(modal.getByText(LAST_LINE)).toBeInViewport({ timeout: 30_000 });
    await expect.poll(() => atEnd(modal)).toEqual({ overflows: true, atEnd: true });
    await expect(modal.getByTestId("agent-transcript-working")).toHaveCount(0, { timeout: 30_000 });
    // The chips name what the agent is running on. The model comes from the
    // agent's own transcript rather than the launch, which names one only when
    // the caller overrode it; the level shows only when the CLI recorded it.
    await expect(modal.getByTestId("agent-tag")).toContainText(["general-purpose", "claude-sonnet-4-6"]);
    // The card shows the same agent as finished.
    await expect(card.locator(".animate-spin")).toHaveCount(0);

    // Escape goes straight back to the chat, list and all.
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Background Tasks" })).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);

    // From the card: the same transcript, opened at its latest message.
    await card.click();
    await expect(modal).toBeVisible();
    await expect(modal.getByText(PROMPT)).toBeVisible();
    await expect(modal.getByText(LAST_LINE)).toBeInViewport({ timeout: 15_000 });
    await expect.poll(() => atEnd(modal)).toEqual({ overflows: true, atEnd: true });

    // The device's Back closes it without leaving the session.
    await page.goBack();
    await expect(modal).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
