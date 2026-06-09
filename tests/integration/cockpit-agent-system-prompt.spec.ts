// Integration test: the cockpit-agent system prompt reaches the model as
// system content (not as a chat message).
//
// Creates a cockpit-agent session, sends one message, then inspects the mock
// API's recorded /v1/messages request body for the sentinel string in the
// `system` field. If the sentinel is in `system`, it is invisible in the chat
// transcript (the model sees it; the user never reads it as a message).
//
// Skips cleanly if no CLI on PATH.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COCKPIT_AGENT_PROMPT_SENTINEL } from "../../src/server/mcp/cockpit-agent-prompt";
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

test("cockpit-agent system prompt reaches the model as system content", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-cwd-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    harness.mock.setScript([{ events: textResponse("Hello from mock") }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", cockpitAgent: true },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    expect(sessionId).toBeTruthy();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);

    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    await page.waitForTimeout(5000);
    await input.fill("hi");
    await page.getByTestId("btn-send").click();

    await expect(page.getByText("Hello from mock")).toBeVisible({ timeout: 30_000 });

    // Find the first /v1/messages request and check its `system` field
    const v1Requests = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages");

    expect(v1Requests.length).toBeGreaterThanOrEqual(1);
    const bodies = v1Requests.map((r) => JSON.parse(r.body));

    // The `system` field may be a string or an array of content blocks.
    const hasSentinel = bodies.some((b) => {
      if (!b.system) return false;
      if (typeof b.system === "string") return b.system.includes(COCKPIT_AGENT_PROMPT_SENTINEL);
      if (Array.isArray(b.system)) return b.system.some((s: { text?: string }) => s.text?.includes(COCKPIT_AGENT_PROMPT_SENTINEL));
      return false;
    });
    expect(hasSentinel).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
