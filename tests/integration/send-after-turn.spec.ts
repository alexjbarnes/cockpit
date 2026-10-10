// A message can be held for when Claude finishes instead of reaching it mid-turn.
//
// Sent the ordinary way while Claude works, a message goes to the CLI's own
// queue and Claude reads it with the next tool result. A long press (touch) or
// right-click on Send offers the choice: send now, or hold the message in
// cockpit's queue and send it as a turn of its own once the current one ends.
// These tests drive both choices against the real CLI.

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
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-afterturn-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  return workDir;
}

/** Each change of status the server reports to the page, in order, with the
 *  page's two copies of each (session and sidebar watch) folded. */
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

async function openSession(page: Page, harness: Harness, workDir: string): Promise<void> {
  const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(createRes.ok()).toBe(true);
  const { sessionId } = (await createRes.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // Let the eager PTY spawn settle before the first send.
  await page.waitForTimeout(5000);
}

function mainRequests(harness: Harness) {
  // The title side request asks for a JSON schema; the turn's own do not.
  return harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages" && !r.body.includes('"json_schema"'));
}

/** Start a turn that is busy in a six-second tool call, then script `next`. */
async function startSlowToolTurn(page: Page, harness: Harness, next: Parameters<Harness["mock"]["setScript"]>[0]): Promise<void> {
  // Every response is built before this first setScript, which resets the
  // builder's id sequence: the caller's first, then this one.
  harness.mock.setScript([{ events: toolUseResponse("Bash", { command: "sleep 6", description: "Wait six seconds" }) }]);
  await page.getByTestId("message-input").fill("Run the slow command");
  await page.getByTestId("btn-send").click();
  await expect.poll(() => mainRequests(harness).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  // The sleep is under way once its tool call has been served.
  await page.waitForTimeout(1500);
  harness.mock.setScript(next);
}

test("a message sent for when Claude finishes waits out the turn, then runs as its own", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  const afterTool = textResponse("Done waiting.");
  const followUp = textResponse("Here is the README check.");
  try {
    const statuses = recordStatuses(page);
    await openSession(page, harness, workDir);
    // The tool result's request is answered by the first entry; the held
    // message's own turn by the last, which repeats.
    await startSlowToolTurn(page, harness, [{ events: afterTool }, { events: followUp }]);

    await page.getByTestId("message-input").fill("Then check the README");
    await page.getByTestId("btn-send").click({ button: "right" });
    await expect(page.getByTestId("send-mode-modal")).toBeVisible();
    await page.getByTestId("send-mode-after-turn").click();

    await expect(page.getByTestId("message-input")).toHaveValue("");
    await expect(page.getByText("1 message queued")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("awaiting-read")).toHaveCount(0);
    const bubble = page.locator("[data-message-id]").filter({ hasText: "Then check the README" });
    await expect(bubble).toHaveCount(0);

    await expect(page.getByText("Done waiting.")).toBeVisible({ timeout: 30_000 });
    // Claude finished the first turn without it: the tool result went alone.
    const toolResultRequest = mainRequests(harness).find((r) => r.body.includes("tool_result"));
    expect(toolResultRequest?.body).not.toContain("Then check the README");
    expect(mainRequests(harness).some((r) => r.body.includes(MID_TURN_NOTE))).toBe(false);

    // Then it went as a turn of its own.
    await expect(page.getByText("Here is the README check.")).toBeVisible({ timeout: 30_000 });
    const last = mainRequests(harness).at(-1);
    expect(last?.body).toContain("Then check the README");
    expect(last?.body).not.toContain(MID_TURN_NOTE);
    await expect(bubble).toHaveCount(1);
    await expect(page.getByText("1 message queued")).toHaveCount(0);
    await expect.poll(() => statuses.at(-1), { timeout: 10_000 }).toBe("idle");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a long press on Send offers the same choice, and Send now still reaches Claude mid-turn", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  const afterTool = textResponse("Done waiting, and I saw your note.");
  try {
    await openSession(page, harness, workDir);
    await startSlowToolTurn(page, harness, [{ events: afterTool }]);

    await page.getByTestId("message-input").fill("Also check the README");
    const sendButton = page.getByTestId("btn-send");
    await sendButton.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, button: 0 });
    await expect(page.getByTestId("send-mode-modal")).toBeVisible({ timeout: 2000 });
    await sendButton.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0 });
    // Holding Send sent nothing by itself.
    await expect(page.getByTestId("message-input")).toHaveValue("Also check the README");

    await page.getByTestId("send-mode-now").click();
    await expect(page.getByTestId("send-mode-modal")).toHaveCount(0);
    await expect(page.getByTestId("awaiting-read")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText("Done waiting, and I saw your note.")).toBeVisible({ timeout: 30_000 });
    const withNote = mainRequests(harness).find((r) => r.body.includes(MID_TURN_NOTE));
    expect(withNote?.body).toContain("Also check the README");
    expect(withNote?.body).toContain("tool_result");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
