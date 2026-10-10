// What the CLI writes for a message the user sent while Claude was working: a
// queued_command attachment where the model read it, or a user entry when it
// ran as a turn of its own. Real files under a throwaway CLAUDE_CONFIG_DIR.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPromptHistory, loadTranscript, promptMatchKey, TranscriptPromptFollower } from "@/server/transcript";

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CWD = "/work/repo";

describe("mid-turn messages in the transcript", () => {
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeDir: string;
  let file: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(path.join(tmpdir(), "cockpit-midturn-transcript-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const folder = path.join(claudeDir, "projects", CWD.replace(/[/.]/g, "-"));
    mkdirSync(folder, { recursive: true });
    file = path.join(folder, `${SESSION}.jsonl`);
  });

  afterEach(() => {
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
    rmSync(claudeDir, { recursive: true, force: true });
  });

  let seq = 0;
  function line(entry: Record<string, unknown>): string {
    seq++;
    return JSON.stringify({ uuid: `e${seq}`, timestamp: new Date(Date.UTC(2026, 9, 2, 12, 0, seq)).toISOString(), ...entry });
  }
  function append(...entries: Record<string, unknown>[]): void {
    appendFileSync(file, entries.map((e) => `${line(e)}\n`).join(""));
  }

  const queuedCommand = (prompt: string, extra: Record<string, unknown> = {}) => ({
    type: "attachment",
    attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" }, ...extra },
  });

  function aTurnWithAMessageReadMidTurn(prompt: string): void {
    append(
      { type: "user", message: { role: "user", content: "Run the slow command" } },
      {
        type: "assistant",
        message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 6" } }] },
      },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] } },
      queuedCommand(prompt),
      { type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Done, and saw your note." }] } },
    );
  }

  describe("loadTranscript", () => {
    it("shows a message read mid-turn as the user's, where Claude read it", async () => {
      aTurnWithAMessageReadMidTurn("Also check the README");

      const { messages } = await loadTranscript(SESSION, CWD);

      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "Run the slow command"],
        ["assistant", ""],
        ["user", "Also check the README"],
        ["assistant", "Done, and saw your note."],
      ]);
    });

    it("unwraps a pasted message, as for any other user message", async () => {
      aTurnWithAMessageReadMidTurn('<pasted_content id="0a1b">\nline one\nline two\n</pasted_content id="0a1b">');

      const { messages } = await loadTranscript(SESSION, CWD);

      expect(messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Run the slow command", "line one\nline two"]);
    });

    it("leaves out the CLI's own queued notices", async () => {
      append(
        { type: "user", message: { role: "user", content: "Start the build" } },
        queuedCommand("<task-notification>\n<status>completed</status>\n</task-notification>", { commandMode: "task-notification" }),
        queuedCommand("a scheduled nudge", { origin: { kind: "cron" } }),
        { type: "attachment", attachment: { type: "date", date: "2026-10-02" } },
      );

      const { messages } = await loadTranscript(SESSION, CWD);

      expect(messages.map((m) => m.content)).toEqual(["Start the build"]);
    });
  });

  it("puts a message read mid-turn in the prompt history", async () => {
    aTurnWithAMessageReadMidTurn("Also check the README");

    const history = await loadPromptHistory(SESSION, CWD);

    expect(history).toContain("Also check the README");
    expect(history).toContain("Run the slow command");
  });

  it("matches a message whatever the CLI did to its wrapping and spacing", () => {
    expect(promptMatchKey('<pasted_content id="0a1b">\nline one\n\nline two\n</pasted_content id="0a1b">')).toBe("line one line two");
    expect(promptMatchKey("\x15  spaced\tout ")).toBe("spaced out");
  });

  describe("TranscriptPromptFollower", () => {
    it("reads only what is added after it starts, sorted by what became of each message", () => {
      append({ type: "user", message: { role: "user", content: "older" } });
      const follower = new TranscriptPromptFollower(SESSION, CWD);
      expect(follower.readNew()).toEqual({ queued: [], absorbed: [], opened: [] });

      append(
        { type: "queue-operation", operation: "enqueue", content: "first note" },
        queuedCommand("first note"),
        { type: "queue-operation", operation: "enqueue", content: "second note" },
        { type: "queue-operation", operation: "dequeue" },
        { type: "user", message: { role: "user", content: "second note" } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
        { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>x</local-command-caveat>" } },
      );

      expect(follower.readNew()).toEqual({
        queued: ["first note", "second note"],
        absorbed: ["first note"],
        opened: ["second note"],
      });
      expect(follower.readNew()).toEqual({ queued: [], absorbed: [], opened: [] });
    });

    it("waits for a line the CLI is still writing", () => {
      writeFileSync(file, "");
      const follower = new TranscriptPromptFollower(SESSION, CWD);
      const whole = line({ type: "user", message: { role: "user", content: "café ☕ order" } });
      const bytes = Buffer.from(`${whole}\n`, "utf8");
      // Cut inside the multi-byte "☕".
      const cut = bytes.indexOf(Buffer.from("☕", "utf8")) + 1;
      appendFileSync(file, bytes.subarray(0, cut));
      expect(follower.readNew().opened).toEqual([]);

      appendFileSync(file, bytes.subarray(cut));
      expect(follower.readNew().opened).toEqual(["café ☕ order"]);
    });

    it("sees past the CLI's very long prompt snapshot lines", () => {
      writeFileSync(file, "");
      const follower = new TranscriptPromptFollower(SESSION, CWD);
      append(
        { type: "user", message: { role: "user", content: "taken up" } },
        { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["x".repeat(400 * 1024)] } },
      );

      expect(follower.readNew().opened).toEqual(["taken up"]);
    });

    it("follows a transcript that is not there yet, or that starts over", () => {
      const follower = new TranscriptPromptFollower(SESSION, CWD);
      expect(follower.readNew().opened).toEqual([]);

      append({ type: "user", message: { role: "user", content: "first file" } });
      expect(follower.readNew().opened).toEqual(["first file"]);

      unlinkSync(file);
      append({ type: "user", message: { role: "user", content: "new" } });
      expect(follower.readNew().opened).toEqual(["new"]);
    });
  });
});
