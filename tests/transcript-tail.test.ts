// The CLI writes session records between conversation entries: each API request
// and the blobs it is stored in, the title, the mode. One request can write
// hundreds of them, so a tail counted in raw lines held no messages at all and
// a long session opened to an empty chat with nothing to page back from.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMoreMessages, loadTranscript, readMoreLines } from "@/server/transcript";

const cwd = "/work/padas";

describe("a transcript's tail past the CLI's session records", () => {
  const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeDir: string;
  let sessionId: string;
  let file: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(path.join(tmpdir(), "cockpit-tail-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    sessionId = randomUUID();
    const folder = path.join(claudeDir, "projects", cwd.replace(/[/.]/g, "-"));
    mkdirSync(folder, { recursive: true });
    file = path.join(folder, `${sessionId}.jsonl`);
  });

  afterEach(() => {
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
    rmSync(claudeDir, { recursive: true, force: true });
  });

  // Conversation entries open with parentUuid, as the CLI writes them.
  const user = (text: string) => ({
    parentUuid: randomUUID(),
    type: "user",
    message: { role: "user", content: text },
    uuid: randomUUID(),
    timestamp: "2026-10-23T18:00:00.000Z",
    sessionId,
    cwd,
  });
  const assistant = (text: string) => ({
    parentUuid: randomUUID(),
    type: "assistant",
    message: { id: `msg_${randomUUID()}`, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] },
    uuid: randomUUID(),
    timestamp: "2026-10-23T18:00:01.000Z",
    sessionId,
  });
  const reminder = () => ({
    parentUuid: randomUUID(),
    type: "attachment",
    attachment: { type: "total_tokens_reminder", totalTokens: 1000 },
    uuid: randomUUID(),
    timestamp: "2026-10-23T18:00:02.000Z",
  });
  // Session records open with their type.
  const blob = () => ({ type: "api-request-blob", sessionId, hash: randomUUID(), data: "x".repeat(300) });
  const request = (size: number) => ({ type: "api-request", sessionId, body: "x".repeat(size) });
  const turnRecords = () => ["last-prompt", "ai-title", "mode", "permission-mode", "atis-latch"].map((type) => ({ type, sessionId }));
  const blobs = (count: number) => Array.from({ length: count }, blob);

  const write = (entries: object[]) => writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const contents = (messages: { content: string }[]) => messages.map((m) => m.content);

  it("opens on the conversation when the records fill the tail", async () => {
    const entries: object[] = [];
    for (let i = 1; i <= 30; i++) entries.push(user(`question ${i}`), assistant(`answer ${i}`));
    entries.push(request(2000), ...blobs(400), ...turnRecords());
    write(entries);

    const result = await loadTranscript(sessionId, cwd, { tailLines: 150 });

    expect(result.messages).toHaveLength(60);
    expect(result.messages.at(-1)?.content).toBe("answer 30");
    expect(result.byteOffset).toBe(0);
  });

  it("pages back through every message exactly once", async () => {
    const entries: object[] = [];
    for (let i = 1; i <= 400; i++) {
      // A request record longer than the first chunk read, now and then.
      entries.push(user(`question ${i}: café ☕ 🪄`), request(i % 97 === 0 ? 140_000 : 2000), ...blobs(3));
      entries.push(assistant(`answer ${i}: naïve 漢字`), ...turnRecords());
    }
    entries.push(...blobs(500));
    write(entries);

    const full = await loadTranscript(sessionId, cwd);
    expect(full.messages).toHaveLength(800);

    const first = await loadTranscript(sessionId, cwd, { tailLines: 150 });
    expect(first.messages).toHaveLength(150);
    const pages = [first.messages];
    let offset = first.byteOffset;
    while (offset > 0) {
      const more = await loadMoreMessages(sessionId, cwd, offset, 150);
      pages.unshift(more.messages);
      offset = more.newByteOffset;
    }

    expect(pages).toHaveLength(6);
    expect(contents(pages.flat())).toEqual(contents(full.messages));
  });

  it("reads on past a tail that shows nothing to the last message", async () => {
    const entries: object[] = [];
    for (let i = 1; i <= 10; i++) entries.push(user(`question ${i}`), assistant(`answer ${i}`));
    for (let i = 0; i < 200; i++) entries.push(reminder());
    write(entries);

    const result = await loadTranscript(sessionId, cwd, { tailLines: 150 });

    expect(result.messages).toHaveLength(20);
    expect(result.messages.at(-1)?.content).toBe("answer 10");
  });

  it("gives the exact offset of the earliest line it read", async () => {
    const lines = [user("zéro"), blob(), user("one ☕"), blob(), assistant("two"), blob(), blob(), user("three")].map((e) =>
      JSON.stringify(e),
    );
    // A blank line is passed over like a record.
    lines.splice(6, 0, "");
    writeFileSync(file, `${lines.join("\n")}\n`);
    const offsets: number[] = [];
    let at = 0;
    for (const line of lines) {
      offsets.push(at);
      at += Buffer.byteLength(line) + 1;
    }

    const page = await readMoreLines(file, offsets[8], 2);
    expect(page.lines).toEqual([lines[2], lines[4]]);
    expect(page.newByteOffset).toBe(offsets[2]);

    const rest = await readMoreLines(file, page.newByteOffset, 2);
    expect(rest.lines).toEqual([lines[0]]);
    expect(rest.newByteOffset).toBe(0);
  });

  it("keeps a short transcript's earliest messages within reach", async () => {
    // Small enough to be read in one chunk, which used to report the start of
    // the file as reached and so left the first fifty out of every page.
    // Entries that open with their type still count when they are chat.
    const entries = Array.from({ length: 200 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `note ${i + 1}` },
      uuid: `u${i + 1}`,
    }));
    write(entries);

    const tail = await loadTranscript(sessionId, cwd, { tailLines: 150 });
    expect(tail.messages).toHaveLength(150);
    expect(tail.byteOffset).toBeGreaterThan(0);

    const more = await loadMoreMessages(sessionId, cwd, tail.byteOffset, 150);
    expect(contents(more.messages)).toEqual(Array.from({ length: 50 }, (_, i) => `note ${i + 1}`));
    expect(more.newByteOffset).toBe(0);
  });
});
