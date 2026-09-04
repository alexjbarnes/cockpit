// Who enforces plan mode: the CLI, or cockpit's answer to the permission hook?
//
// This decides whether bypass may auto-approve while a session is planning.
// It used to be barred from doing so, which meant a session already in bypass
// got a permission card for every tool once it entered plan mode — and
// "Bypass All" on that card is a no-op when bypass is already on, so there was
// no way to stop them.
//
// If the CLI holds the line itself, relaxing that gate cannot let an edit
// through: a request that reaches cockpit in plan mode is one the CLI had
// already judged plan-safe, and the gate only bought a manual click.
//
// Note on scope: the harness cannot reproduce the reported symptom, because
// the tools it can script (Bash, the cockpit MCP tools) raise no card in plan
// mode at all. The live case involved a project MCP server this harness does
// not have. The gate's own behaviour is covered in tests/session-manager.test.ts
// ("keeps bypassing tool prompts once the session enters plan mode"); what is
// proved here is the safety property that change rests on.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("plan mode blocks a write even when cockpit answers allow", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-planwrite-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  const target = path.join(workDir, "should-not-exist.txt");

  try {
    harness.mock.setScript([
      { events: toolUseResponse("Write", { file_path: target, content: "plan mode should stop this" }) },
      { events: textResponse("I cannot write while planning.") },
    ]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The eager spawn from session:connect has to finish, or the first send
    // races a second one.
    await page.waitForTimeout(5000);

    await page.getByTitle("Switch to Plan mode (Tab)").click();
    // setPlanMode kills the process so it respawns with --permission-mode plan.
    await expect(page.getByTitle("Switch to Build mode (Tab)")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(5000);

    await page.getByTestId("message-input").fill("write the file");
    await page.getByTestId("btn-send").click();

    // Answer allow if cockpit even offers the choice — the point is that
    // cockpit's answer is not what decides this.
    const card = page.getByTestId("permission-prompt");
    if (await card.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await page.getByTestId("btn-allow").click();
    }
    await expect(page.getByText("I cannot write while planning.")).toBeVisible({ timeout: 30_000 });

    expect(existsSync(target), "the CLI enforces plan mode itself; approving cannot unlock a write").toBe(false);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
