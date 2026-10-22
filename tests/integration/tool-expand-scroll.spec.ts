// Opening a tool card keeps the reader's place while older messages land above.
//
// Scrolling near the top asks for older history, and the chat keeps the reader
// in place when it lands. It noted the reader's place only near the top, or
// while the request was outstanding, and the loading spinner's own arrival
// cleared that, so history that landed after the reader had moved on (reading
// down the page, then opening a card that scrolls itself into view) put the
// view back where it had been when the history was asked for.
//
// Driven on the real CLI at a desktop size, with older history held back until
// the card's scroll is under way, the way a slow read of a long history lands.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import type { SSEScriptEvent, TurnScript } from "../mock-api/types";
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
test.use({ viewport: { width: 1280, height: 800 } });

const TURNS = 24;

/** A reply of several text blocks, each its own transcript line, so the
 *  transcript outgrows what a reload reads and older turns load on scrolling
 *  up. */
function longReply(turn: number, blocks: number): SSEScriptEvent[] {
  const texts = [...Array.from({ length: blocks - 1 }, (_, i) => `Note ${i + 1} on this turn.`), `Reply ${turn}.`];
  const events: SSEScriptEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `mock_reply_${turn}`,
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
  texts.forEach((text, index) => {
    events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
    events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: blocks },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

test("opening a tool card keeps the reader's place while older messages land above", async ({ page, harness }) => {
  test.setTimeout(600_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-expand-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const script: TurnScript[] = [{ match: '"json_schema"', events: textResponse('{"title":"Long chat"}') }];
    for (let t = 0; t < TURNS; t++) {
      script.push({ events: toolUseResponse("Bash", { command: `seq 1 40 # turn ${t}`, description: `Turn ${t}` }) });
      script.push({ events: longReply(t, 8) });
    }
    harness.mock.setScript(script);

    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);
    for (let t = 0; t < TURNS; t++) {
      await page.getByTestId("message-input").fill(`turn ${t} please`);
      await page.getByTestId("btn-send").click();
      await expect(page.getByText(`Reply ${t}.`, { exact: true })).toBeVisible({ timeout: 60_000 });
    }

    // Older history comes back only when the test lets it.
    const held: string[] = [];
    let release = () => {};
    await page.routeWebSocket(/\/ws\?token=/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string" && message.includes('"type":"history:more"')) held.push(message);
        else ws.send(message);
      });
      release = () => {
        for (const message of held.splice(0)) ws.send(message);
      };
    });
    await page.reload();
    await expect(page.getByText(`Reply ${TURNS - 1}.`, { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2000);

    const scroller = page.locator("[data-chat-scroll]");
    // The turn the reader is looking at: the number in the first message in view.
    const turnInView = () =>
      scroller.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const first = [...el.querySelectorAll("[data-message-id]")].find((m) => m.getBoundingClientRect().bottom > top + 4);
        // Times ("12:30") sit right after the text they belong to; drop them first.
        const text = (first?.textContent ?? "").replace(/\d{1,2}:\d{2}/g, " ");
        const match = text.match(/(?:turn|Reply) (\d+)/);
        return { scrollTop: Math.round(el.scrollTop), turn: match ? Number(match[1]) : null };
      });

    // Up a screen at a time until the chat asks for older history, which
    // stays held: the reader is near the top, with older messages on the way.
    for (let step = 0; step < 30 && held.length === 0; step++) {
      await scroller.evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollTop - 400);
      });
      await page.waitForTimeout(500);
    }
    expect(held.length, "the chat asked for older history").toBeGreaterThan(0);

    // The reader reads on, down the page, and opens a closed Bash card at the
    // bottom of the view, so it runs past the bottom and the chat scrolls to
    // show it. Scrolling asks for nothing more while the history is on its way.
    const picked = await scroller.evaluate((el) => {
      const view = el.getBoundingClientRect();
      const headers = [...el.querySelectorAll<HTMLButtonElement>("button")].filter(
        (b) => b.textContent?.startsWith("Bash") && !b.nextElementSibling,
      );
      for (const b of headers) {
        const target = el.scrollTop + b.getBoundingClientRect().bottom - (view.bottom - 40);
        if (target < 1200 || target > el.scrollHeight - el.clientHeight - 400) continue;
        b.dataset.picked = "true";
        el.scrollTop = target;
        return true;
      }
      return false;
    });
    expect(picked, "a closed Bash card that can sit at the bottom of the view").toBe(true);
    await page.waitForTimeout(500);
    const header = page.locator("[data-picked=true]");
    const before = await turnInView();
    await header.click();
    // The older messages land while that scroll would still be under way.
    await page.waitForTimeout(40);
    release();
    await page.waitForTimeout(2000);
    const after = await turnInView();

    expect(after.turn, "the view still shows a turn").not.toBeNull();
    // Showing the opened card moves the view down by at most the card's
    // height, never back up into the older messages.
    expect(
      (after.turn as number) - (before.turn as number),
      `from turn ${before.turn} (scrollTop ${before.scrollTop}) to turn ${after.turn} (scrollTop ${after.scrollTop})`,
    ).toBeGreaterThanOrEqual(0);
    expect((after.turn as number) - (before.turn as number)).toBeLessThanOrEqual(1);
    // And the card did open.
    expect(await header.evaluate((b) => b.nextElementSibling !== null)).toBe(true);
    expect(held, "the older history was handed over").toHaveLength(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
