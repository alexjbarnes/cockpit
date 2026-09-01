// Messages that never reach the CLI around a compaction.
//
// Reported live (Mac, 2026-08-18): the debug log shows `dispatched PostCompact
// ... ok` and then every subsequent send swallowed — three typed attempts each,
// repeatedly, for over a minute. A manual /compact is the one path that reports
// idle at PostCompact (session-manager.ts: the `!auto` guard — an auto-compact
// resumes its own turn, so only a manual one has no turn left to finish), so it
// is the one path that can hand the user an input box while the REPL is not
// actually ready for one.
//
// The first test here covers a second failure found while reproducing that one:
// the CLI can REFUSE a compaction ("Not enough messages to compact."), in which
// case no PreCompact/PostCompact hook ever fires and nothing else clears
// session.compacting — so every later message queues behind a compaction that
// will never finish.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse } from "../mock-api/builder";
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

async function openSession(page: import("@playwright/test").Page, harness: Harness, workDir: string): Promise<void> {
  const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
    data: { cwd: workDir, runtime: "pty" },
  });
  expect(createRes.ok()).toBe(true);
  const { sessionId } = await createRes.json();
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // Let session:connect's eager ensureProcess finish spawning the PTY before we
  // send, so the first message does not race a second spawn.
  await page.waitForTimeout(5000);
}

async function send(page: import("@playwright/test").Page, text: string): Promise<void> {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

test("a refused /compact does not wedge the session", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-nocompact-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("first reply") }, { events: textResponse("second reply") }]);
    await openSession(page, harness, workDir);

    await send(page, "first message");
    await expect(page.getByText("first reply")).toBeVisible({ timeout: 30_000 });

    // One exchange is below the CLI's threshold, so it declines rather than
    // compacting — no PreCompact, no PostCompact, no hooks at all.
    await send(page, "/compact");
    await expect(page.getByText("Not enough messages to compact.")).toBeVisible({ timeout: 30_000 });

    // Nothing else clears session.compacting, so this queues behind a
    // compaction that already finished by declining, and never goes anywhere.
    await send(page, "second message");
    await expect(page.getByText("second reply"), "a declined compaction must not swallow the next message").toBeVisible({
      timeout: 45_000,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a message sent after a real /compact still reaches the CLI", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-compact-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  const EXCHANGES = 4;

  try {
    harness.mock.setScript([
      ...Array.from({ length: EXCHANGES }, (_, i) => ({ events: textResponse(`reply ${i + 1}`) })),
      // The compaction's own summarisation call.
      { events: textResponse("Summary of the conversation so far.") },
      { events: textResponse("post-compact reply") },
    ]);
    await openSession(page, harness, workDir);

    // Enough turns that the CLI actually compacts instead of declining.
    for (let i = 1; i <= EXCHANGES; i++) {
      await send(page, `message ${i}`);
      await expect(page.getByText(`reply ${i}`)).toBeVisible({ timeout: 30_000 });
    }

    await send(page, "/compact");
    await page.waitForTimeout(25_000);

    await send(page, "after the compact");
    // The reported failure: the send is swallowed and the delivery retry gives
    // up with this banner. Name it, so a reproduction reads as itself rather
    // than as a bare timeout.
    await expect(page.getByText(/never reached Claude/)).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("post-compact reply")).toBeVisible({ timeout: 30_000 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
