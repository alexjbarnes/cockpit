// Phase 1 of the issue-tracker spec ("the cockpit MCP server in every
// session") widens add_inbox_message from "scheduled jobs only" to "jobs and
// plain sessions". This is the delivery-path proof for that widening,
// mirroring job-inbox-tool.spec.ts but for a plain chat session instead of a
// job run: a real CLI has to actually be offered add_inbox_message (not just
// have the code path exist), call it, and have the report land in the inbox
// attributed to the session — not a job, since there is no job here.
//
// It also drives the two behaviours that only exist for a session caller and
// have no job equivalent: notifyProviders resolving to a real push attempt or
// a documented skip, and an interactive session that pushes too often getting
// throttled instead of a job (which reports once and is unaffected).
//
// These tests poll GET /api/inbox for the delivered entry rather than waiting
// for the mock's textResponse to render, and they do not assert on the tool's
// exact returned JSON (the "notified"/"skipped" shape, or the rate-limit
// error text) via request bodies or the rendered page. Confirmed by hand
// (COCKPIT_IT_DEBUG=1 plus request/page dumps) that after a single tool_use
// turn, this CLI version ends the turn (Stop hook fires, session goes idle)
// without ever sending the tool_result back to the model in a follow-up
// request, and nothing renders it in the DOM either — so there is no window
// through the CLI to observe what the tool told the model, only whether the
// call happened and what it wrote. That exact JSON contract (notified,
// skipped, the rate-limit message, all skip reasons) is proven directly
// against the MCP server in tests/cockpit-config-server.test.ts's "session
// confinement" and "session push rate limit" blocks instead, which is also
// where the task's own guidance points call-time detail that a CLI can't
// exercise. No existing spec in this repo drives a tool-calling conversation
// through a plain (non-job) session, so there was no precedent to follow.
//
// Scope refusal (delete_job etc.) for a session is proven in
// tests/cockpit-config-server.test.ts too: a CLI never offered a tool cannot
// exercise the call-time refusal layer, and the tools/list-omission layer is
// already exercised for a job caller in job-inbox-tool.spec.ts — re-running
// the same proof for a session would add wall-clock cost without covering
// new ground.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolUseResponse } from "../mock-api/builder";
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

const INBOX_TOOL = "mcp__cockpit-config__add_inbox_message";

type InboxEntry = { id: string; title: string; sessionId?: string; sessionName?: string; jobId?: string };

async function createPlainSession(page: import("@playwright/test").Page, cockpitUrl: string, cwd: string, name: string) {
  // bypassPermissions is load-bearing, not incidental: a plain session's tool
  // calls go through the CLI's ordinary permission gate like Bash or Edit
  // would (nothing auto-responds to it the way JobScheduler does for a job),
  // so without this the add_inbox_message call would sit as an unanswered
  // permission:request and the test would time out waiting for the entry.
  // It also matches the spec's own stated real-world case: a working session
  // "often runs with bypass" (issue-tracker-spec.md's injection-risk note).
  const res = await page.request.post(`${cockpitUrl}/api/sessions`, { data: { cwd, runtime: "pty", name, bypassPermissions: true } });
  expect(res.ok()).toBe(true);
  const { sessionId } = await res.json();
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

/** Navigates to the session and waits for the PTY to be ready to receive
 *  input. Load-bearing 5s wait — see hello.spec.ts — call once per session. */
async function openSession(page: import("@playwright/test").Page, cockpitUrl: string, sessionId: string, cwd: string) {
  await page.goto(`${cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(cwd)}`);
  const input = page.getByTestId("message-input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(5000);
}

async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

/** Polls GET /api/inbox until an entry with `title` shows up — the actual
 *  observable outcome phase 1 needs proven here (see the file banner for why
 *  this is used instead of waiting for UI text). */
async function waitForInboxEntry(
  page: import("@playwright/test").Page,
  cockpitUrl: string,
  title: string,
  timeoutMs = 30_000,
): Promise<InboxEntry> {
  const deadline = Date.now() + timeoutMs;
  let lastTitles: string[] = [];
  while (Date.now() < deadline) {
    const res = await page.request.get(`${cockpitUrl}/api/inbox`);
    if (res.ok()) {
      const { messages } = (await res.json()) as { messages: InboxEntry[] };
      lastTitles = messages.map((m) => m.title);
      const found = messages.find((m) => m.title === title);
      if (found) return found;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`inbox entry titled "${title}" did not appear within ${timeoutMs}ms; last seen titles: ${JSON.stringify(lastTitles)}`);
}

function requestBodies(harness: { mock: { getRequests(): { url: string; body: string }[] } }): string {
  return harness.mock
    .getRequests()
    .filter((r) => r.url.split("?")[0] === "/v1/messages")
    .map((r) => r.body)
    .join("\n");
}

test("a plain session's add_inbox_message is attributed to the session, not a job, with a live+disabled notifyProviders pair", async ({
  page,
  harness,
}) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-session-inbox-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const notifRes = await page.request.put(`${harness.cockpitUrl}/api/notifications`, {
      data: {
        providers: [
          { id: "live-1", type: "ntfy", name: "Live Ntfy", enabled: true, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } },
          { id: "dead-1", type: "ntfy", name: "Dead Ntfy", enabled: false, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } },
        ],
      },
    });
    expect(notifRes.ok()).toBe(true);

    harness.mock.setScript([
      {
        events: toolUseResponse(INBOX_TOOL, {
          title: "Live and dead report",
          body: "Naming a live provider and a disabled one together.",
          priority: "info",
          notifyProviders: ["live-1", "dead-1"],
        }),
      },
    ]);

    const sessionId = await createPlainSession(page, harness.cockpitUrl, workDir, "session-inbox-test");
    await openSession(page, harness.cockpitUrl, sessionId, workDir);
    await send(page, "Report it, please.");

    const live = await waitForInboxEntry(page, harness.cockpitUrl, "Live and dead report");
    expect(live.sessionId).toBe(sessionId);
    expect(live.sessionName).toBe("session-inbox-test");
    expect(live.jobId).toBeUndefined();

    // The tool had to be offered to the CLI (tools/list) for the model to
    // call it at all — proof that the scope map actually reaches a running
    // session, not just that the MCP server would answer if asked.
    expect(requestBodies(harness)).toContain(INBOX_TOOL);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a plain session's add_inbox_message with no notifyProviders still delivers, attributed to the session", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-session-inbox-quiet-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const notifRes = await page.request.put(`${harness.cockpitUrl}/api/notifications`, {
      data: {
        providers: [
          { id: "live-2", type: "ntfy", name: "Live Ntfy 2", enabled: true, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } },
        ],
      },
    });
    expect(notifRes.ok()).toBe(true);

    harness.mock.setScript([
      { events: toolUseResponse(INBOX_TOOL, { title: "Quiet report", body: "No notifyProviders at all.", priority: "info" }) },
    ]);

    const sessionId = await createPlainSession(page, harness.cockpitUrl, workDir, "session-quiet-test");
    await openSession(page, harness.cockpitUrl, sessionId, workDir);
    await send(page, "Report it, quietly.");

    const quiet = await waitForInboxEntry(page, harness.cockpitUrl, "Quiet report");
    expect(quiet.sessionId).toBe(sessionId);
    expect(quiet.jobId).toBeUndefined();
    expect(requestBodies(harness)).toContain(INBOX_TOOL);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("an interactive session can push through the tool ten separate times; the inbox write keeps landing on the eleventh", async ({
  page,
  harness,
}) => {
  test.setTimeout(150_000); // eleven separate user turns, each a real CLI round trip

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-session-inbox-rl-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const notifRes = await page.request.put(`${harness.cockpitUrl}/api/notifications`, {
      data: {
        providers: [{ id: "rl-1", type: "ntfy", name: "RL Ntfy", enabled: true, config: { serverUrl: "http://127.0.0.1:1", topic: "t" } }],
      },
    });
    expect(notifRes.ok()).toBe(true);

    const sessionId = await createPlainSession(page, harness.cockpitUrl, workDir, "session-rate-limit-test");
    await openSession(page, harness.cockpitUrl, sessionId, workDir);

    // The rate limiter is exercised for real across eleven live tool calls
    // dispatched by an actual running CLI (not just direct MCP-server calls,
    // which is how cockpit-config-server.test.ts's "session push rate
    // limit" block proves the cap and the exact refusal text). The inbox
    // write is what's independently checkable here: it must land every
    // time, including on the eleventh call whose push gets capped.
    const PUSH_COUNT = 11;
    for (let i = 0; i < PUSH_COUNT; i++) {
      harness.mock.setScript([
        { events: toolUseResponse(INBOX_TOOL, { title: `RL push ${i}`, body: "b", priority: "info", notifyProviders: ["rl-1"] }) },
      ]);
      await send(page, `Report push ${i}.`);
      const entry = await waitForInboxEntry(page, harness.cockpitUrl, `RL push ${i}`);
      expect(entry.sessionId).toBe(sessionId);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
