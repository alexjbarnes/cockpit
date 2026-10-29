// A file open in a tab follows the file on disk.
//
// The viewer refreshes on the session's fs_changed event, and now also asks for
// the file's mtime every few seconds while the page is visible: a watcher that
// stops leaves the page subscribed but silent, and a file outside the watched
// directory never fired at all. Either way the preview stayed on the old text
// until the whole page was reloaded.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

test("an open Markdown preview shows a change made on disk", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-filerefresh-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  const file = path.join(workDir, "NOTE.md");
  writeFileSync(file, "# One\n");
  harness.trustWorkDir(workDir);

  try {
    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = (await created.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    await page.getByText("Session Files", { exact: true }).click();
    // The tree is fetched; under load it can take a while to list the file.
    await expect(page.getByText("NOTE.md", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByText("NOTE.md", { exact: true }).first().click();
    await page.getByTitle("Show preview").click();
    await expect(page.getByRole("heading", { name: "One" })).toBeVisible();

    // The way an editor writes it: a temp file renamed into place.
    writeFileSync(`${file}.tmp`, "# Two\n");
    renameSync(`${file}.tmp`, file);

    await expect(page.getByRole("heading", { name: "Two" })).toBeVisible({ timeout: 15_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
