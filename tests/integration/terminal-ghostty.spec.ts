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

test("a reconnected terminal keeps working after a reload", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-terminal-reconnect-"));
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
    await expect(page.getByTestId("terminal-viewport").locator("canvas")).toBeVisible({ timeout: 30_000 });

    const tabTerminalId = async (): Promise<string | null> => {
      const res = await page.request.get(`${harness.cockpitUrl}/api/sessions/${sessionId}/tabs`);
      const data = (await res.json()) as { openTabs?: Array<{ type: string; terminalId?: string }> };
      return data.openTabs?.find((t) => t.type === "terminal")?.terminalId ?? null;
    };
    let oldId = "";
    for (let i = 0; i < 30 && !oldId; i++) {
      oldId = (await tabTerminalId()) ?? "";
      if (!oldId) await page.waitForTimeout(500);
    }
    expect(oldId).not.toBe("");

    // The PTY is gone (a server restart does the same). The tab still names it,
    // so a reload shows the reconnect state.
    await page.request.delete(`${harness.cockpitUrl}/api/terminal/${oldId}`);
    await page.reload();
    await expect(page.getByText("Terminal disconnected")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByTestId("terminal-viewport").locator("canvas")).toBeVisible({ timeout: 30_000 });

    // The reconnect must move the tab to the new PTY. Before that it kept the
    // dead id, so every later mount reconnected to a terminal that was gone.
    let newId = "";
    for (let i = 0; i < 30 && (!newId || newId === oldId); i++) {
      newId = (await tabTerminalId()) ?? "";
      if (!newId || newId === oldId) await page.waitForTimeout(500);
    }
    expect(newId).not.toBe("");
    expect(newId).not.toBe(oldId);

    await page.reload();
    await expect(page.getByTestId("terminal-viewport").locator("canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Terminal disconnected")).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a replay does not answer the terminal queries in the buffer", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-terminal-replay-"));
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

    await page.setViewportSize({ width: 393, height: 800 });
    await canvas.click();
    // Ask for a cursor position and the terminal's attributes, then keep a
    // command running so the tty echoes the replies into the buffer.
    await page.keyboard.type("printf '\\033[6n'; printf '\\033[c'; sleep 20");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);

    const responseCount = async (): Promise<number> => {
      await page.setViewportSize({ width: 393, height: 400 });
      const select = page.getByTestId("terminal-select");
      await expect(select).toBeVisible({ timeout: 10_000 });
      await select.click();
      const text = (await page.getByTestId("terminal-select-overlay").textContent()) ?? "";
      await page.getByTestId("terminal-select-done").click();
      await page.setViewportSize({ width: 393, height: 800 });
      return (text.match(/\?62;22c/g) || []).length + (text.match(/\[\d+;\d+R/g) || []).length;
    };

    // The live queries were answered and echoed once.
    const before = await responseCount();
    expect(before).toBeGreaterThan(0);

    // The reload replays the buffer, including the queries. Answering them
    // again types a second set of replies into the running command.
    await page.reload();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2000);

    expect(await responseCount()).toBe(before);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a replay keeps history older than a long progress line", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-terminal-buffer-"));
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

    await page.setViewportSize({ width: 393, height: 800 });
    await canvas.click();
    // A long progress line is one visible line but well over 100KB of raw
    // output. The history before it used to be trimmed away, leaving only the
    // last progress update after a refresh.
    await page.keyboard.type(
      'bash -c \'echo HISTORY-MARKER; for i in $(seq 1 12000); do printf "\\rprogress %d" "$i"; done; echo; echo BUFFER-DONE\'; sleep 20',
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);

    await page.reload();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2000);

    await page.setViewportSize({ width: 393, height: 400 });
    const select = page.getByTestId("terminal-select");
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.click();
    const text = (await page.getByTestId("terminal-select-overlay").textContent()) ?? "";
    expect(text).toContain("HISTORY-MARKER");
    expect(text).toContain("BUFFER-DONE");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
