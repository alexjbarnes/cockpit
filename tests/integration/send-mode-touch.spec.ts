// A touch long press on Send must still be showing the send-mode modal when the
// finger lifts.
//
// On release the browser synthesises the whole mouse sequence (mousedown,
// mouseup, click) at the touch point, and by then the modal the press opened is
// on screen, so the release-click lands on the modal's backdrop and dismisses
// what the press just opened. send-after-turn.spec.ts cannot see this: it
// dispatches pointer events directly, and the ghost mouse sequence only exists
// for real touches, which is why this test drives the browser's touch input.
//
// Skips cleanly if no CLI on PATH.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { toolUseResponse } from "../mock-api/builder";
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

// A phone, with touch input: the ghost click is a touch-only behaviour.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Press and hold for `ms`, leaving the finger down. */
async function press(cdp: CDPSession, page: Page, x: number, y: number, ms: number): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
}

async function release(cdp: CDPSession): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** A real tap: down and up quickly, which is a click, not a long press. */
async function tap(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function centreOf(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A session with a turn in flight, the composer focused and a message typed:
 *  the state the long press on Send is made from. */
async function openBusySession(page: Page, harness: Harness): Promise<string> {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-sendmode-touch-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  harness.mock.setScript([{ events: toolUseResponse("Bash", { command: "sleep 15", description: "Wait fifteen seconds" }) }]);

  const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(createRes.ok()).toBe(true);
  const { sessionId } = (await createRes.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // Let the eager PTY spawn settle before the first send.
  await page.waitForTimeout(5000);

  await page.getByTestId("message-input").fill("Run the slow command");
  await page.getByTestId("btn-send").click();
  await page.waitForTimeout(2500);
  await page.getByTestId("message-input").fill("Also check the README");
  await page.getByTestId("message-input").click();
  return workDir;
}

/** The composer holding the on-screen keyboard open: it keeps focus. */
const composerFocused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);

test("a held touch on Send leaves the send-mode modal open when the finger lifts", async ({ page, harness, context }) => {
  test.setTimeout(90_000);
  const workDir = await openBusySession(page, harness);
  try {
    const cdp = await context.newCDPSession(page);
    const send = await centreOf(page, "btn-send");

    await press(cdp, page, send.x, send.y, 900);
    await expect(page.getByTestId("send-mode-modal")).toBeVisible();
    await release(cdp);

    // The press's modal outlives the finger, and the hold sent nothing. The
    // composer keeps focus through it: that focus is what holds the on-screen
    // keyboard open, and a keyboard that closes shrinks the viewport this modal
    // is centred in.
    await expect(page.getByTestId("send-mode-modal")).toBeVisible();
    expect(await composerFocused(page), "the press must not take focus").toBe("message-input");
    await expect(page.getByTestId("message-input")).toHaveValue("Also check the README");

    // Tapping the backdrop still dismisses it.
    await tap(cdp, 20, 60);
    await expect(page.getByTestId("send-mode-modal")).toHaveCount(0);

    // And an ordinary tap on Send is still an ordinary send.
    await tap(cdp, send.x, send.y);
    await expect(page.getByTestId("message-input")).toHaveValue("");
    await expect(page.getByTestId("awaiting-read")).toBeVisible({ timeout: 10_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// Choosing from the modal is the other half: it must not hand focus to the
// option button, which would drop the keyboard mid-message.
test("choosing an option from the send-mode modal keeps the composer focused", async ({ page, harness, context }) => {
  test.setTimeout(90_000);
  const workDir = await openBusySession(page, harness);
  try {
    const cdp = await context.newCDPSession(page);
    const send = await centreOf(page, "btn-send");

    await press(cdp, page, send.x, send.y, 900);
    await expect(page.getByTestId("send-mode-modal")).toBeVisible();
    await release(cdp);

    await page.getByTestId("send-mode-after-turn").click();

    await expect(page.getByText("1 message queued")).toBeVisible({ timeout: 10_000 });
    expect(await composerFocused(page), "the option must not take focus").toBe("message-input");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
