// Verifies a multi-line message round-trips through the full stack (browser →
// WebSocket → session-manager → PTY keystroke injection → real claude CLI → mock
// API) as ONE intact user turn.
//
// Cockpit frames multi-line input as a bracketed paste (PtySession.sendText: the
// text is wrapped in \e[200~ … \e[201~) so the REPL keeps every newline literal
// instead of mis-parsing the burst as separate submits / a slash command — the
// failure that recorded a sent multi-line message as "/compact" and lost it. The
// claude 2.1.216 binary buffers everything between the markers into one literal
// pasted key, so slash/newline parsing never runs on it.
//
// SCOPE: this is a round-trip smoke test, not a reproduction of the corruption. The
// corruption is a timing race in claude's paste heuristic that only shows up in a
// busy, long-running REPL; a fresh unloaded harness session does not trigger it
// (and stacking many sessions in one server just starves later PTYs of readiness,
// which is a harness artifact, not the bug). The byte-level regression guard — that
// multi-line text is framed as a bracketed paste and single-line is not — lives in
// the deterministic unit test tests/pty-session-sendtext.test.ts. This test proves
// the framed path actually delivers an intact turn end to end against the real CLI.

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

interface WireMessage {
  role: string;
  content: unknown;
}

// True when a SINGLE user turn carries both markers — i.e. the whole prompt arrived
// as one intact message. False if it split across turns (each marker in a different
// user message) or never reached the API (corrupted to a local /compact).
function intactTurnPresent(harness: Harness, head: string, tail: string): boolean {
  for (const r of harness.mock.getRequests()) {
    if (r.url.split("?")[0] !== "/v1/messages") continue;
    let body: { messages?: WireMessage[] };
    try {
      body = JSON.parse(r.body);
    } catch {
      continue;
    }
    for (const m of body.messages ?? []) {
      if (m.role !== "user") continue;
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((b) =>
                  b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "",
                )
                .join("")
            : "";
      if (text.includes(head) && text.includes(tail)) return true;
    }
  }
  return false;
}

// Send one message into a fresh session and poll the mock for an intact turn.
async function sendAndCheckIntact(
  page: import("@playwright/test").Page,
  harness: Harness,
  message: string,
  head: string,
  tail: string,
): Promise<boolean> {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-ml-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  try {
    harness.mock.setScript([{ events: textResponse("ack from mock") }]);
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(res.ok()).toBe(true);
    const { sessionId } = await res.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // Let session:connect's eager ensureProcess finish spawning the PTY so the send
    // takes the live path, not the spawn-time initial-prompt path.
    await page.waitForTimeout(5000);

    await input.fill(message);
    await page.getByTestId("btn-send").click();

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (intactTurnPresent(harness, head, tail)) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("control: a single-line prompt lands as one intact turn", async ({ page, harness }) => {
  const head = "ZZCTLHEAD";
  const tail = "ZZCTLTAIL";
  const landed = await sendAndCheckIntact(page, harness, `summarize the notes ${head} and also ${tail} please`, head, tail);
  expect(landed).toBe(true);
});

test("a multi-line prompt round-trips as one intact turn (bracketed-paste path)", async ({ page, harness }) => {
  const head = "ZZMLHEAD";
  const tail = "ZZMLTAIL";
  // The incident shape: a blank line splitting two paragraphs.
  const message = `I had a scheduled job error out like this ${head}: Status failure\n\nJob went idle without producing any assistant message ${tail}, so the turn never completed`;
  const landed = await sendAndCheckIntact(page, harness, message, head, tail);
  expect(landed).toBe(true);
});
