import { existsSync } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkNonAnthropicThinking,
  findSessionCwd,
  findTranscriptFile,
  globalSearch,
  listAllTranscriptFiles,
  loadLastUsage,
  loadMoreMessages,
  loadTranscript,
  readMoreLines,
  scanAllSessions,
  scanSessionsByIds,
  scanSessionsForCwd,
  stripNonAnthropicThinking,
  transcriptExists,
} from "@/server/transcript";

vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), createReadStream: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

function jsonl(...entries: Record<string, unknown>[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

describe("transcript module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("transcriptExists", () => {
    it("returns false when file does not exist", () => {
      (existsSync as any).mockReturnValue(false);

      const result = transcriptExists("session-123", "/tmp");

      expect(result).toBe(false);
      expect(existsSync).toHaveBeenCalledWith("/home/user/.claude/projects/-tmp/session-123.jsonl");
    });

    it("returns true when file exists", () => {
      (existsSync as any).mockReturnValue(true);

      const result = transcriptExists("session-123", "/tmp");

      expect(result).toBe(true);
      expect(existsSync).toHaveBeenCalled();
    });
  });

  describe("loadTranscript", () => {
    it("returns empty result when file does not exist", async () => {
      (existsSync as any).mockReturnValue(false);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result).toEqual({
        messages: [],
        byteOffset: 0,
        totalSize: 0,
        lastUsage: null,
      });
    });

    it("parses user text messages (string content)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "user", message: { id: "u1", content: "hello" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        id: "u1",
        role: "user",
        content: "hello",
        toolUses: [],
        blocks: [],
      });
    });

    it("parses assistant text messages (array content with text block)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a1", content: [{ type: "text", text: "world" }] },
        timestamp: "2024-01-01T00:00:01Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        id: "a1",
        role: "assistant",
        content: "world",
        toolUses: [],
        blocks: [{ type: "text", text: "world" }],
      });
    });

    it("parses assistant tool use and user tool result", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { id: "a2", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] } },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolUses).toHaveLength(1);
      expect(result.messages[0].toolUses[0]).toMatchObject({
        id: "t1",
        name: "Bash",
        input: JSON.stringify({ command: "ls" }),
        output: "file.txt",
        status: "done",
      });
    });

    it("skips malformed JSON lines", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = [
        '{"type":"user","message":{"id":"u1","content":"hello"},"timestamp":"2024-01-01T00:00:00Z","cwd":"/tmp"}',
        "invalid json {",
        '{"type":"user","message":{"id":"u2","content":"world"},"timestamp":"2024-01-01T00:00:01Z","cwd":"/tmp"}',
      ].join("\n");
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].id).toBe("u1");
      expect(result.messages[1].id).toBe("u2");
    });

    it("skips isMeta messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "user", message: { id: "u1", content: "hello" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp", isMeta: true },
        { type: "user", message: { id: "u2", content: "world" }, timestamp: "2024-01-01T00:00:01Z", cwd: "/tmp" },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe("u2");
    });

    it("handles compact_boundary system events", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "system", subtype: "compact_boundary", timestamp: "2024-01-01T00:00:00Z", uuid: "sys-1" });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        role: "system",
        content: "__compacted__",
        blocks: [],
      });
    });

    it("handles local_command system events", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "local_command",
        content: "<local-command-stdout>command output</local-command-stdout>",
        timestamp: "2024-01-01T00:00:00Z",
        uuid: "sys-2",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        role: "assistant",
        content: "command output",
        toolUses: [],
        blocks: [{ type: "text", text: "command output" }],
      });
    });

    it("strips ANSI escape codes from local_command output (e.g. forwarded /context)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "local_command",
        content:
          "<local-command-stdout>\x1b[1mContext Usage\x1b[22m\n\x1b[38;5;141m342.4k/200k tokens (171%)\x1b[39m</local-command-stdout>",
        timestamp: "2024-01-01T00:00:00Z",
        uuid: "sys-ansi",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Context Usage\n342.4k/200k tokens (171%)");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are gone
      expect(result.messages[0].content).not.toMatch(/\x1b/);
    });

    it("strips CLI XML tags from text", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: { id: "u1", content: "<task-notification>some notification</task-notification>" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("extracts usage from assistant messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3-5-sonnet": { contextWindow: 200000 } } },
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 50, output_tokens: 100 } },
          timestamp: "2024-01-01T00:00:00Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.lastUsage).toEqual({
        used: 50,
        total: 200000,
      });
    });

    it("skips 'No response requested.' messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a1", content: [{ type: "text", text: "No response requested." }] },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("skips 'API Error: 429 ...' messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a1", content: [{ type: "text", text: "API Error: 429 Rate limit exceeded" }] },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles thinking blocks", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a3", content: [{ type: "thinking", thinking: "let me think..." }] },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: "thinking",
        text: "let me think...",
        redacted: false,
      });
    });

    it("handles redacted thinking (signature but no thinking text)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a4", content: [{ type: "thinking", signature: "abc123" }] },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: "thinking",
        text: "",
        redacted: true,
      });
    });

    it("merges duplicate assistant message IDs", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "part 1" }] }, timestamp: "2024-01-01T00:00:00Z" },
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "part 2" }] }, timestamp: "2024-01-01T00:00:01Z" },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain("part 1");
      expect(result.messages[0].content).toContain("part 2");
    });

    it("extracts images from user content arrays", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [
            { type: "text", text: "check this image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KG..." } },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].images).toBeDefined();
      expect(result.messages[0].images).toHaveLength(1);
      expect(result.messages[0].images![0]).toMatchObject({
        mediaType: "image/png",
        data: "iVBORw0KG...",
      });
    });

    it("extracts text files from file XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: '<file path="test.txt">\nfile contents\n</file>',
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].textFiles).toBeDefined();
      expect(result.messages[0].textFiles).toHaveLength(1);
      expect(result.messages[0].textFiles![0]).toMatchObject({
        name: "test.txt",
        content: "file contents",
      });
    });

    it("handles cache token types in usage", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "result",
          modelUsage: { "claude-3-5-sonnet": { contextWindow: 200000 } },
        },
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "text", text: "response" }],
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 15,
              output_tokens: 5,
            },
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.lastUsage).toEqual({
        used: 45, // 10 + 20 + 15
        total: 200000,
      });
    });

    it("resets lastUsage at a compact_boundary (no post-compaction turn yet)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3-5-sonnet": { contextWindow: 200000 } } },
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "text", text: "pre-compaction" }], usage: { input_tokens: 150000 } },
          timestamp: "2024-01-01T00:00:00Z",
        },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1", timestamp: "2024-01-01T00:00:01Z" },
        {
          type: "user",
          message: { id: null, content: "This session is being continued from a previous conversation" },
          timestamp: "2024-01-01T00:00:02Z",
          cwd: "/tmp",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      // The large pre-compaction usage must not leak past the boundary, otherwise
      // the PTY transcript watcher re-emits it and clobbers the post-compact estimate.
      expect(result.lastUsage).toBeNull();
    });

    it("reports post-compaction usage from the first assistant turn after the boundary", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3-5-sonnet": { contextWindow: 200000 } } },
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "text", text: "pre-compaction" }], usage: { input_tokens: 150000 } },
          timestamp: "2024-01-01T00:00:00Z",
        },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1", timestamp: "2024-01-01T00:00:01Z" },
        {
          type: "assistant",
          message: { id: "a2", content: [{ type: "text", text: "post-compaction" }], usage: { input_tokens: 5000 } },
          timestamp: "2024-01-01T00:00:02Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.lastUsage).toEqual({ used: 5000, total: 200000 });
    });

    it("ignores all-zero usage from an interrupted turn (keeps the last real reading)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3-5-sonnet": { contextWindow: 200000 } } },
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "text", text: "real turn" }],
            usage: { input_tokens: 120000, cache_read_input_tokens: 5000 },
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "assistant",
          message: {
            id: "a2",
            content: [{ type: "text", text: "" }],
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      // The cancelled turn's zeroed usage must not replace the 125k real reading.
      expect(result.lastUsage).toEqual({ used: 125000, total: 200000 });
    });

    it("extracts documents (PDFs) from user content arrays", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [
            { type: "text", text: "see document" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x..." } },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].documents).toBeDefined();
      expect(result.messages[0].documents).toHaveLength(1);
      expect(result.messages[0].documents![0]).toMatchObject({
        mediaType: "application/pdf",
        data: "JVBERi0x...",
        name: "document.pdf",
      });
    });

    it("preserves model information in assistant messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a1", content: [{ type: "text", text: "hello" }], model: "claude-3-5-sonnet" },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].model).toBe("claude-3-5-sonnet");
    });

    it("generates UUIDs for messages without IDs", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "user", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBeDefined();
      expect(result.messages[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("sets timestamp from ISO string", async () => {
      (existsSync as any).mockReturnValue(true);
      const isoTime = "2024-01-15T14:30:00Z";
      const content = jsonl({ type: "user", message: { id: "u1", content: "hello" }, timestamp: isoTime, cwd: "/tmp" });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      const expectedTime = new Date(isoTime).getTime();
      expect(result.messages[0].timestamp).toBe(expectedTime);
    });

    it("handles user messages with only tool results (no text)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }] },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolUses[0].output).toBe("output");
    });

    it("extracts text content from tool results that are arrays", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Test", input: {} }] },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "result text" }, "fallback"],
              },
            ],
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0].output).toContain("result text");
    });
  });

  describe("loadMoreMessages", () => {
    it("returns empty when byteOffset is 0", async () => {
      const result = await loadMoreMessages("session-123", "/tmp", 0);

      expect(result).toEqual({
        messages: [],
        newByteOffset: 0,
      });
    });

    it("returns empty when byteOffset is negative", async () => {
      const result = await loadMoreMessages("session-123", "/tmp", -1);

      expect(result).toEqual({
        messages: [],
        newByteOffset: 0,
      });
    });

    it("loads and parses messages from earlier in transcript", async () => {
      (existsSync as any).mockReturnValue(true);

      const mockFileHandle = {
        read: vi.fn().mockResolvedValue({ bytesRead: 100 }),
        close: vi.fn(),
      };

      (open as any).mockResolvedValue(mockFileHandle);

      const content = jsonl({
        type: "user",
        message: { id: "u1", content: "earlier message" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });

      mockFileHandle.read.mockImplementation((_buf: Buffer, _offset: number, _len: number, _pos: number) => {
        const text = content;
        Buffer.from(text).copy(_buf);
        return { bytesRead: text.length };
      });

      const result = await loadMoreMessages("session-123", "/tmp", 1000, 10);

      expect(result.messages).toBeDefined();
      expect(mockFileHandle.close).toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles assistant messages with no content blocks", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "assistant", message: { id: "a1", content: [] }, timestamp: "2024-01-01T00:00:00Z" });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("");
      expect(result.messages[0].toolUses).toHaveLength(0);
    });

    it("handles empty transcript file", async () => {
      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("");

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles thinking-only messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          id: "a1",
          content: [{ type: "thinking", thinking: "internal reasoning" }],
          usage: { output_tokens: 500 },
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: "thinking",
        text: "internal reasoning",
      });
    });

    it("handles multiple images in one message", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "img1" } },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "img2" } },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].images).toHaveLength(2);
    });

    it("filters out images with incomplete source data", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }],
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles local-command-stdout extraction with XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "local_command",
        content: "<local-command-stdout>stdout content</local-command-stdout>",
        timestamp: "2024-01-01T00:00:00Z",
        uuid: "sys-1",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].content).toBe("stdout content");
    });

    it("handles local-command content without XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "local_command",
        content: "raw command output",
        timestamp: "2024-01-01T00:00:00Z",
        uuid: "sys-1",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].content).toBe("raw command output");
    });

    it("skips empty local-command content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "local_command",
        content: "",
        timestamp: "2024-01-01T00:00:00Z",
        uuid: "sys-1",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("skips user messages with only command XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: { id: "u1", content: "<local-command-caveat>some caveat</local-command-caveat>" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles CLI XML stripping in assistant text blocks", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          id: "a1",
          content: [
            {
              type: "text",
              text: "before<local-command-stdout>command</local-command-stdout>after",
            },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].content).not.toContain("<local-command-stdout>");
    });

    it("handles tool_use blocks without optional fields", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          id: "a1",
          content: [{ type: "tool_use", input: {} }],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0]).toMatchObject({
        name: "unknown",
        input: "{}",
      });
    });

    it("handles assistant messages without message ID", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "hello" }],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBeDefined();
    });

    it("handles progress entries with sub-agent tool calls", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "tool_use", id: "parent-tool", name: "Agent", input: {} }],
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "progress",
          parentToolUseID: "parent-tool",
          data: {
            message: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id: "child-tool", name: "Bash", input: { command: "ls" } }],
              },
            },
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0].children).toBeDefined();
      expect(result.messages[0].toolUses[0].children).toHaveLength(1);
      expect(result.messages[0].toolUses[0].children![0]).toMatchObject({
        name: "Bash",
        input: JSON.stringify({ command: "ls" }),
      });
    });

    it("handles progress entries with sub-agent tool results", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "tool_use", id: "parent-tool", name: "Agent", input: {} }],
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "progress",
          parentToolUseID: "parent-tool",
          data: {
            message: {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id: "child-tool", name: "Bash", input: {} }],
              },
            },
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
        {
          type: "progress",
          parentToolUseID: "parent-tool",
          data: {
            message: {
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "child-tool", content: "result output" }],
              },
            },
          },
          timestamp: "2024-01-01T00:00:02Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0].children![0].output).toBe("result output");
    });

    it("does not merge assistant messages without matching IDs", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "message 1" }],
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "message 2" }],
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(2);
    });

    it("extracts multiple text files from content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: '<file path="file1.txt">\ncontent1\n</file>\n<file path="file2.txt">\ncontent2\n</file>',
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].textFiles).toHaveLength(2);
      expect(result.messages[0].textFiles![0].name).toBe("file1.txt");
      expect(result.messages[0].textFiles![1].name).toBe("file2.txt");
    });

    it("handles result type entries with context window info", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "result",
          modelUsage: {
            "claude-3-5-sonnet": { contextWindow: 200000 },
            "claude-opus": { contextWindow: 200000 },
          },
        },
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "text", text: "hello" }],
            usage: { input_tokens: 10 },
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.lastUsage?.total).toBe(200000);
    });
  });

  describe("loadLastUsage", () => {
    it("returns null when file does not exist", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(false);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toBeNull();
    });

    it("extracts usage from assistant message", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "assistant", message: { usage: { input_tokens: 1000 } } });
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 1000, total: 200000 });
    });

    it("uses contextWindow from result entry", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3": { contextWindow: 100000 } } },
        { type: "assistant", message: { usage: { input_tokens: 500, cache_read_input_tokens: 200 } } },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 700, total: 100000 });
    });

    it("returns null when no assistant messages have usage", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "user", message: { content: "hello" } });
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toBeNull();
    });

    it("includes cache_creation_input_tokens in usage calculation", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { usage: { input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 200 } },
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 600, total: 200000 });
    });

    it("skips malformed JSON lines", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("not-json\n" + JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 50 } } }));

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 50, total: 200000 });
    });

    it("skips an all-zero usage block from an interrupted turn", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { usage: { input_tokens: 90000, cache_read_input_tokens: 10000 } } },
        {
          type: "assistant",
          message: { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 100000, total: 200000 });
    });

    it("returns null when the most recent turn precedes a compaction boundary", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { usage: { input_tokens: 150000 } } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1" },
        { type: "user", message: { content: "This session is being continued from a previous conversation" } },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toBeNull();
    });

    it("ignores pre-compaction usage and reports the post-boundary turn", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { usage: { input_tokens: 150000 } } },
        { type: "system", subtype: "compact_boundary", uuid: "cb-1" },
        { type: "assistant", message: { usage: { input_tokens: 5000 } } },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 5000, total: 200000 });
    });
  });

  describe("findSessionCwd", () => {
    it("returns null when projects dir does not exist", async () => {
      const { findSessionCwd } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(false);

      const result = await findSessionCwd("session-123");

      expect(result).toBeNull();
    });

    it("returns null when readdir fails", async () => {
      const { findSessionCwd } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValue(new Error("readdir failed"));

      const result = await findSessionCwd("session-123");

      expect(result).toBeNull();
    });

    it("finds session cwd by scanning project dirs", async () => {
      const { findSessionCwd } = await import("@/server/transcript");
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockImplementation((p: string) => {
        if (p.includes("session-123.jsonl")) return true;
        return true;
      });
      (readdir as any).mockResolvedValue(["project-a"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1000 });

      const lines = [
        JSON.stringify({ type: "user", cwd: "/home/user/my-project", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }),
      ];
      let lineIndex = 0;
      const mockRl = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (lineIndex < lines.length) {
              return Promise.resolve({ value: lines[lineIndex++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        }),
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);
      (createReadStream as any).mockReturnValue({ destroy: () => {} });

      const result = await findSessionCwd("session-123");
      expect(result).toBe("/home/user/my-project");
    });

    it("destroys the read stream after scanning a transcript (rl.close alone leaks the FD)", async () => {
      const { findSessionCwd } = await import("@/server/transcript");
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValue(["project-a"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1000 });

      const lines = [
        JSON.stringify({ type: "user", cwd: "/home/user/my-project", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }),
      ];
      let lineIndex = 0;
      const mockRl = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (lineIndex < lines.length) {
              return Promise.resolve({ value: lines[lineIndex++], done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        }),
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);
      const destroy = vi.fn();
      (createReadStream as any).mockReturnValue({ destroy });

      await findSessionCwd("session-123");

      // extractSessionMeta breaks out of the read loop early; rl.close() does not
      // release the underlying createReadStream FD, so it must destroy the stream.
      expect(destroy).toHaveBeenCalled();
    });

    it("returns null when session file not found in any project dir", async () => {
      const { findSessionCwd } = await import("@/server/transcript");
      (existsSync as any).mockImplementation((p: string) => {
        if (p.includes("session-123.jsonl")) return false;
        return true;
      });
      (readdir as any).mockResolvedValue(["project-a", "project-b"]);

      const result = await findSessionCwd("session-123");
      expect(result).toBeNull();
    });
  });

  describe("scanAllSessions", () => {
    it("returns empty array when projects dir does not exist", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(false);

      const result = await scanAllSessions();

      expect(result).toEqual([]);
    });

    it("returns empty array when readdir fails", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValue(new Error("readdir failed"));

      const result = await scanAllSessions();

      expect(result).toEqual([]);
    });

    it("scans project dirs and groups sessions by cwd", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["project-a"]).mockResolvedValueOnce(["sess1.jsonl", "sess2.jsonl", "other.txt"]);
      (stat as any).mockResolvedValue({ mtimeMs: 2000 });

      const makeRl = (cwd: string, title: string) => {
        const lines = [JSON.stringify({ type: "user", cwd, message: { content: title }, timestamp: "2024-01-01T00:00:00Z" })];
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (i < lines.length) return Promise.resolve({ value: lines[i++], done: false });
              return Promise.resolve({ value: undefined, done: true });
            },
          }),
          close: vi.fn(),
        };
      };

      (createReadStream as any).mockReturnValue({ destroy: () => {} });
      (createInterface as any)
        .mockReturnValueOnce(makeRl("/tmp/project", "First session"))
        .mockReturnValueOnce(makeRl("/tmp/project", "Second session"));

      const result = await scanAllSessions();
      expect(result).toHaveLength(1);
      expect(result[0].cwd).toBe("/tmp/project");
      expect(result[0].sessions).toHaveLength(2);
      expect(result[0].dirName).toBe("project");
    });

    it("handles readdir failure for individual project dirs", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["project-a"]).mockRejectedValueOnce(new Error("permission denied"));

      const result = await scanAllSessions();
      expect(result).toEqual([]);
    });

    it("sorts groups by most recent session activity", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["proj-a", "proj-b"]).mockResolvedValueOnce(["s1.jsonl"]).mockResolvedValueOnce(["s2.jsonl"]);

      const makeRl = (cwd: string) => {
        const lines = [JSON.stringify({ type: "user", cwd, message: { content: "hi" }, timestamp: "2024-01-01T00:00:00Z" })];
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (i < lines.length) return Promise.resolve({ value: lines[i++], done: false });
              return Promise.resolve({ value: undefined, done: true });
            },
          }),
          close: vi.fn(),
        };
      };

      (createReadStream as any).mockReturnValue({ destroy: () => {} });
      (stat as any).mockResolvedValueOnce({ mtimeMs: 1000 }).mockResolvedValueOnce({ mtimeMs: 3000 });
      (createInterface as any).mockReturnValueOnce(makeRl("/tmp/old-project")).mockReturnValueOnce(makeRl("/tmp/new-project"));

      const result = await scanAllSessions();
      expect(result).toHaveLength(2);
      expect(result[0].cwd).toBe("/tmp/new-project");
      expect(result[1].cwd).toBe("/tmp/old-project");
    });

    it("skips sessions where extractSessionMeta returns null", async () => {
      const { scanAllSessions } = await import("@/server/transcript");

      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["proj"]).mockResolvedValueOnce(["s1.jsonl"]);
      (stat as any).mockRejectedValue(new Error("stat failed"));

      const result = await scanAllSessions();
      expect(result).toEqual([]);
    });
  });

  describe("stripCommandXml edge cases", () => {
    it("extracts slash command from command-name tag (non-compact)", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: { id: "u1", content: "<command-name>/analyze</command-name>" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("/analyze");
    });

    it("suppresses /compact command from command-name tag", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: { id: "u1", content: "<command-name>/compact</command-name>" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("strips local-command-stdout content from user messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: { id: "u1", content: "<local-command-stdout>output here</local-command-stdout>" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });
  });

  describe("progress entries with missing parent", () => {
    it("skips progress entry when parent tool not found", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "progress",
        parentToolUseID: "nonexistent-tool",
        data: {
          message: {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "child-tool", name: "Bash", input: {} }],
            },
          },
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("skips progress entry with non-array content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "tool_use", id: "parent-tool", name: "Agent", input: {} }] },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "progress",
          parentToolUseID: "parent-tool",
          data: { message: { type: "assistant", message: { role: "assistant", content: "not-array" } } },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolUses[0].children).toBeUndefined();
    });
  });

  describe("user content array with text and tool results", () => {
    it("creates user message when text present without tool results", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [{ type: "text", text: "Hello with context" }],
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("Hello with context");
    });

    it("does not create user message for array with only tool results", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "output" }],
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("assistant");
    });
  });

  describe("thinking blocks edge cases", () => {
    it("skips thinking block with no thinking text and no signature", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          id: "a1",
          content: [{ type: "thinking" }, { type: "text", text: "actual response" }],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks).toHaveLength(1);
      expect(result.messages[0].blocks[0].type).toBe("text");
    });
  });

  describe("assistant message deduplication", () => {
    it("deduplicates tool_use blocks when merging", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
              { type: "text", text: "done" },
            ],
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].toolUses).toHaveLength(1);
      expect(result.messages[0].blocks.filter((b: { type: string }) => b.type === "tool_use")).toHaveLength(1);
    });
  });

  describe("loadTranscript with tailLines option", () => {
    it("reads tail lines from file using file handle", async () => {
      (existsSync as any).mockReturnValue(true);

      const entry = JSON.stringify({
        type: "user",
        message: { id: "u1", content: "hello" },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      const fileContent = entry + "\n";

      const mockFileHandle = {
        read: vi.fn().mockImplementation((_buf: Buffer) => {
          Buffer.from(fileContent).copy(_buf);
          return { bytesRead: fileContent.length };
        }),
        close: vi.fn(),
      };

      (open as any).mockResolvedValue(mockFileHandle);
      (stat as any).mockResolvedValue({ size: fileContent.length });

      const result = await loadTranscript("session-123", "/tmp", { tailLines: 10 });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe("u1");
      expect(mockFileHandle.close).toHaveBeenCalled();
    });
  });

  describe("extractOutput edge cases", () => {
    it("handles tool result with empty content array", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Test", input: {} }] },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: [] }],
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0].output).toBe("");
    });

    it("handles tool result with no content property", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "tool_use", id: "t1", name: "Test", input: {} }] },
          timestamp: "2024-01-01T00:00:00Z",
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1" }],
          },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0].output).toBe("");
    });
  });

  describe("assistant message with non-array content", () => {
    it("skips assistant message when content is string", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: { id: "a1", content: "string content" },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });
  });

  describe("text files extraction from array content", () => {
    it("extracts text files from array content user messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [{ type: "text", text: '<file path="data.json">\n{"key":"value"}\n</file>' }],
        },
        timestamp: "2024-01-01T00:00:00Z",
        cwd: "/tmp",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].textFiles).toHaveLength(1);
      expect(result.messages[0].textFiles![0].name).toBe("data.json");
    });
  });

  describe("local_command without content", () => {
    it("skips local_command system event without content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "local_command",
        timestamp: "2024-01-01T00:00:00Z",
        uuid: "sys-1",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });
  });

  describe("loadTranscript with tailLines", () => {
    function makeFileHandle(content: string) {
      const buf = Buffer.from(content);
      return {
        read: vi.fn(async (target: Buffer, tOffset: number, length: number, position: number) => {
          buf.copy(target, tOffset, position, Math.min(position + length, buf.length));
          return { bytesRead: Math.min(length, buf.length - position) };
        }),
        close: vi.fn(async () => {}),
      };
    }

    it("loads last N lines using readTailLines", async () => {
      (existsSync as any).mockReturnValue(true);
      const lines = [
        JSON.stringify({ type: "user", message: { id: "u1", content: "first" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }),
        JSON.stringify({ type: "user", message: { id: "u2", content: "second" }, timestamp: "2024-01-01T00:01:00Z", cwd: "/tmp" }),
        JSON.stringify({ type: "user", message: { id: "u3", content: "third" }, timestamp: "2024-01-01T00:02:00Z", cwd: "/tmp" }),
      ];
      const content = lines.join("\n") + "\n";
      const fh = makeFileHandle(content);
      (stat as any).mockResolvedValue({ size: Buffer.byteLength(content) });
      (open as any).mockResolvedValue(fh);

      const result = await loadTranscript("session-123", "/tmp", { tailLines: 2 });

      expect(result.messages.length).toBeLessThanOrEqual(2);
      expect(result.totalSize).toBe(Buffer.byteLength(content));
      expect(fh.close).toHaveBeenCalled();
    });

    it("handles empty file in readTailLines", async () => {
      (existsSync as any).mockReturnValue(true);
      (stat as any).mockResolvedValue({ size: 0 });
      (open as any).mockResolvedValue({
        read: vi.fn(),
        close: vi.fn(async () => {}),
      });

      const result = await loadTranscript("session-123", "/tmp", { tailLines: 10 });

      expect(result.messages).toHaveLength(0);
      expect(result.byteOffset).toBe(0);
    });
  });

  describe("readMoreLines", () => {
    it("returns empty when byteOffset is 0", async () => {
      const result = await readMoreLines("/tmp/test.jsonl", 0, 10);
      expect(result.lines).toHaveLength(0);
      expect(result.newByteOffset).toBe(0);
    });

    it("reads lines from file at given offset", async () => {
      const lines = [
        JSON.stringify({ type: "user", message: { id: "u1", content: "hello" } }),
        JSON.stringify({ type: "user", message: { id: "u2", content: "world" } }),
      ];
      const content = lines.join("\n") + "\n";
      const buf = Buffer.from(content);
      const fh = {
        read: vi.fn(async (target: Buffer, tOffset: number, length: number, position: number) => {
          buf.copy(target, tOffset, position, Math.min(position + length, buf.length));
          return { bytesRead: Math.min(length, buf.length - position) };
        }),
        close: vi.fn(async () => {}),
      };
      (open as any).mockResolvedValue(fh);

      const result = await readMoreLines("/tmp/test.jsonl", Buffer.byteLength(content), 10);

      expect(result.lines.length).toBeGreaterThan(0);
      expect(fh.close).toHaveBeenCalled();
    });
  });

  describe("loadMoreMessages", () => {
    it("returns empty when byteOffset is 0", async () => {
      const result = await loadMoreMessages("session-123", "/tmp", 0);
      expect(result.messages).toHaveLength(0);
      expect(result.newByteOffset).toBe(0);
    });

    it("loads messages from file at offset", async () => {
      const lines = [
        JSON.stringify({ type: "user", message: { id: "u1", content: "msg" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }),
      ];
      const content = lines.join("\n") + "\n";
      const buf = Buffer.from(content);
      const fh = {
        read: vi.fn(async (target: Buffer, tOffset: number, length: number, position: number) => {
          buf.copy(target, tOffset, position, Math.min(position + length, buf.length));
          return { bytesRead: Math.min(length, buf.length - position) };
        }),
        close: vi.fn(async () => {}),
      };
      (open as any).mockResolvedValue(fh);

      const result = await loadMoreMessages("session-123", "/tmp", Buffer.byteLength(content));
      expect(result.messages.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("loadLastUsage", () => {
    it("returns null when file does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toBeNull();
    });

    it("extracts usage from assistant message", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3": { contextWindow: 150000, inputTokens: 100 } } },
        { type: "assistant", message: { usage: { input_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 650, total: 150000 });
    });

    it("uses default context window when modelUsage has no contextWindow", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3": { inputTokens: 100 } } },
        { type: "assistant", message: { usage: { input_tokens: 200 } } },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 200, total: 200000 });
    });

    it("returns null when no assistant message with usage", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({ type: "user", message: { content: "hello" } });
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toBeNull();
    });
  });

  describe("scanAllSessions", () => {
    it("returns empty when projects dir does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await scanAllSessions();
      expect(result).toEqual([]);
    });

    it("returns empty when readdir fails", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValue(new Error("ENOENT"));
      const result = await scanAllSessions();
      expect(result).toEqual([]);
    });

    it("scans sessions from project directories", async () => {
      (existsSync as any).mockReturnValue(true);
      const { createInterface } = await import("node:readline");
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const lines = [JSON.stringify({ type: "user", cwd: "/home/test", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" })];

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          for (const line of lines) yield line;
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await scanAllSessions();
      expect(result).toHaveLength(1);
      expect(result[0].cwd).toBe("/home/test");
      expect(result[0].sessions).toHaveLength(1);
    });

    it("skips sessions without cwd", async () => {
      (existsSync as any).mockReturnValue(true);
      const { createInterface } = await import("node:readline");
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          yield JSON.stringify({ type: "assistant", message: { content: "no cwd here" } });
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await scanAllSessions();
      expect(result).toHaveLength(0);
    });
  });

  describe("findSessionCwd", () => {
    it("returns null when projects dir does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await findSessionCwd("session-123");
      expect(result).toBeNull();
    });

    it("returns null when readdir fails", async () => {
      (existsSync as any).mockReturnValueOnce(true).mockReturnValue(false);
      (readdir as any).mockRejectedValue(new Error("EACCES"));
      const result = await findSessionCwd("session-123");
      expect(result).toBeNull();
    });

    it("finds session cwd from project directory", async () => {
      const { createInterface } = await import("node:readline");
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValue(["project1"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          yield JSON.stringify({ type: "user", cwd: "/home/project", message: { content: "test" }, timestamp: "2024-01-01T00:00:00Z" });
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await findSessionCwd("session-123");
      expect(result).toBe("/home/project");
    });
  });

  describe("extractSessionMeta edge cases", () => {
    it("extracts title from array content in user message", async () => {
      (existsSync as any).mockReturnValue(true);
      const { createInterface } = await import("node:readline");
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          yield JSON.stringify({
            type: "user",
            cwd: "/home/test",
            message: { content: [{ type: "text", text: "array content title" }] },
            timestamp: "2024-01-01T00:00:00Z",
          });
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await scanAllSessions();
      expect(result).toHaveLength(1);
      expect(result[0].sessions[0].name).toBe("array content title");
    });

    it("skips system-generated messages starting with [", async () => {
      (existsSync as any).mockReturnValue(true);
      const { createInterface } = await import("node:readline");
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          yield JSON.stringify({
            type: "user",
            cwd: "/home/test",
            message: { content: "[Request interrupted by user]" },
            timestamp: "2024-01-01T00:00:00Z",
          });
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await scanAllSessions();
      expect(result).toHaveLength(1);
      expect(result[0].sessions[0].name).toBe("Untitled session");
    });

    it("uses Untitled session when no title found", async () => {
      (existsSync as any).mockReturnValue(true);
      const { createInterface } = await import("node:readline");
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          yield JSON.stringify({
            type: "user",
            cwd: "/home/test",
            timestamp: "2024-01-01T00:00:00Z",
          });
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await scanAllSessions();
      expect(result).toHaveLength(1);
      expect(result[0].sessions[0].name).toBe("Untitled session");
    });

    it("uses lastActiveAt when no createdAt timestamp", async () => {
      (existsSync as any).mockReturnValue(true);
      const { createInterface } = await import("node:readline");
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 1700000000000 });

      const mockRl = {
        [Symbol.asyncIterator]: async function* () {
          yield JSON.stringify({
            type: "user",
            cwd: "/home/test",
            message: { content: "hello" },
          });
        },
        close: vi.fn(),
      };
      (createInterface as any).mockReturnValue(mockRl);

      const result = await scanAllSessions();
      expect(result[0].sessions[0].createdAt).toBe(1700000000000);
    });

    it("handles stat errors gracefully", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["project1"]).mockResolvedValueOnce(["sess1.jsonl"]);
      (stat as any).mockRejectedValue(new Error("ENOENT"));

      const result = await scanAllSessions();
      expect(result).toHaveLength(0);
    });
  });

  describe("parseLines additional branches", () => {
    it("handles user message with images and documents in array content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [
            { type: "text", text: "check this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "pdf123" } },
          ],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].images).toHaveLength(1);
      expect(result.messages[0].documents).toHaveLength(1);
    });

    it("skips user array content with only tool results", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "user",
        message: {
          id: "u1",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.messages).toHaveLength(0);
    });

    it("handles assistant API error message", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          id: "a1",
          content: [{ type: "text", text: "API Error: 429 Rate limited" }],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.messages).toHaveLength(0);
    });

    it("handles assistant No response requested message", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "assistant",
        message: {
          id: "a1",
          content: [{ type: "text", text: "No response requested." }],
        },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.messages).toHaveLength(0);
    });

    it("handles compact_boundary system message", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        subtype: "compact_boundary",
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("__compacted__");
    });

    it("handles result entry with contextWindow in modelUsage", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "user", message: { id: "u1", content: "hello" }, timestamp: "2024-01-01T00:00:00Z" },
        { type: "result", modelUsage: { "claude-3": { contextWindow: 150000, inputTokens: 100 } } },
        {
          type: "assistant",
          message: { id: "a1", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 100 } },
          timestamp: "2024-01-01T00:00:01Z",
        },
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.lastUsage).toBeDefined();
      expect(result.lastUsage!.total).toBe(150000);
    });

    it("handles isMeta entries by skipping them", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl({
        type: "system",
        isMeta: true,
        message: { content: "meta info" },
        timestamp: "2024-01-01T00:00:00Z",
      });
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");
      expect(result.messages).toHaveLength(0);
    });
  });

  describe("scanSessionsForCwd", () => {
    it("returns empty when projects dir does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await scanSessionsForCwd("/tmp/project");
      expect(result).toEqual([]);
    });

    it("returns empty when readdir fails", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValueOnce(new Error("fail"));
      const result = await scanSessionsForCwd("/tmp/project");
      expect(result).toEqual([]);
    });

    it("returns sessions matching the target cwd", async () => {
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["proj-a"]).mockResolvedValueOnce(["s1.jsonl", "s2.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 5000 });

      const makeRl = (cwd: string) => {
        const lines = [JSON.stringify({ type: "user", cwd, message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" })];
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (i < lines.length) return Promise.resolve({ value: lines[i++], done: false });
              return Promise.resolve({ value: undefined, done: true });
            },
          }),
          close: vi.fn(),
        };
      };

      (createReadStream as any).mockReturnValue({ destroy: () => {} });
      (createInterface as any).mockReturnValueOnce(makeRl("/tmp/project")).mockReturnValueOnce(makeRl("/other/dir"));

      const result = await scanSessionsForCwd("/tmp/project");
      expect(result).toHaveLength(1);
      expect(result[0].cwd).toBe("/tmp/project");
      expect(result[0].id).toBe("s1");
    });

    it("skips dirs that fail readdir", async () => {
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any)
        .mockResolvedValueOnce(["proj-a", "proj-b"])
        .mockRejectedValueOnce(new Error("no access"))
        .mockResolvedValueOnce(["s1.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 3000 });

      const makeRl = (cwd: string) => {
        const lines = [JSON.stringify({ type: "user", cwd, message: { content: "hi" }, timestamp: "2024-01-01T00:00:00Z" })];
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (i < lines.length) return Promise.resolve({ value: lines[i++], done: false });
              return Promise.resolve({ value: undefined, done: true });
            },
          }),
          close: vi.fn(),
        };
      };

      (createReadStream as any).mockReturnValue({ destroy: () => {} });
      (createInterface as any).mockReturnValueOnce(makeRl("/tmp/project"));

      const result = await scanSessionsForCwd("/tmp/project");
      expect(result).toHaveLength(1);
    });
  });

  describe("scanSessionsByIds", () => {
    it("returns empty for empty ids array", async () => {
      const result = await scanSessionsByIds([]);
      expect(result).toEqual([]);
    });

    it("returns empty when projects dir does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await scanSessionsByIds(["sess-1"]);
      expect(result).toEqual([]);
    });

    it("returns empty when readdir fails", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValueOnce(new Error("fail"));
      const result = await scanSessionsByIds(["sess-1"]);
      expect(result).toEqual([]);
    });

    it("finds sessions by id across project dirs", async () => {
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["proj-a"]).mockResolvedValueOnce(["sess-1.jsonl", "sess-2.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 4000 });

      const makeRl = (cwd: string) => {
        const lines = [JSON.stringify({ type: "user", cwd, message: { content: "hi" }, timestamp: "2024-01-01T00:00:00Z" })];
        let i = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (i < lines.length) return Promise.resolve({ value: lines[i++], done: false });
              return Promise.resolve({ value: undefined, done: true });
            },
          }),
          close: vi.fn(),
        };
      };

      (createReadStream as any).mockReturnValue({ destroy: () => {} });
      (createInterface as any).mockReturnValueOnce(makeRl("/tmp/a")).mockReturnValueOnce(makeRl("/tmp/b"));

      const result = await scanSessionsByIds(["sess-1"]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("sess-1");
    });

    it("skips project dirs that fail readdir", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["proj-a", "proj-b"]).mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce([]);

      const result = await scanSessionsByIds(["sess-1"]);
      expect(result).toEqual([]);
    });
  });

  describe("listAllTranscriptFiles", () => {
    it("returns empty when projects dir does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await listAllTranscriptFiles();
      expect(result).toEqual([]);
    });

    it("returns empty when readdir fails", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValueOnce(new Error("fail"));
      const result = await listAllTranscriptFiles();
      expect(result).toEqual([]);
    });

    it("lists jsonl files sorted by mtime descending", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockResolvedValueOnce(["proj-a"]).mockResolvedValueOnce(["s1.jsonl", "s2.jsonl", "readme.txt"]);
      (stat as any).mockResolvedValueOnce({ mtimeMs: 1000 }).mockResolvedValueOnce({ mtimeMs: 5000 });

      const result = await listAllTranscriptFiles();
      expect(result).toHaveLength(2);
      expect(result[0].sessionId).toBe("s2");
      expect(result[0].mtimeMs).toBe(5000);
      expect(result[1].sessionId).toBe("s1");
      expect(result[1].mtimeMs).toBe(1000);
    });

    it("skips .cockpit directories", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any)
        .mockResolvedValueOnce(["proj-a", ".cockpit-jobs"])
        .mockResolvedValueOnce(["s1.jsonl"])
        .mockResolvedValueOnce(["s2.jsonl"]);
      (stat as any).mockResolvedValue({ mtimeMs: 2000 });

      const result = await listAllTranscriptFiles();
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe("s1");
    });

    it("skips files that fail stat", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockImplementation((p: string) => {
        if (p.endsWith("projects")) return Promise.resolve(["proj-a"]);
        return Promise.resolve(["s1.jsonl", "s2.jsonl"]);
      });
      (stat as any).mockRejectedValueOnce(new Error("no access")).mockResolvedValueOnce({ mtimeMs: 3000 });

      const result = await listAllTranscriptFiles();
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe("s2");
    });

    it("skips dirs that fail readdir", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockImplementation((p: string) => {
        if (p.endsWith("projects")) return Promise.resolve(["proj-a", "proj-b"]);
        if (p.includes("proj-a")) return Promise.reject(new Error("no"));
        return Promise.resolve(["s1.jsonl"]);
      });
      (stat as any).mockResolvedValue({ mtimeMs: 1000 });

      const result = await listAllTranscriptFiles();
      expect(result).toHaveLength(1);
    });
  });

  describe("globalSearch", () => {
    function setupListFiles(files: string[]) {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockImplementation((p: string) => {
        if (p.endsWith("projects")) return Promise.resolve(["proj-a"]);
        return Promise.resolve(files);
      });
      (stat as any).mockResolvedValue({ mtimeMs: 5000 });
    }

    it("returns empty when no transcript files exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await globalSearch("hello", 50);
      expect(result.results).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it("finds matching messages across files", async () => {
      setupListFiles(["sess1.jsonl"]);

      const transcript = [
        JSON.stringify({ type: "user", cwd: "/tmp/project", message: { content: "first message" }, timestamp: "2024-01-01T00:00:00Z" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello world response" }] },
          timestamp: "2024-01-01T00:01:00Z",
        }),
      ].join("\n");

      (readFile as any).mockResolvedValue(transcript);

      const result = await globalSearch("hello world", 50);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].role).toBe("assistant");
      expect(result.results[0].sessionId).toBe("sess1");
      expect(result.results[0].cwd).toBe("/tmp/project");
      expect(result.results[0].preview).toContain("hello world");
    });

    it("skips files that don't contain the query", async () => {
      setupListFiles(["s1.jsonl", "s2.jsonl"]);

      const matchFile = [
        JSON.stringify({
          type: "user",
          cwd: "/tmp/project",
          message: { content: "needle in haystack" },
          timestamp: "2024-01-01T00:00:00Z",
        }),
      ].join("\n");
      const noMatchFile = [
        JSON.stringify({ type: "user", cwd: "/tmp/project", message: { content: "nothing here" }, timestamp: "2024-01-01T00:00:00Z" }),
      ].join("\n");

      (readFile as any).mockImplementation((p: string) => {
        if (p.includes("s1")) return Promise.resolve(matchFile);
        return Promise.resolve(noMatchFile);
      });

      const result = await globalSearch("needle", 50);
      expect(result.results).toHaveLength(1);
    });

    it("skips sessions in cockpit internal dirs", async () => {
      setupListFiles(["s1.jsonl"]);

      const transcript = [
        JSON.stringify({
          type: "user",
          cwd: "/home/user/.cockpit/jobs",
          message: { content: "search term" },
          timestamp: "2024-01-01T00:00:00Z",
        }),
      ].join("\n");

      (readFile as any).mockResolvedValue(transcript);

      const result = await globalSearch("search term", 50);
      expect(result.results).toEqual([]);
    });

    it("respects limit", async () => {
      setupListFiles(["s1.jsonl"]);

      const lines = [];
      lines.push(JSON.stringify({ type: "user", cwd: "/tmp/project", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }));
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: `match hello ${i}` }] },
            timestamp: "2024-01-01T00:01:00Z",
          }),
        );
      }
      (readFile as any).mockResolvedValue(lines.join("\n"));

      const result = await globalSearch("hello", 2);
      expect(result.results).toHaveLength(2);
    });

    it("supports offset for pagination", async () => {
      setupListFiles(["s1.jsonl"]);

      const lines = [];
      lines.push(JSON.stringify({ type: "user", cwd: "/tmp/project", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }));
      for (let i = 0; i < 5; i++) {
        lines.push(
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: `match hello ${i}` }] },
            timestamp: `2024-01-01T00:0${i}:00Z`,
          }),
        );
      }
      (readFile as any).mockResolvedValue(lines.join("\n"));

      const result = await globalSearch("hello", 50, 2);
      expect(result.results.length).toBeLessThanOrEqual(4);
    });

    it("case-insensitive matching", async () => {
      setupListFiles(["s1.jsonl"]);

      const transcript = [
        JSON.stringify({ type: "user", cwd: "/tmp/project", message: { content: "Hello World" }, timestamp: "2024-01-01T00:00:00Z" }),
      ].join("\n");
      (readFile as any).mockResolvedValue(transcript);

      const result = await globalSearch("hello world", 50);
      expect(result.results).toHaveLength(1);
    });

    it("handles file read errors gracefully", async () => {
      setupListFiles(["s1.jsonl"]);
      (readFile as any).mockRejectedValue(new Error("read error"));

      const result = await globalSearch("hello", 50);
      expect(result.results).toEqual([]);
    });

    it("skips compaction summary messages", async () => {
      setupListFiles(["s1.jsonl"]);

      const transcript = [
        JSON.stringify({ type: "user", cwd: "/tmp/project", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z" }),
        JSON.stringify({ type: "user", message: { content: "__compacted__" }, timestamp: "2024-01-01T00:01:00Z" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "compacted summary with hello" }] },
          timestamp: "2024-01-01T00:01:01Z",
        }),
      ].join("\n");
      (readFile as any).mockResolvedValue(transcript);

      const result = await globalSearch("hello", 50);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].role).toBe("user");
    });
  });

  describe("findTranscriptFile", () => {
    it("returns null when projects dir does not exist", async () => {
      (existsSync as any).mockReturnValue(false);
      const result = await findTranscriptFile("session-123");
      expect(result).toBeNull();
    });

    it("returns null when readdir fails", async () => {
      (existsSync as any).mockReturnValue(true);
      (readdir as any).mockRejectedValue(new Error("EACCES"));
      const result = await findTranscriptFile("session-123");
      expect(result).toBeNull();
    });

    it("returns matching path when transcript exists in a project dir", async () => {
      (existsSync as any).mockImplementation((p: string) => {
        if (p === "/home/user/.claude/projects") return true;
        return p === "/home/user/.claude/projects/-tmp-foo/session-123.jsonl";
      });
      (readdir as any).mockResolvedValue(["-tmp-bar", "-tmp-foo"]);
      const result = await findTranscriptFile("session-123");
      expect(result).toBe("/home/user/.claude/projects/-tmp-foo/session-123.jsonl");
    });

    it("returns null when no project dir contains the file", async () => {
      (existsSync as any).mockImplementation((p: string) => p === "/home/user/.claude/projects");
      (readdir as any).mockResolvedValue(["-tmp-bar", "-tmp-foo"]);
      const result = await findTranscriptFile("session-missing");
      expect(result).toBeNull();
    });
  });

  describe("checkNonAnthropicThinking", () => {
    it("reports no thinking on an empty file", async () => {
      (readFile as any).mockResolvedValue("");
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result).toEqual({ hasNonAnthropicThinking: false, count: 0, models: [] });
    });

    it("ignores malformed JSON lines", async () => {
      (readFile as any).mockResolvedValue("not json\n{bad\n");
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result.hasNonAnthropicThinking).toBe(false);
    });

    it("skips claude-prefixed model entries", async () => {
      (readFile as any).mockResolvedValue(
        jsonl({
          type: "assistant",
          message: { model: "claude-opus-4-7", content: [{ type: "thinking", thinking: "x" }] },
        }),
      );
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result.hasNonAnthropicThinking).toBe(false);
    });

    it("skips entries without an assistant message", async () => {
      (readFile as any).mockResolvedValue(jsonl({ type: "user", message: { content: "hi" } }, { type: "assistant" }));
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result.hasNonAnthropicThinking).toBe(false);
    });

    it("skips entries whose content is not an array", async () => {
      (readFile as any).mockResolvedValue(jsonl({ type: "assistant", message: { model: "deepseek-v3", content: "plain text" } }));
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result.hasNonAnthropicThinking).toBe(false);
    });

    it("counts non-anthropic thinking blocks and collects model names", async () => {
      (readFile as any).mockResolvedValue(
        jsonl(
          {
            type: "assistant",
            message: { model: "deepseek-v3", content: [{ type: "thinking", thinking: "a" }] },
          },
          {
            type: "assistant",
            message: { model: "deepseek-v3", content: [{ type: "text", text: "no thinking here" }] },
          },
          {
            type: "assistant",
            message: {
              model: "qwen-max",
              content: [
                { type: "thinking", thinking: "b" },
                { type: "text", text: "x" },
              ],
            },
          },
        ),
      );
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result.hasNonAnthropicThinking).toBe(true);
      expect(result.count).toBe(2);
      expect(result.models.sort()).toEqual(["deepseek-v3", "qwen-max"]);
    });

    it("counts thinking blocks even when the model field is missing", async () => {
      (readFile as any).mockResolvedValue(jsonl({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }] } }));
      const result = await checkNonAnthropicThinking("/path/x.jsonl");
      expect(result.count).toBe(1);
      expect(result.models).toEqual([]);
    });
  });

  describe("stripNonAnthropicThinking", () => {
    it("preserves blank lines and malformed JSON untouched", async () => {
      const input = "\nnot json\n";
      (readFile as any).mockResolvedValue(input);
      const stripped = await stripNonAnthropicThinking("/path/x.jsonl");
      expect(stripped).toBe(0);
      expect(writeFile).toHaveBeenCalledWith("/path/x.jsonl", input);
    });

    it("leaves claude-prefixed assistant entries untouched", async () => {
      const input = jsonl({
        type: "assistant",
        message: { model: "claude-opus-4-7", content: [{ type: "thinking", thinking: "x" }] },
      });
      (readFile as any).mockResolvedValue(input);
      const stripped = await stripNonAnthropicThinking("/path/x.jsonl");
      expect(stripped).toBe(0);
      expect(writeFile).toHaveBeenCalledWith("/path/x.jsonl", input);
    });

    it("leaves non-assistant entries and entries without message untouched", async () => {
      const input = jsonl(
        { type: "user", message: { content: "hi" } },
        { type: "assistant" },
        { type: "assistant", message: { model: "deepseek-v3", content: "string content" } },
      );
      (readFile as any).mockResolvedValue(input);
      const stripped = await stripNonAnthropicThinking("/path/x.jsonl");
      expect(stripped).toBe(0);
    });

    it("strips thinking blocks from non-anthropic assistant entries", async () => {
      const input = jsonl({
        type: "assistant",
        message: {
          model: "deepseek-v3",
          content: [
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "kept" },
          ],
        },
      });
      (readFile as any).mockResolvedValue(input);
      const stripped = await stripNonAnthropicThinking("/path/x.jsonl");
      expect(stripped).toBe(1);
      const writtenArg = (writeFile as any).mock.calls[0][1] as string;
      expect(writtenArg).not.toContain('"thinking"');
      expect(writtenArg).toContain('"kept"');
    });

    it("does not rewrite the entry when no thinking blocks are present", async () => {
      const input = jsonl({
        type: "assistant",
        message: { model: "deepseek-v3", content: [{ type: "text", text: "kept" }] },
      });
      (readFile as any).mockResolvedValue(input);
      const stripped = await stripNonAnthropicThinking("/path/x.jsonl");
      expect(stripped).toBe(0);
      expect(writeFile).toHaveBeenCalledWith("/path/x.jsonl", input);
    });
  });
});
