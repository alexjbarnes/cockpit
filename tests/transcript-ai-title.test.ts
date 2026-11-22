import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAiTitleFromTail, scanSessionsByIds } from "@/server/transcript";

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

function user(cwd: string, content: string): Record<string, unknown> {
  return {
    type: "user",
    cwd,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

describe("Claude Code's stored session title", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cockpit-ai-title-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the newest title and ignores malformed or unrelated records", async () => {
    const file = path.join(dir, "session.jsonl");
    writeFileSync(
      file,
      `not json\n${jsonl(
        user("/tmp/project", "hello"),
        { type: "ai-title", aiTitle: "First title", sessionId: "s" },
        { type: "ai-title", aiTitle: 42 },
        { type: "other", aiTitle: "not a title record" },
        { type: "ai-title", aiTitle: "  Newest title  " },
      )}`,
    );

    expect(await readAiTitleFromTail(file)).toBe("Newest title");
  });

  it("returns null for a title older than the tail window", async () => {
    const file = path.join(dir, "long.jsonl");
    writeFileSync(file, `${jsonl({ type: "ai-title", aiTitle: "Old title" })}\n${"x".repeat(200 * 1024)}`);

    expect(await readAiTitleFromTail(file)).toBeNull();
  });

  it("names a scanned session after the stored title instead of its first prompt", async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const project = path.join(dir, "projects", "-tmp-project");
      mkdirSync(project, { recursive: true });
      const id = "11111111-1111-4111-8111-111111111111";
      writeFileSync(
        path.join(project, `${id}.jsonl`),
        jsonl(user("/tmp/project", "please review this pull request"), {
          type: "ai-title",
          aiTitle: "Review the pull request",
          sessionId: id,
        }),
      );

      const [session] = await scanSessionsByIds([id]);
      expect(session.name).toBe("Review the pull request");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("still names an untitled session after its first prompt", async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      const project = path.join(dir, "projects", "-tmp-project");
      mkdirSync(project, { recursive: true });
      const id = "22222222-2222-4222-8222-222222222222";
      writeFileSync(path.join(project, `${id}.jsonl`), jsonl(user("/tmp/project", "please review this pull request")));

      const [session] = await scanSessionsByIds([id]);
      expect(session.name).toBe("please review this pull request");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});
