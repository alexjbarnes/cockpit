// The embedded terminal renders through ghostty-web's WebAssembly parser.
//
// A canvas renderer cannot be read with getByText, so the proof is the panel's
// own select mode: it walks the terminal buffer and lays the text over the
// canvas, which is also the path a phone uses to copy. Typing "echo" into the
// real PTY and finding its output there exercises the WASM terminal, input
// handling, websocket and buffer API together.

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

test("the embedded terminal runs a shell and its buffer is selectable", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-terminal-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("ok") }]);

    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = (await created.json()) as { sessionId: string };

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    await page.getByTitle("New terminal (Ctrl+`)").click();
    const canvas = page.getByTestId("terminal-viewport").locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Fit at phone width before typing, so the buffer is not reflowed after
    // the command has run.
    await page.setViewportSize({ width: 393, height: 800 });
    await canvas.click();
    await page.keyboard.type("echo ghostty-ok");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    // A soft keyboard inserts text instead of producing keydown events, which
    // ghostty's encoder ignores. This is the phone input path.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.insertText", { text: "echo soft-keys-ok" });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    // Shrinking the viewport mimics the soft keyboard opening, which reveals
    // the mobile key bar and its select button.
    await page.setViewportSize({ width: 393, height: 400 });
    const select = page.getByTestId("terminal-select");
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.click();

    await expect(page.getByTestId("terminal-select-overlay")).toContainText("ghostty-ok");
    await expect(page.getByTestId("terminal-select-overlay")).toContainText("soft-keys-ok");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
