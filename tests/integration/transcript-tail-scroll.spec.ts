// A PTY session's chat keeps its earlier messages once the transcript has
// moved past them, and a reader scrolled up to them stays where they are.
//
// The transcript watcher sends only the transcript's last 150 lines. Replacing
// the page's list with them would take away everything older on each update,
// and with it the message being read, which leaves the view at the bottom.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse } from "../mock-api/builder";
import type { SSEScriptEvent } from "../mock-api/types";
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

/** One assistant message of `count` text blocks. The CLI writes each block to
 *  the transcript as its own line, so one reply pushes earlier turns out of
 *  the tail. */
function manyBlockResponse(count: number): SSEScriptEvent[] {
  const events: SSEScriptEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `mock_many_${count}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-6",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    },
  ];
  for (let i = 0; i < count; i++) {
    events.push({
      event: "content_block_start",
      data: { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
    });
    events.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: i, delta: { type: "text_delta", text: `Block ${i + 1}.` } },
    });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: i } });
  }
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: count },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

async function send(page: Page, text: string) {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

function transcriptLines(claudeDir: string, sessionId: string): number {
  const projects = path.join(claudeDir, "projects");
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    try {
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim()).length;
    } catch {}
  }
  return 0;
}

test("earlier messages stay on the page, and in view, after the transcript tail moves past them", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-tail-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([
      { events: textResponse("Reply one.") },
      { events: manyBlockResponse(200) },
      { events: textResponse("Reply three.") },
    ]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    const url = `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
    await page.goto(url);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The eager spawn from session:connect has to finish, or the send races a
    // second one.
    await page.waitForTimeout(5000);

    await send(page, "hello");
    await expect(page.getByText("Reply one.")).toBeVisible({ timeout: 30_000 });
    await send(page, "a long one");
    await expect(page.getByText("Block 200.", { exact: true })).toBeVisible({ timeout: 30_000 });
    // Past the watcher's 150-line tail, so the first exchange is no longer in it.
    expect(transcriptLines(harness.claudeDir, sessionId)).toBeGreaterThan(150);
    // A transcript update lands after the reply renders; give it time to.
    await page.waitForTimeout(1500);
    await expect(page.getByText("Reply one.")).toBeAttached();

    // Read the first exchange while a message sent from another tab adds more.
    const scroller = page.locator("[data-chat-scroll]");
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByText("Reply one.")).toBeInViewport();

    const other = await page.context().newPage();
    await other.goto(url);
    await expect(other.getByTestId("message-input")).toBeVisible();
    await send(other, "and again");
    await expect(other.getByText("Reply three.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Reply three.")).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(1500);

    await expect(page.getByText("Reply one.")).toBeInViewport();
    await other.close();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
