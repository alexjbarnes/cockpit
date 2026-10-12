// The permission card shows what the tool is about to do: a Bash call's
// command in full, not the JSON wrapping it and not the eighty characters the
// one-line summary stops at. Anything longer than the card's collapsed size is
// readable on request.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
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

test("a permission card shows the whole command, on request", async ({ page, harness }) => {
  test.setTimeout(150_000);

  // Manual, or the harness's bypass default answers this itself.
  const manual = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { permissionMode: "manual" } });
  expect(manual.ok()).toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-permcard-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  // Long *and* something the CLI will not wave through on its own: printf,
  // like echo, is on its safe list and runs whatever the permission mode says.
  const command = `rm -rf ${Array.from({ length: 40 }, (_, i) => `build/artifact-${i}`).join(" ")}`;
  const tail = "artifact-39";

  try {
    harness.mock.setScript([
      { events: toolUseResponse("Bash", { command, description: "Print lines" }) },
      { events: textResponse("Done.") },
    ]);

    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    await page.getByTestId("message-input").fill("print the lines");
    await page.getByTestId("btn-send").click();

    const card = page.getByTestId("permission-prompt");
    await expect(card).toBeVisible({ timeout: 30_000 });

    const input = page.getByTestId("permission-input");
    await expect(input, "the command itself, not the JSON that carries it").toContainText("rm -rf build/artifact-0");
    await expect(input, "and the end of it is behind the toggle").not.toContainText(tail);

    await page.getByTestId("btn-toggle-permission-input").click();
    await expect(input).toContainText(tail);

    await card.getByTestId("btn-allow").click();
    await expect(page.getByText("Done.")).toBeVisible({ timeout: 30_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
