// A question raised by a session you are NOT looking at can be answered from
// the banner, without leaving the session you are in: the banner offers
// "Answer", opens the same prompt the session itself would show, and sends the
// same ws message that prompt sends.
//
// The point is the round trip: the CLI has to carry on from the answer, which
// only the mock seeing a second request proves.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { askUserQuestionResponse, textResponse } from "../mock-api/builder";
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

/** Creates a session and opens it, which is what makes this client its viewer. */
async function openSession(page: Page, harness: Harness, workDir: string): Promise<string> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // The eager spawn from session:connect has to finish, or the first send races
  // a second one.
  await page.waitForTimeout(5000);
  return sessionId;
}

/**
 * Send a message to a session the way a client does, over the websocket with a
 * real token, but without reporting that anyone is looking at it: being open on
 * a session is exactly what makes a client count as watching it, and the banner
 * here is for a session nobody is watching.
 */
async function driveSession(page: Page, harness: Harness, sessionId: string, text: string): Promise<void> {
  const tokenRes = await page.request.get(`${harness.cockpitUrl}/api/auth/ws-token`);
  const { token } = (await tokenRes.json()) as { token: string };
  const wsUrl = `${harness.cockpitUrl.replace(/^http/, "ws")}/ws?token=${token}`;
  await page.evaluate(
    ({ wsUrl, sessionId, text }) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.onerror = () => reject(new Error("websocket failed"));
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "session:connect", sessionId }));
          // The connect has to spawn the CLI before a message can go anywhere.
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "message:send", sessionId, text }));
            setTimeout(() => {
              ws.close();
              resolve();
            }, 1500);
          }, 4000);
        };
      }),
    { wsUrl, sessionId, text },
  );
}

test("a question from another session is answered from the banner", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
  expect(patched.ok()).toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-answerq-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([
      {
        events: askUserQuestionResponse([
          {
            question: "Which roaster should this apply to?",
            header: "Scope",
            multiSelect: false,
            options: [
              { label: "Just this one", description: "Only the listing in front of you" },
              { label: "Every roaster", description: "Applies the rule everywhere" },
            ],
          },
        ]),
      },
      { events: textResponse("Applied to every roaster.") },
    ]);

    // The page the user is looking at; it must stay theirs throughout.
    const watchingId = await openSession(page, harness, workDir);

    // The one that asks, driven over the socket so the page never opens it.
    const asking = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId: askingId } = (await asking.json()) as { sessionId: string };
    await driveSession(page, harness, askingId, "which roaster");

    const banner = page.getByTestId("session-alert-question");
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText("Which roaster should this apply to?");

    // Answer it in place: the banner's own prompt, not the session's page.
    await page.getByTestId("session-alert-answer").click();
    await banner.getByText("Every roaster").first().click();
    await banner.getByRole("button", { name: "Submit" }).click();

    // Answered: the banner goes, and the CLI carried on — its second request is
    // proof the answer reached the session rather than only clearing a card.
    await expect(banner).toBeHidden({ timeout: 30_000 });
    await expect
      .poll(() => harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages").length, { timeout: 60_000 })
      .toBeGreaterThan(1);
    expect(page.url(), "the page stayed where it was").toContain(watchingId);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
