// A question waits for the user even while a background agent is working.
//
// The model launches a background agent and then asks a question. The agent
// runs a command while the question waits, and some seconds later the CLI's
// "Claude needs your permission" notification arrives. Taken for a dialog with
// no card, it would be raised as one for the last tool seen, the agent's Bash,
// and bypass would answer that with a "1" keystroke, which the question on
// screen takes as its first option: the question answered without the user.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { askUserQuestionResponse, textResponse, toolUseResponse } from "../mock-api/builder";
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

// The general-purpose agent's system prompt opens with this and the parent's
// requests never carry it, so the agent's requests can be answered apart.
const AGENT_SYSTEM = "You are an agent for Claude Code";
// Printed by the agent's command, so only its follow-up request carries it.
const AGENT_OUTPUT = "probe-7f3a-finished";
const QUESTION = "Which way should we go?";

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

/** Cockpit's diagnostic entries for one session, in the order written. */
function diag(harness: Harness, sessionId: string): Array<Record<string, unknown>> {
  const file = path.join(harness.configDir, "debug.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"dir":"diag"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.sessionId === sessionId);
}

/** Whether the agent's command ran while the question waited on its hook, and
 *  the CLI's permission notification came after it: the order that misled
 *  cockpit. Without it this test proves nothing, so it is checked, not assumed. */
function sawTheRace(harness: Harness, sessionId: string): boolean {
  const entries = diag(harness, sessionId);
  const asked = entries.findIndex((e) => e.label === "pty:permission-request" && e.toolName === "AskUserQuestion");
  if (asked < 0) return false;
  const bash = entries.findIndex((e, i) => i > asked && e.label === "hook:PreToolUse" && e.tool === "Bash");
  if (bash < 0) return false;
  return entries.some((e, i) => i > bash && e.label === "pty:notification" && e.type === "permission_prompt");
}

/** The answers to the question that have reached the model, by label. */
function answersSent(harness: Harness): string[] {
  return harness.mock
    .getRequests()
    .filter((r) => r.url.split("?")[0] === "/v1/messages")
    .flatMap((r) => [...r.body.matchAll(/Which way should we go\?\\"=\\"(.*?)\\"/g)].map((m) => m[1]));
}

test("a question waits for the user while a background agent runs a command", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-qbg-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  // Every response is built before setScript, which resets the builder's ids.
  const title = textResponse('{"title":"Probe"}');
  const launch = toolUseResponse("Agent", {
    description: "Run the probe",
    prompt: "Run the probe command and report back.",
    subagent_type: "general-purpose",
    run_in_background: true,
  });
  const question = askUserQuestionResponse([
    {
      question: QUESTION,
      header: "Way",
      multiSelect: false,
      options: [
        { label: "First way", description: "The one a stray keystroke picks" },
        { label: "Second way", description: "The one the user picks" },
      ],
    },
  ]);
  const agentCommand = toolUseResponse("Bash", { command: `echo ${AGENT_OUTPUT}`, description: "Run the probe" });
  const agentDone = textResponse("The probe ran.");
  const finished = textResponse("Going the second way.");
  try {
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(res.ok()).toBe(true);
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // Let the eager PTY spawn settle before the first send.
    await page.waitForTimeout(5000);

    harness.mock.setScript([
      { match: '"json_schema"', events: title },
      // The agent's second request carries its command's output: it is done.
      { match: AGENT_OUTPUT, events: agentDone },
      // Its first is held, so the command runs after the question is up.
      { match: AGENT_SYSTEM, events: agentCommand, delayMs: 2500 },
      { events: launch },
      { events: question },
      { events: finished },
    ]);
    await send(page, "Run the probe in the background, then ask me which way to go.");
    await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => sawTheRace(harness, sessionId), { timeout: 30_000 }).toBe(true);
    // Give a stray keystroke time to land before looking.
    await page.waitForTimeout(2000);
    expect(answersSent(harness)).toEqual([]);
    expect(diag(harness, sessionId).filter((e) => e.label === "pty:tui-dialog-detected")).toEqual([]);
    // The real CLI's payloads let the request be tied to its call, which is
    // what releases it if it is answered in the terminal instead.
    const asked = diag(harness, sessionId).find((e) => e.label === "pty:permission-request" && e.toolName === "AskUserQuestion");
    expect(asked?.tied).toBe(true);

    // The user's own answer is the one that goes back.
    await page
      .getByRole("button", { name: /Second way/ })
      .first()
      .click();
    await page.getByRole("button", { name: /^Submit$/ }).click();
    await expect(page.getByText("Going the second way.")).toBeVisible({ timeout: 30_000 });
    expect(answersSent(harness)).toContain("Second way");
    expect(answersSent(harness)).not.toContain("First way");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
