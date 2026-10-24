// What a phone running the installed app sees around notifications.
//
// Tapping a notification while the app was open reloaded the whole app: the
// service worker called client.navigate(), which drops the connection and
// fetches everything again. And a page that reconnected stopped counting as
// watching its session, because the server keeps that per connection and the
// page only said so on load and on visibility changes, so a notification came
// through for the session on screen.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
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

async function createSession(page: Page, harness: Harness, workDir: string, name: string): Promise<string> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty", name } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

/** Sends a session a message over its own websocket, which watches nothing. */
async function driveSession(page: Page, harness: Harness, sessionId: string, text: string): Promise<void> {
  const { token } = (await (await page.request.get(`${harness.cockpitUrl}/api/auth/ws-token`)).json()) as { token: string };
  const wsUrl = `${harness.cockpitUrl.replace(/^http/, "ws")}/ws?token=${token}`;
  await page.evaluate(
    ({ wsUrl, sessionId, text }) =>
      new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.onerror = () => reject(new Error("websocket failed"));
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "message:send", sessionId, text }));
          setTimeout(() => {
            ws.close();
            resolve();
          }, 1500);
        };
      }),
    { wsUrl, sessionId, text },
  );
}

test.describe("notifications in the installed app", () => {
  let workDir: string;

  test.beforeEach(({ harness }) => {
    workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-pwa-"));
    mkdirSync(path.join(workDir, ".git"), { recursive: true });
    harness.trustWorkDir(workDir);
  });

  test.afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("tapping a notification moves the open app without reloading it", async ({ page, context, harness }) => {
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));

    const sessionId = await createSession(page, harness, workDir, "Tapped session");
    await page.goto(`${harness.cockpitUrl}/`);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15_000 }).toBe(true);
    await page.evaluate(() => {
      (window as unknown as { tourMarker: number }).tourMarker = 42;
    });
    const before = sockets.length;

    // A tap on the notification's body, as the browser delivers it.
    const target = `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
    const [worker] = context.serviceWorkers();
    // Headless Chromium shows no notifications, so the event carries a stand-in
    // with the parts the handler reads.
    await worker.evaluate(async (url) => {
      // A synthetic tap is not allowed to focus the window; that rejection is
      // not what this test is about.
      let work: Promise<unknown> = Promise.resolve();
      const tap = Object.assign(new Event("notificationclick"), {
        action: "",
        notification: { data: { url }, close() {} },
        waitUntil(promise: Promise<unknown>) {
          work = promise;
        },
      });
      self.dispatchEvent(tap);
      await work.catch(() => {});
    }, target);

    await expect(page).toHaveURL(target, { timeout: 10_000 });
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The same document: nothing reloaded, and no new connection was made.
    expect(await page.evaluate(() => (window as unknown as { tourMarker?: number }).tourMarker)).toBe(42);
    expect(sockets.length).toBe(before);
  });

  test("a page that reconnects still counts as watching its session", async ({ page, context, harness }) => {
    test.setTimeout(150_000);
    const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
    expect(patched.ok()).toBe(true);
    harness.mock.setScript([{ events: textResponse("All done here.") }]);

    // The page on the session, with its connection under the test's control.
    const routes: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      routes.push({ page: ws, server: ws.connectToServer() });
    });
    const sessionId = await createSession(page, harness, workDir, "Watched session");
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("btn-send")).toBeVisible({ timeout: 15_000 });
    // The eager spawn from session:connect has to finish before a message.
    await page.waitForTimeout(5000);

    // Another page, which hears about any session nobody is watching.
    const other = await context.newPage();
    const attention: string[] = [];
    other.on("websocket", (ws) =>
      ws.on("framereceived", (frame) => {
        const payload = String(frame.payload);
        if (payload.includes('"type":"session:attention"')) attention.push(payload);
      }),
    );
    await other.goto(`${harness.cockpitUrl}/`);

    // The connection drops, at both ends, and the page makes a new one.
    await routes[0].server.close();
    await routes[0].page.close();
    await expect.poll(() => routes.length, { timeout: 10_000 }).toBe(2);
    await expect(page.getByTestId("btn-send")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1000);

    await driveSession(other, harness, sessionId, "say something");
    await expect(page.getByText("All done here.")).toBeVisible({ timeout: 60_000 });
    // The turn is over once the page offers Send again, and a finished turn in
    // a session someone is watching tells nobody.
    await expect(page.getByTestId("btn-send")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2000);
    expect(attention.filter((payload) => payload.includes(sessionId))).toEqual([]);
    await other.close();
  });
});
