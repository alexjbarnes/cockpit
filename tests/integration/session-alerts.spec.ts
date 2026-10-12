// A session that is not the one on screen raises a banner, and a permission can
// be approved from that banner without leaving what you were doing. Driven
// through the real CLI: the whole point is that this fires from the actual
// permission path, not from a fixture.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
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
async function openSession(page: Page, harness: Harness, workDir: string, name: string): Promise<string> {
  const sessionId = await createSession(page, harness, workDir, name);
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  // The eager spawn from session:connect has to finish, or the first send races
  // a second one.
  await page.waitForTimeout(5000);
  return sessionId;
}

async function createSession(page: Page, harness: Harness, workDir: string, name: string): Promise<string> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty", name } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return sessionId;
}

/**
 * Send a message to a session the way a client does — over the websocket, with
 * a real token — but without reporting that anyone is looking at it. A second
 * browser page would: being open on the session is exactly what makes a client
 * count as watching it, and the alerts these tests are about are the ones for
 * a session nobody is watching.
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

test("a turn finishing in another session raises a banner too", async ({ page, harness }) => {
  test.setTimeout(150_000);
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
  expect(patched.ok()).toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-alerts-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    await openSession(page, harness, workDir, "Watching session");

    harness.mock.setScript([{ events: textResponse("All done here.") }]);

    const busy = await createSession(page, harness, workDir, "Busy session");
    await driveSession(page, harness, busy, "say something");

    // The page that was not involved gets told, and the banner names what
    // happened rather than the session's card being the only sign of it.
    const banner = page.getByTestId("session-alert-finished");
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText("Busy session");
    await expect(banner).toContainText("finished a turn");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a permission in another session raises a banner, and Approve answers it there", async ({ page, harness }) => {
  // Two sessions to spawn, plus a real CLI turn for the prompt.
  test.setTimeout(180_000);
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
  expect(patched.ok()).toBe(true);
  const stored = (await (await page.request.get(`${harness.cockpitUrl}/api/defaults`)).json()) as { sessionAlerts?: boolean };
  expect(stored.sessionAlerts, "the switch the server reads must be on").toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-alerts-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  // Registered before the page connects: the socket is created on load, and a
  // listener added afterwards never sees it.
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));

  try {
    // The page the user is looking at, which must stay theirs throughout.
    await openSession(page, harness, workDir, "Watching session");

    // Manual, or the harness's auto mode answers an ordinary Bash call itself
    // and there is no card to be waiting on.
    const manual = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { permissionMode: "manual" } });
    expect(manual.ok()).toBe(true);

    // A command the CLI will not wave through on its own: `echo` is on its
    // safe list and runs without asking, whatever the permission mode says.
    harness.mock.setScript([
      { events: toolUseResponse("Bash", { command: "rm -rf build", description: "Remove the build directory" }) },
      { events: textResponse("Removed it.") },
    ]);

    const waiting = await createSession(page, harness, workDir, "Waiting session");
    await driveSession(page, harness, waiting, "clear the build directory");

    // The banner lands on the first page, naming the other session and the
    // command, without that page having opened anything.
    const banner = page.getByTestId("session-alert-permission");
    await expect
      .poll(() => frames.some((f) => f.includes("session:attention")), { timeout: 20_000 })
      .toBe(true)
      .catch(() => {
        throw new Error(
          `no attention frame; frames: ${frames
            .filter((f) => f.includes("session"))
            .slice(-6)
            .join(" | ")
            .slice(0, 600)}`,
        );
      });
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText("Waiting session");
    await expect(banner).toContainText("rm -rf build");
    expect(page.url(), "the page stayed where it was").not.toContain("Waiting");

    await page.getByTestId("session-alert-approve").click();

    // Answered from the banner: the banner goes (the resolved broadcast), and
    // the CLI carried on — its second request is proof the approval reached it
    // rather than only clearing a card.
    await expect(banner).toBeHidden({ timeout: 20_000 });
    await expect
      .poll(() => harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages").length, { timeout: 60_000 })
      .toBeGreaterThan(1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a scheduled job finishing raises no banner", async ({ page, harness }) => {
  // A job's outcome goes to its run records and the inbox, with the notify
  // targets its author chose. The in-app banner is for the sessions you are
  // working in, and every job ending over the top of one is noise.
  test.setTimeout(150_000);
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
  expect(patched.ok()).toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-alerts-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));

  try {
    // Somewhere to be when the job ends.
    await openSession(page, harness, workDir, "Watching session");

    harness.mock.setScript([{ events: textResponse("Job done.") }]);
    const jobRes = await page.request.post(`${harness.cockpitUrl}/api/jobs`, {
      data: {
        name: "Quiet job",
        prompt: "do the thing",
        cwd: workDir,
        runtime: "pty",
        schedules: [{ type: "simple", frequency: "daily", time: "09:00" }],
        enabled: false,
      },
    });
    expect(jobRes.ok()).toBe(true);
    const { job } = (await jobRes.json()) as { job: { id: string } };

    const runRes = await page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`);
    expect(runRes.ok()).toBe(true);
    // The job has to have actually run and finished, or "no banner" proves
    // nothing: its run record is the evidence that a turn ended at all.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${harness.cockpitUrl}/api/jobs/${job.id}/runs`);
          const data = (await res.json()) as { runs?: Array<{ status: string }> };
          return (data.runs ?? []).some((run) => run.status === "success" || run.status === "failure");
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    const attention = frames.filter((f) => f.includes("session:attention"));
    expect(attention, `job sessions must stay out of it: ${attention.join(" | ").slice(0, 300)}`).toEqual([]);
    await expect(page.getByTestId("session-alert-finished")).toHaveCount(0);
    await expect(page.getByTestId("session-alerts")).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a session you are looking at stays quiet; the same one notifies once you leave it", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { sessionAlerts: true } });
  expect(patched.ok()).toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-alerts-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));

  try {
    harness.mock.setScript([{ events: textResponse("First reply.") }, { events: textResponse("Second reply.") }]);
    const sessionId = await openSession(page, harness, workDir, "Watched session");
    const announced = () => frames.filter((f) => f.includes("session:attention") && f.includes(sessionId));

    // Watched: it ends in front of the user, who does not need telling.
    await page.getByTestId("message-input").fill("say something");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("First reply.")).toBeVisible({ timeout: 60_000 });
    expect(announced(), `nothing should announce a session being watched: ${announced().join(" | ").slice(0, 200)}`).toEqual([]);

    // Send again and leave straight away: the turn ends with nobody watching,
    // which is exactly the case the notification is for.
    await page.getByTestId("message-input").fill("say something else");
    await page.getByTestId("btn-send").click();
    await page.goto(`${harness.cockpitUrl}/inbox`);
    await expect.poll(() => announced().length, { timeout: 60_000 }).toBeGreaterThan(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
