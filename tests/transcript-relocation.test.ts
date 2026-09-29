// Entering a worktree makes the CLI move a session's transcript from the
// original directory's project folder to the worktree's. Everything that reads
// the conversation goes through getTranscriptPath, so it has to follow the file.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTranscriptPath, loadTranscript, transcriptExists } from "@/server/transcript";

describe("a transcript the CLI moved", () => {
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeDir: string;
  const repo = "/work/repo";
  const worktree = "/work/.worktrees/repo-feature";

  beforeEach(() => {
    claudeDir = mkdtempSync(path.join(tmpdir(), "cockpit-relocate-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
  });

  afterEach(() => {
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
    rmSync(claudeDir, { recursive: true, force: true });
  });

  function folderFor(cwd: string): string {
    return path.join(claudeDir, "projects", cwd.replace(/[/.]/g, "-"));
  }

  function writeTranscript(cwd: string, sessionId: string): string {
    mkdirSync(folderFor(cwd), { recursive: true });
    const file = path.join(folderFor(cwd), `${sessionId}.jsonl`);
    const lines = [
      { type: "user", uuid: "u1", message: { role: "user", content: "go into the worktree" }, cwd, timestamp: "2026-09-29T10:00:00Z" },
      { type: "relocated", sessionId, relocatedCwd: worktree },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }

  function move(sessionId: string, from: string, to: string): string {
    mkdirSync(folderFor(to), { recursive: true });
    const dest = path.join(folderFor(to), `${sessionId}.jsonl`);
    renameSync(path.join(folderFor(from), `${sessionId}.jsonl`), dest);
    return dest;
  }

  it("is found by session id in the folder it moved to", () => {
    const sessionId = randomUUID();
    writeTranscript(repo, sessionId);
    const moved = move(sessionId, repo, worktree);

    expect(getTranscriptPath(sessionId, repo)).toBe(moved);
    expect(transcriptExists(sessionId, repo)).toBe(true);
  });

  it("is read from its new folder", async () => {
    const sessionId = randomUUID();
    writeTranscript(repo, sessionId);
    move(sessionId, repo, worktree);

    const { messages } = await loadTranscript(sessionId, repo);
    expect(messages.map((m) => m.content)).toEqual(["go into the worktree"]);
  });

  it("is followed back when it moves home again", () => {
    const sessionId = randomUUID();
    const home = writeTranscript(repo, sessionId);
    move(sessionId, repo, worktree);
    expect(getTranscriptPath(sessionId, repo)).not.toBe(home);

    move(sessionId, worktree, repo);
    expect(getTranscriptPath(sessionId, repo)).toBe(home);
  });

  it("stays at its folder's path while it exists nowhere yet", () => {
    const sessionId = randomUUID();
    mkdirSync(folderFor("/elsewhere"), { recursive: true });

    expect(getTranscriptPath(sessionId, repo)).toBe(path.join(folderFor(repo), `${sessionId}.jsonl`));
    expect(transcriptExists(sessionId, repo)).toBe(false);
  });
});
