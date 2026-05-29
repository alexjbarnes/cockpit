// Regression: structured AskUserQuestion must render after a reconnect.
//
// Background — May 2026: in PTY mode, sending an AskUserQuestion mid-turn
// could leave the session "stuck processing" because the chat view showed
// neither the inline question prompt nor the standalone one. Pressing stop
// would unblock it. Root cause was the order of WebSocket messages on
// reconnect:
//
//   server: history (with assistant msg containing tool_use AskUserQuestion)
//   ...
//   server: question:request  ← arrived AFTER history
//
// On the client, chat-view's Place1 (inline render) needs both the message
// AND a pending question entry to show the prompt. Between history arriving
// and question:request arriving, Place1 had the block but pending was empty,
// so it rendered null. Place2 (standalone) was suppressed because the inline
// block existed. Result: nothing visible until pendingQuestions was populated.
//
// Fix: on session:connect the server now re-sends pending question/permission
// requests BEFORE history, so the client has pendingQuestions populated
// before processing the history snapshot.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { askUserQuestionResponse } from "../mock-api/builder";
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

test("structured question renders on reconnect after the assistant message is already in history", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-q-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    harness.mock.setScript([
      {
        events: askUserQuestionResponse([
          {
            question: "What color?",
            header: "Color",
            multiSelect: false,
            options: [
              { label: "Red", description: "Like a rose" },
              { label: "Blue", description: "Like the sky" },
            ],
          },
        ]),
      },
    ]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    const sessionUrl = `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
    await page.goto(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000); // let the PTY finish initial spawn

    // Trigger the AskUserQuestion turn.
    await page.getByTestId("message-input").fill("hi");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("What color?")).toBeVisible({ timeout: 30_000 });

    // Reload — this is the failure mode. Capture every server→client WS
    // frame and assert the *order*: question:request must arrive BEFORE
    // history. With the bug, history arrived first, leaving an ~80–200ms
    // window where Place1 had the block but no pending entry, so nothing
    // rendered. In real-world latency that window stays open and the chat
    // looks permanently stuck.
    const serverFrames: string[] = [];
    page.on("websocket", (ws) => {
      ws.on("framereceived", (f) => {
        const payload = typeof f.payload === "string" ? f.payload : f.payload.toString();
        // Capture just the type to keep noise down.
        const match = payload.match(/^\{"type":"([^"]+)"/);
        if (match) serverFrames.push(match[1]);
      });
    });

    await page.reload();
    await expect(page.getByText("What color?")).toBeVisible({ timeout: 10_000 });

    const historyIdx = serverFrames.indexOf("history");
    const questionIdx = serverFrames.indexOf("question:request");
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(questionIdx).toBeLessThan(historyIdx);

    await expect(page.getByRole("button", { name: /Red/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Blue/ })).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
