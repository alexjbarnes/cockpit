// Repro for the "@-mention message hangs / never submits" bug. In PTY mode a
// sent message is typed into the CLI REPL as raw keystrokes; the theory was that
// an "@" opens the REPL autocomplete and the trailing Enter is consumed by the
// popup, so no turn reaches the API. This drives the REAL CLI to prove or refute
// that. NOTE: cli-init-fetch sends "hi" to the API on PTY spawn, so we must assert
// the user's OWN text reached the API (via a unique marker), not just call count.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Send `message` (which must embed `marker`) and poll the mock for a /v1/messages
// request whose body contains the marker — i.e. the user's prompt actually
// submitted (distinct from the init-fetch "hi" call). Returns true if it landed.
async function userPromptReachedApi(
  page: import("@playwright/test").Page,
  harness: Harness,
  workDir: string,
  message: string,
  marker: string,
): Promise<boolean> {
  harness.mock.setScript([{ events: textResponse("ack from mock") }]);

  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(res.ok()).toBe(true);
  const { sessionId } = await res.json();

  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  const input = page.getByTestId("message-input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(5000); // let the eager PTY spawn settle before sending

  await input.fill(message);
  await page.getByTestId("btn-send").click();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const landed = harness.mock.getRequests().some((r) => r.url.split("?")[0] === "/v1/messages" && r.body.includes(marker));
    if (landed) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

test("control: a plain message submits to the CLI", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-at-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    const landed = await userPromptReachedApi(page, harness, workDir, "summarize the notes ZZMARKERA", "ZZMARKERA");
    expect(landed).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a message with an @ file mention submits (does not hang)", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-at-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  writeFileSync(path.join(workDir, "notes.md"), "# Notes\nsome content here\n");
  try {
    const landed = await userPromptReachedApi(page, harness, workDir, "@notes.md summarize ZZMARKERB", "ZZMARKERB");
    expect(landed).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a message with an @ agent-style mention submits (does not hang)", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-at-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    const landed = await userPromptReachedApi(page, harness, workDir, "@reviewer please review ZZMARKERC", "ZZMARKERC");
    expect(landed).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("the exact reported shape (plugin agent with colon + URL) submits", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-at-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    const msg = "@iph-ai-toolkit:adversarial-code-review https://github.com/IPH-ITIPS/AnalystPortal/pull/264 ZZMARKERD";
    const landed = await userPromptReachedApi(page, harness, workDir, msg, "ZZMARKERD");
    expect(landed).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// Regression for the confirmed hang: when the @-mention is the LAST token (no trailing
// space/text) AND it matches something so the CLI autocomplete menu opens, the submit
// Enter was swallowed selecting a completion and the turn never reached the API (session
// stuck "running", bubble gone on reload). The fix (input-area handleSend) re-adds the
// trailing space that trim() had stripped, so the menu closes and the literal text
// submits. Without the fix this fails (marker never lands); with it, it passes.
test("a message ENDING in a matching @ mention still submits (open-menu hang)", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-at-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  // A real file so the dangling "@notes" matches and the CLI opens its @ menu.
  writeFileSync(path.join(workDir, "notes.md"), "# Notes\nsome content here\n");
  try {
    // Mention is the final token; the marker precedes it so it travels with the prompt.
    const landed = await userPromptReachedApi(page, harness, workDir, "summarize ZZMARKERE @notes", "ZZMARKERE");
    expect(landed).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
