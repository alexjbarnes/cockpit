// A message sent while Claude is working goes to the CLI straight away.
//
// The CLI keeps its own queue for a message typed mid-turn. It hands the
// message to the model with the next tool result, inside the same turn, and
// records it as a queued_command attachment rather than a user entry. A turn
// that reaches no further tool result ends with the message still queued, and
// the CLI then runs it as a turn of its own, which opens with no hook at all.
// Esc does the same at once. These tests drive each case against the real CLI.

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

const MID_TURN_NOTE = "The user sent a new message while you were working:";

function makeWorkDir(harness: Harness): string {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-midturn-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  return workDir;
}

/** Each change of status the server reports to the page, in order. The page
 *  hears of a change twice (its session and its sidebar watch), so repeats are
 *  folded. */
function recordStatuses(page: Page): string[] {
  const statuses: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      const payload = typeof f.payload === "string" ? f.payload : f.payload.toString();
      if (!payload.startsWith('{"type":"session:status"')) return;
      const { status } = JSON.parse(payload) as { status: string };
      if (statuses.at(-1) !== status) statuses.push(status);
    });
  });
  return statuses;
}

async function openSession(page: Page, harness: Harness, workDir: string): Promise<string> {
  const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(createRes.ok()).toBe(true);
  const { sessionId } = (await createRes.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // Let the eager PTY spawn settle before the first send.
  await page.waitForTimeout(5000);
  return sessionId;
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

function mainRequests(harness: Harness) {
  // The title side request asks for a JSON schema; the turn's own do not.
  return harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages" && !r.body.includes('"json_schema"'));
}

test("a message sent during a tool call reaches Claude in the same turn", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  // Built before the first setScript, which resets the builder's id sequence.
  const toolTurn = toolUseResponse("Bash", { command: "sleep 6", description: "Wait six seconds" });
  const afterTool = textResponse("Done waiting, and I saw your note.");
  try {
    const statuses = recordStatuses(page);
    await openSession(page, harness, workDir);
    harness.mock.setScript([{ events: toolTurn }]);
    await send(page, "Run the slow command");
    await expect.poll(() => mainRequests(harness).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    // The sleep is under way once its tool call has been served.
    await page.waitForTimeout(1500);
    harness.mock.setScript([{ events: afterTool }]);

    await send(page, "Also check the README");
    const bubble = page.locator("[data-message-id]").filter({ hasText: "Also check the README" });
    await expect(bubble).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("awaiting-read")).toBeVisible();

    await expect(page.getByText("Done waiting, and I saw your note.")).toBeVisible({ timeout: 30_000 });
    // Read inside the turn, alongside the tool result.
    const withNote = mainRequests(harness).find((r) => r.body.includes(MID_TURN_NOTE));
    expect(withNote?.body).toContain("Also check the README");
    expect(withNote?.body).toContain("tool_result");
    await expect(page.getByTestId("awaiting-read")).toHaveCount(0);
    await expect(bubble).toHaveCount(1);
    await expect.poll(() => statuses.at(-1), { timeout: 10_000 }).toBe("idle");

    // From the transcript alone, the message still shows, before the reply.
    await page.reload();
    await expect(page.getByText("Done waiting, and I saw your note.")).toBeVisible({ timeout: 15_000 });
    const order = await page.locator("[data-message-id]").allInnerTexts();
    const noteAt = order.findIndex((t) => t.includes("Also check the README"));
    const replyAt = order.findIndex((t) => t.includes("Done waiting, and I saw your note."));
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(replyAt);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a message sent while Claude writes its answer runs next, without the session going idle between", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  const slowAnswer = textResponse("Here is the first answer.");
  const followUp = textResponse("And here is the follow-up answer.");
  try {
    const statuses = recordStatuses(page);
    await openSession(page, harness, workDir);
    // The answer is held before it streams, so the turn is still going when
    // the second message is sent, and it ends with no tool result to carry it.
    harness.mock.setScript([{ events: slowAnswer, delayMs: 6000 }]);
    await send(page, "Write me an answer");
    await expect.poll(() => mainRequests(harness).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1000);
    // Held longer than cockpit waits to see a queued message taken up, so a
    // session let go idle by that wait would show here.
    harness.mock.setScript([{ events: followUp, delayMs: 7000 }]);

    await send(page, "Then a follow-up please");
    await expect(page.getByTestId("awaiting-read")).toBeVisible({ timeout: 10_000 });
    const statusesBefore = statuses.length;

    await expect(page.getByText("Here is the first answer.")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(6000);
    expect(statuses.at(-1)).toBe("running");
    await expect(page.getByText("And here is the follow-up answer.")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => statuses.at(-1), { timeout: 10_000 }).toBe("idle");
    // One idle, at the very end: the first answer's Stop did not report it.
    expect(statuses.slice(statusesBefore).filter((s) => s === "idle")).toHaveLength(1);

    // The follow-up ran as its own turn, opened by the queued message.
    const last = mainRequests(harness).at(-1);
    expect(last?.body).toContain("Then a follow-up please");
    expect(last?.body).not.toContain(MID_TURN_NOTE);
    await expect(page.getByTestId("awaiting-read")).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("Esc with a message still queued makes Claude take it up at once", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  const toolTurn = toolUseResponse("Bash", { command: "sleep 20", description: "Wait twenty seconds" });
  const takenUp = textResponse("Stopped the wait to deal with your message.");
  try {
    const statuses = recordStatuses(page);
    await openSession(page, harness, workDir);
    harness.mock.setScript([{ events: toolTurn }]);
    await send(page, "Run the long command");
    await expect.poll(() => mainRequests(harness).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(1500);
    harness.mock.setScript([{ events: takenUp, delayMs: 7000 }]);

    await send(page, "Stop that and say hello");
    await expect(page.getByTestId("awaiting-read")).toBeVisible({ timeout: 10_000 });
    const statusesBefore = statuses.length;

    await page.getByTestId("message-input").press("Escape");
    await page.waitForTimeout(6000);
    expect(statuses.at(-1)).toBe("running");
    await expect(page.getByText("Stopped the wait to deal with your message.")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => statuses.at(-1), { timeout: 10_000 }).toBe("idle");
    // Still working from the Esc until the message's own turn finished.
    expect(statuses.slice(statusesBefore).filter((s) => s === "idle")).toHaveLength(1);
    expect(mainRequests(harness).at(-1)?.body).toContain("Stop that and say hello");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
