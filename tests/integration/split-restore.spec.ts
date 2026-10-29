// A session's split view comes back after a reload.
//
// The open tabs and the active tab were persisted per session; the split was
// not, so Command-R dropped the right pane every time. The split names tabs by
// id, which survives a reload unchanged, so it is stored alongside them.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a split view survives a reload", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-split-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  writeFileSync(path.join(workDir, "NOTE.md"), "# One\n");
  harness.trustWorkDir(workDir);

  try {
    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const url = `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
    await page.goto(url);
    await expect(page.getByTestId("message-input")).toBeVisible();

    await page.getByText("Session Files", { exact: true }).click();
    // The tree is fetched; under load it can take a while to list the file.
    await expect(page.getByText("NOTE.md", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByText("NOTE.md", { exact: true }).first().click();
    await page.getByTitle("Show preview").click();
    await expect(page.getByRole("heading", { name: "One" })).toBeVisible();

    // Split: the file takes the right pane, the chat stays on the left.
    await page.locator('button[title="Split view"]').click();
    await expect(page.locator('button[title="Close split view"]')).toBeVisible();

    // The server has it before the reload, so this is not a race.
    await expect
      .poll(async () => {
        const res = await page.request.get(`${harness.cockpitUrl}/api/sessions/${sessionId}/tabs`);
        const data = (await res.json()) as { splitTabId?: string | null };
        return data.splitTabId ?? null;
      })
      .toContain("file::");

    await page.reload();
    await expect(page.getByTestId("message-input")).toBeVisible();
    await expect(page.locator('button[title="Close split view"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: "One" })).toBeVisible();

    // Closing it is remembered too, so a reload does not resurrect the split.
    await page.locator('button[title="Close split view"]').click();
    await page.reload();
    await expect(page.getByTestId("message-input")).toBeVisible();
    await expect(page.locator('button[title="Split view"]')).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
