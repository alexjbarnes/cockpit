// Scrolling up a long chat keeps your place when older messages are added
// above. The chat renders the newest messages first and adds older ones as you
// near the top, and the browser's scroll anchoring is what normally keeps the
// message you are reading where it is. Chromium skips anchoring when the list is
// at exactly the top, which is where a flick on a phone always stops: the older
// messages pushed everything down and the view landed at the start of the
// conversation, a screenful or more away from where you were. Safari has no
// anchoring at all.
//
// Driven on the real CLI at phone size: build a long conversation, reload it,
// and walk up a screen at a time, checking each step moves the view about a
// screen rather than leaping back to the first message.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import type { TurnScript } from "../mock-api/types";
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
test.use({ viewport: { width: 393, height: 760 }, hasTouch: true, isMobile: true });

const TURNS = 34;

test("walking up a long chat never leaps to its start when older messages are added", async ({ page, harness }) => {
  test.setTimeout(600_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-topinsert-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    // Enough turns that the page renders only the newest messages and adds the
    // older ones while scrolling up.
    const script: TurnScript[] = [{ match: '"json_schema"', events: textResponse('{"title":"Long chat"}') }];
    for (let t = 0; t < TURNS; t++) {
      script.push({ events: toolUseResponse("Bash", { command: `seq 1 30 # turn ${t}`, description: `Turn ${t}` }) });
      script.push({ events: textResponse(`Reply ${t}.`) });
    }
    harness.mock.setScript(script);

    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);
    for (let t = 0; t < TURNS; t++) {
      // Words after the number, or the bubble's time runs into it.
      await page.getByTestId("message-input").fill(`turn ${t} please`);
      await page.getByTestId("btn-send").click();
      await expect(page.getByText(`Reply ${t}.`, { exact: true })).toBeVisible({ timeout: 60_000 });
    }

    // Come back to it fresh, the way a phone does.
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

    let added = false;
    let before = await turnInView();
    for (let step = 0; step < 40 && before.turn !== 0; step++) {
      const rendered = await scroller.locator("[data-message-id]").count();
      // A screen up, or a flick to the very top once that is near: the flick
      // always comes to rest at exactly 0, which is the case that leapt.
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollTop < 1000 ? 0 : el.scrollTop - 500;
      });
      await page.waitForTimeout(700);
      const after = await turnInView();
      if ((await scroller.locator("[data-message-id]").count()) > rendered) added = true;
      expect(after.turn, `step ${step}: the view should still show a turn`).not.toBeNull();
      // A screen is about two turns here, and a flick to the top from under
      // 1000px about four. Older messages added above must not carry the view
      // further than the scroll itself did.
      expect(
        (before.turn as number) - (after.turn as number),
        `step ${step}: from turn ${before.turn} (scrollTop ${before.scrollTop}) to turn ${after.turn} (scrollTop ${after.scrollTop})`,
      ).toBeLessThanOrEqual(5);
      before = after;
    }
    expect(added, "older messages were added while walking up, or the test proved nothing").toBe(true);
    expect(before.turn, "and walking up does reach the start").toBe(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
