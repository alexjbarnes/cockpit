// A session that is not the one on screen raises a banner, and a permission can
// be approved from that banner without leaving what you were doing. Driven
// through the real CLI: the whole point is that this fires from the actual
// permission path, not from a fixture.

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

async function openSession(page: Page, harness: Harness, workDir: string, name: string): Promise<string> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty", name } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // The eager spawn from session:connect has to finish, or the first send races
  // a second one.
  await page.waitForTimeout(5000);
  return sessionId;
}

test("a permission in another session raises a banner, and Approve answers it there", async ({ page, harness }) => {
  // Two sessions to spawn, plus a real CLI turn for the prompt.
  test.setTimeout(180_000);
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
  expect(patched.ok()).toBe(true);
  const stored = (await (await page.request.get(`${harness.cockpitUrl}/api/defaults`)).json()) as { sessionAlerts?: boolean };
  expect(stored.sessionAlerts, "the switch the server reads must be on").toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-alerts-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  // Registered before the page connects: the socket is created on load, and a
  // listener added afterwards never sees it.
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));

  try {
    // The page the user is looking at, which must stay theirs throughout.
    await openSession(page, harness, workDir, "Watching session");

    // Manual, or the harness's auto mode answers an ordinary Bash call itself
    // and there is no card to be waiting on.
    const manual = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { permissionMode: "manual" } });
    expect(manual.ok()).toBe(true);

    // A command the CLI will not wave through on its own: `echo` is on its
    // safe list and runs without asking, whatever the permission mode says.
    harness.mock.setScript([
      { events: toolUseResponse("Bash", { command: "rm -rf build", description: "Remove the build directory" }) },
      { events: textResponse("Removed it.") },
    ]);

    const other = await page.context().newPage();
    await openSession(other, harness, workDir, "Waiting session");
    await other.getByTestId("message-input").fill("clear the build directory");
    await other.getByTestId("btn-send").click();
    await expect(other.getByTestId("permission-prompt")).toBeVisible({ timeout: 30_000 });

    // The banner lands on the first page, naming the other session and the
    // command, without that page having opened anything.
    const banner = page.getByTestId("session-alert-permission");
    await expect
      .poll(() => frames.some((f) => f.includes("session:attention")), { timeout: 20_000 })
      .toBe(true)
      .catch(() => {
        throw new Error(
          `no attention frame; frames: ${frames
            .filter((f) => f.includes("session"))
            .slice(-6)
            .join(" | ")
            .slice(0, 600)}`,
        );
      });
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("Waiting session");
    await expect(banner).toContainText("rm -rf build");
    expect(page.url(), "the page stayed where it was").not.toContain("Waiting");

    await page.getByTestId("session-alert-approve").click();

    // Answered from the banner: the other session's card clears (the resolved
    // broadcast) and the banner goes with it.
    await expect(other.getByTestId("permission-prompt")).toBeHidden({ timeout: 20_000 });
    await expect(banner).toBeHidden({ timeout: 20_000 });
    await expect(other.getByText("Removed it.")).toBeVisible({ timeout: 20_000 });

    await other.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
