// Regression: a second AskUserQuestion asked after the first was answered must
// render. Reported as "ask me another question" getting stuck — the chat showed
// a blue sidebar (server holds the request) but no prompt; pressing stop
// surfaced it.
//
// Root cause was in chat-view's two render paths. After answering the first
// question, its assistant message keeps an AskUserQuestion tool_use block (now
// with output). For the follow-up question:
//   - Place1 (inline) used pendingQuestions.find(() => true), which returned the
//     stale answered entry instead of the new one.
//   - Place2 (standalone) was suppressed because hasInline matched the first
//     question's now-answered block, and it also mapped answered entries.
// Net: the follow-up question (only present in pendingQuestions, with no inline
// block of its own yet) rendered nowhere. Single-question tests never hit it.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { askUserQuestionResponse } from "../mock-api/builder";
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

test("a follow-up question renders after the first one is answered", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-seqq-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    harness.mock.setScript([
      {
        events: askUserQuestionResponse([
          {
            question: "What color?",
            header: "Color",
            multiSelect: false,
            options: [
              { label: "Red", description: "Like a rose" },
              { label: "Blue", description: "Like the sky" },
            ],
          },
        ]),
      },
      {
        events: askUserQuestionResponse([
          {
            question: "Which size?",
            header: "Size",
            multiSelect: false,
            options: [
              { label: "Small", description: "Compact" },
              { label: "Large", description: "Roomy" },
            ],
          },
        ]),
      },
    ]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    // First question.
    await page.getByTestId("message-input").fill("hi");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("What color?")).toBeVisible({ timeout: 30_000 });

    // Answer it (select an option, then Submit); the CLI then asks the second
    // question.
    await page.getByRole("button", { name: /Red/ }).first().click();
    await page.getByRole("button", { name: /^Submit$/ }).click();

    // The follow-up question must render (pre-fix it stayed hidden behind the
    // first question's answered block).
    await expect(page.getByText("Which size?")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Small/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Large/ })).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
