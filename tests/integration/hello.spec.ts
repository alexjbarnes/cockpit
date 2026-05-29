// First integration test: a user types "hi", the mock returns "Hello from
// mock", and the response renders in the chat view.
//
// Exercises the full layer cake: browser DOM → input WebSocket message →
// cockpit session-manager → CLI spawn with ANTHROPIC_BASE_URL pointing at
// the mock → SSE response → CLI writes JSONL → transcript-watcher emits to
// client → message bubble renders.

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

test("user sends 'hi' and receives 'Hello from mock' through the full stack", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-cwd-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    harness.mock.setScript([{ events: textResponse("Hello from mock") }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    expect(sessionId).toBeTruthy();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);

    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // Let session:connect's eager ensureProcess finish spawning the PTY before
    // we send. Without this, Playwright fires message:send while PtyRuntime
    // isAlive is still false and sendMessage races a second spawn.
    await page.waitForTimeout(5000);
    await input.fill("hi");
    await page.getByTestId("btn-send").click();

    await expect(page.getByText("Hello from mock")).toBeVisible({ timeout: 30_000 });

    // CLI hits /v1/messages?beta=true; strip the query when matching.
    const requests = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages");
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0].body).toContain('"hi"');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
