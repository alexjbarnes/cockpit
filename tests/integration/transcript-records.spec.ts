// A session whose transcript ends in the CLI's session records still opens on
// its conversation.
//
// The CLI records each API request in the transcript, as an api-request line
// and the blobs it is stored in, and the first request after a respawn writes
// hundreds of them. History came from the transcript's last 150 lines, so a
// session reopened after a restart or a model switch showed an empty chat.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse } from "../mock-api/builder";
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

async function send(page: Page, text: string) {
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId("btn-send").click();
}

function transcriptFile(claudeDir: string, sessionId: string): string {
  const projects = path.join(claudeDir, "projects");
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  throw new Error(`no transcript for ${sessionId}`);
}

test("a session reopens on its conversation when its transcript ends in request records", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-records-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("Reply one.") }, { events: textResponse("Reply two.") }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The eager spawn from session:connect has to finish, or the send races a
    // second one.
    await page.waitForTimeout(5000);

    await send(page, "hello");
    await expect(page.getByText("Reply one.")).toBeVisible({ timeout: 30_000 });
    await send(page, "and again");
    await expect(page.getByText("Reply two.")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    // What the CLI writes for the first request after a respawn.
    const file = transcriptFile(harness.claudeDir, sessionId);
    const records = [
      { type: "api-request", sessionId, body: "x".repeat(140_000) },
      ...Array.from({ length: 400 }, () => ({ type: "api-request-blob", sessionId, hash: randomUUID(), data: "x".repeat(300) })),
      ...["last-prompt", "ai-title", "mode", "permission-mode", "atis-latch"].map((type) => ({ type, sessionId })),
    ];
    appendFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const tail = readFileSync(file, "utf8").trim().split("\n").slice(-150);
    expect(tail.every((line) => line.startsWith('{"type":"'))).toBe(true);

    await page.reload();
    await expect(page.getByTestId("message-input")).toBeVisible();
    await expect(page.getByText("Reply one.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Reply two.")).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
