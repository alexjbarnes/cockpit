// A terminal must survive leaving and returning to its session when the user
// has custom terminal settings. Those settings arrive after the panel mounts;
// building the terminal on the defaults and then rebuilding it on the loaded
// values disposed the terminal under the first websocket and raced the replay,
// which could leave the replacement terminal empty. Default settings hide the
// bug, so this spec seeds a non-default theme, font size and scrollback and
// holds the stored values back until after the terminal was built.

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

test.use({
  harnessOptions: {
    defaults: { terminalTheme: "cockpit", terminalFontSize: 10, terminalScrollback: 5000 },
  },
});

test("terminal output survives leaving and returning to the session", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-terminal-switch-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    // The terminal is built on the defaults first, then the stored settings
    // arrive. The fixed panel waits for them and builds once.
    await page.route("**/api/defaults", async (route) => {
      await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    });

    harness.mock.setScript([{ events: textResponse("ok") }]);
    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const other = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(other.ok()).toBe(true);
    const { sessionId: otherId } = (await other.json()) as { sessionId: string };
    const sessionUrl = (id: string) => `${harness.cockpitUrl}/sessions/${id}?cwd=${encodeURIComponent(workDir)}`;

    await page.goto(sessionUrl(sessionId));
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);
    await page.getByTitle("New terminal (Ctrl+`)").click();
    const canvas = page.getByTestId("terminal-viewport").locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Mark this exact canvas. A rebuild on the late settings disposes the
    // terminal and replaces it, so the marker would be gone.
    await canvas.evaluate((el) => {
      (el as HTMLCanvasElement & { terminalMarker?: string }).terminalMarker = "keep";
    });
    await page.waitForTimeout(6000);
    const survivedRebuild = await page
      .getByTestId("terminal-viewport")
      .locator("canvas")
      .evaluate((el) => (el as HTMLCanvasElement & { terminalMarker?: string }).terminalMarker === "keep");
    expect(survivedRebuild).toBe(true);

    await page.setViewportSize({ width: 393, height: 800 });
    await canvas.click();
    await page.keyboard.type("echo SWITCH-SURVIVES");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    // The select overlay is the app's own read of the ghostty buffer.
    await page.setViewportSize({ width: 393, height: 400 });
    const select = page.getByTestId("terminal-select");
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.click();
    await expect(page.getByTestId("terminal-select-overlay")).toContainText("SWITCH-SURVIVES");
    await page.getByTestId("terminal-select-done").click();
    await page.setViewportSize({ width: 393, height: 800 });

    // Leave and come back. The terminal tab is persisted, so it remounts and
    // replays; the output must still be there afterwards.
    await page.goto(sessionUrl(otherId));
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.goto(sessionUrl(sessionId));
    await expect(page.getByTestId("terminal-viewport").locator("canvas")).toBeVisible({ timeout: 30_000 });

    await page.setViewportSize({ width: 393, height: 400 });
    const selectAfter = page.getByTestId("terminal-select");
    await expect(selectAfter).toBeVisible({ timeout: 10_000 });
    await selectAfter.click();
    await expect(page.getByTestId("terminal-select-overlay")).toContainText("SWITCH-SURVIVES");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
