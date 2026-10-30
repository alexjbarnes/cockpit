// A session that enters a git worktree keeps working.
//
// EnterWorktree moves the session's working directory, and Claude Code moves
// the session's transcript with it, from the original directory's project
// folder to the worktree's. Cockpit reads the conversation from the
// transcript, so it has to follow the file there.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
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

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", ...args], { cwd, stdio: "ignore" });
}

/** Every project folder holding this session's transcript. */
function transcriptDirs(claudeDir: string, sessionId: string): string[] {
  const projects = path.join(claudeDir, "projects");
  return readdirSync(projects).filter((d) => existsSync(path.join(projects, d, `${sessionId}.jsonl`)));
}

test("a session that enters a worktree keeps its conversation and goes on replying", async ({ page, harness }) => {
  const root = mkdtempSync(path.join(tmpdir(), "cockpit-it-wt-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "repo-feature");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  harness.trustWorkDir(repo);
  harness.trustWorkDir(worktree);
  // Built up front: setScript restarts the mock's message ids.
  const enter = toolUseResponse("EnterWorktree", { path: worktree });
  const entered = textResponse("Now in the worktree.");
  const second = textResponse("Still here after the move.");
  const third = textResponse("Back after the restart.");

  try {
    harness.mock.setScript([{ events: enter }, { events: entered }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: repo, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repo)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The eager spawn from session:connect has to finish, or the send races a
    // second one.
    await page.waitForTimeout(5000);

    await send(page, "go into the worktree");
    await expect(page.getByText("Now in the worktree.")).toBeVisible({ timeout: 30_000 });
    // The CLI moved the transcript out of the original directory's folder.
    expect(transcriptDirs(harness.claudeDir, sessionId)).toEqual([worktree.replace(/[/.]/g, "-")]);
    await expect(page.locator("[data-message-id]").filter({ hasText: "go into the worktree" })).toBeVisible();

    // Its hook payloads carry the new working directory, so the session says
    // which worktree it is in and its files come from there. A file that only
    // exists in the worktree is the proof the tree followed.
    await expect(page.getByTestId("worktree-tag")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("worktree-tag")).toContainText("repo-feature");
    writeFileSync(path.join(worktree, "feature.txt"), "made in the worktree\n");
    await page.getByText("Session Files", { exact: true }).click();
    await expect(page.getByText("feature.txt", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // A reload keeps the view in the worktree. The last reported cwd is stored
    // with the session, so the tag and the file tree do not fall back to the
    // original checkout while no hook is arriving to say where the CLI is.
    await page.reload();
    await expect(page.getByTestId("worktree-tag")).toContainText("repo-feature", { timeout: 15_000 });
    await expect(page.getByText("feature.txt", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    harness.mock.setScript([{ events: second }]);
    await send(page, "still there?");
    await expect(page.getByText("Still here after the move.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/never reached Claude/)).not.toBeVisible();

    // A restarted CLI resumes the session from the worktree, where its
    // transcript now is.
    harness.mock.setScript([{ events: third }]);
    await page.getByTestId("btn-session-settings").click();
    await page.getByRole("button", { name: "Harness" }).click();
    await page.getByRole("button", { name: "Restart agent harness" }).click();
    await page.waitForTimeout(5000);
    await send(page, "and after a restart?");
    await expect(page.getByText("Back after the restart.")).toBeVisible({ timeout: 30_000 });

    // A fresh page finds the conversation at its new home, still in the
    // worktree the restarted CLI resumed into: its next hook reports that cwd.
    await page.reload();
    await expect(page.getByText("Back after the restart.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Still here after the move.")).toBeVisible();
    await expect(page.locator("[data-message-id]").filter({ hasText: "go into the worktree" })).toBeVisible();
    await expect(page.getByTestId("worktree-tag")).toContainText("repo-feature");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session from before the stored worktree recovers it from its transcript", async ({ page, harness }) => {
  const root = mkdtempSync(path.join(tmpdir(), "cockpit-it-wt-legacy-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "repo-feature");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  writeFileSync(path.join(worktree, "feature.txt"), "made in the worktree\n");
  harness.trustWorkDir(repo);
  harness.trustWorkDir(worktree);

  // A session that moved into the worktree before cockpit stored the value:
  // its transcript is in the worktree's project folder, its prefs carry no
  // worktreeCwd, and there is no live process to report one.
  const sessionId = "6f1c5a2e-0000-4000-8000-000000000001";
  const projectDir = path.join(harness.claudeDir, "projects", worktree.replace(/[/.]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const entries = [
    {
      parentUuid: null,
      type: "user",
      message: { role: "user", content: "started in the repo" },
      uuid: "u1",
      timestamp: "2026-10-29T10:00:00.000Z",
      sessionId,
      cwd: repo,
    },
    {
      parentUuid: "u1",
      type: "user",
      message: { role: "user", content: "then moved here" },
      uuid: "u2",
      timestamp: "2026-10-29T10:01:00.000Z",
      sessionId,
      cwd: worktree,
    },
  ];
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const prefsFile = path.join(harness.configDir, "session-prefs.json");
  writeFileSync(
    prefsFile,
    JSON.stringify({
      [sessionId]: {
        name: "Legacy worktree",
        cliSessionId: sessionId,
        runtime: "pty",
        model: "mock:claude-sonnet-4-6",
        modelSlots: { main: "mock:claude-sonnet-4-6", mainContext: "200k" },
        contextSize: "200k",
        thinkingLevel: "high",
        permissionMode: "bypass",
        sandbox: { enabled: false },
      },
    }),
  );

  try {
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repo)}`);

    await expect(page.getByTestId("worktree-tag")).toContainText("repo-feature", { timeout: 15_000 });
    // Reading it also stored it, so the next reload needs no transcript read.
    await expect
      .poll(() => {
        try {
          return (JSON.parse(readFileSync(prefsFile, "utf-8")) as Record<string, { worktreeCwd?: string }>)[sessionId]?.worktreeCwd;
        } catch {
          return null;
        }
      })
      .toBe(worktree);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
