// Integration test: reproduce the reported cockpit-agent bug where using the
// /clear slash command leaves the agent unable to send ("can't find session",
// suspected wrong-transcript resume).
//
// Creates a cockpit-agent session, sends a message (writes a transcript for the
// current cliSessionId), /clear (cockpit kills the process and rotates the
// cliSessionId), then sends again — which must spawn a FRESH CLI session, not
// fail with a session-not-found / resume error. The /clear rotation and the
// transcriptExists-based resume decision are shared by both runtimes.
//
// Skips cleanly if no CLI on PATH.

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

for (const runtime of ["stream", "pty"] as const) {
  test(`cockpit agent survives /clear and can send again (${runtime})`, async ({ page, harness }) => {
    const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-clear-"));
    mkdirSync(path.join(workDir, ".git"), { recursive: true });

    try {
      harness.mock.setScript([{ events: textResponse("Reply before clear") }, { events: textResponse("Reply after clear") }]);

      const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
        data: { cwd: workDir, runtime, cockpitAgent: true },
      });
      expect(createRes.ok()).toBe(true);
      const { sessionId } = await createRes.json();
      expect(sessionId).toBeTruthy();

      await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
      const input = page.getByTestId("message-input");
      await expect(input).toBeVisible();
      await page.waitForTimeout(5000);

      // 1) First message: writes a transcript for the current cliSessionId.
      await input.fill("hi");
      await page.getByTestId("btn-send").click();
      await expect(page.getByText("Reply before clear")).toBeVisible({ timeout: 30_000 });

      // 2) /clear: cockpit intercepts it, kills the process, rotates cliSessionId.
      await input.fill("/clear");
      await page.getByTestId("btn-send").click();
      await page.waitForTimeout(3000);

      // 3) Send again: must spawn a fresh CLI session, not resume a missing transcript.
      await input.fill("hello again");
      await page.getByTestId("btn-send").click();

      const errorLocator = page.getByText(
        /Session not found|No conversation found|exited during startup|could not be found|Not logged in/i,
      );
      await expect
        .poll(
          async () => {
            if (await errorLocator.count()) return "error";
            if (await page.getByText("Reply after clear").count()) return "reply";
            return "pending";
          },
          { timeout: 30_000, intervals: [500] },
        )
        .not.toBe("pending");

      expect(await errorLocator.count(), `session error after /clear: "${(await errorLocator.allInnerTexts()).join(" | ")}"`).toBe(0);
      await expect(page.getByText("Reply after clear")).toBeVisible();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
}
