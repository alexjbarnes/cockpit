// A session is named after Claude Code's own title for the conversation, not
// the first prompt. A name the user set in Cockpit wins over it.
//
// The sidebar asks /api/sessions/by-ids, and that route used to overwrite the
// scanned title with the in-memory name, which for a live session was still
// the folder's basename.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

function writeTranscript(harness: Harness, sessionId: string, cwd: string, title: string): void {
  const project = path.join(harness.claudeDir, "projects", "-tmp-session-titles");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        cwd,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "please review this pull request" },
      }),
      JSON.stringify({ type: "ai-title", aiTitle: title, sessionId }),
    ].join("\n"),
  );
}

async function nameFor(page: import("@playwright/test").Page, harness: Harness, id: string): Promise<string | undefined> {
  const res = await page.request.get(`${harness.cockpitUrl}/api/sessions/by-ids?ids=${id}`);
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as { sessions: { id: string; name: string }[] };
  return data.sessions.find((session) => session.id === id)?.name;
}

test("a live session takes Claude Code's stored title, and a user's name wins over it", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-session-title-"));
  harness.trustWorkDir(workDir);
  try {
    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", name: path.basename(workDir) },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = (await created.json()) as { sessionId: string };

    writeTranscript(harness, sessionId, workDir, "Review the pull request");
    expect(await nameFor(page, harness, sessionId)).toBe("Review the pull request");

    // A name set with Cockpit's /rename is stored in session-prefs and always
    // takes precedence, even though the stored title is still there.
    const prefsFile = path.join(harness.configDir, "session-prefs.json");
    const prefs = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, "utf-8")) : {};
    prefs[sessionId] = { ...(prefs[sessionId] ?? {}), name: "Mine" };
    writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));

    await expect.poll(async () => nameFor(page, harness, sessionId), { timeout: 10_000 }).toBe("Mine");

    // The All sessions scan reads the same title.
    const groups = (await (await page.request.get(`${harness.cockpitUrl}/api/sessions`)).json()) as {
      groups: { cwd: string; sessions: { id: string; name: string }[] }[];
    };
    const row = groups.groups.flatMap((group) => group.sessions).find((session) => session.id === sessionId);
    expect(row?.name).toBe("Mine");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
