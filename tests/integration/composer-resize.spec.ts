// The composer's auto-grown height has to survive the chat tab being hidden.
// A viewport change while another tab is active (on a phone, the keyboard
// opening over the terminal) used to measure the display:none textarea at 0
// and write height 0, so returning to Chat showed a single squeezed line
// until focusing the composer opened the keyboard and re-measured it.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test.use({ viewport: { width: 393, height: 760 } });

test("hiding the chat does not collapse the composer", async ({ page, harness }) => {
  test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-composer-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(res.ok()).toBe(true);
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();

    // Two rows tall to begin with: the rows attribute plus the padding.
    const height = () => input.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
    expect(await height()).toBeGreaterThanOrEqual(70);

    // Away to a terminal tab, so the chat is display:none, and a viewport
    // change arrives while it is hidden, as the keyboard does on a phone.
    await page.getByTitle("New terminal (Ctrl+`)").click();
    await expect(input).toBeHidden();
    await page.setViewportSize({ width: 393, height: 500 });

    // Back on Chat the composer is still the height its rows need.
    await page.getByRole("button", { name: "Chat" }).click();
    await expect(input).toBeVisible();
    await expect.poll(height).toBeGreaterThanOrEqual(70);

    // And it still grows with the text.
    await input.fill("one\ntwo\nthree");
    await expect.poll(height).toBeGreaterThanOrEqual(90);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
