import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, open } from "node:fs/promises";
import { transcriptExists, loadTranscript, loadMoreMessages } from "@/server/transcript";

vi.mock("node:os", () => ({ homedir: () => "/home/user" }));
vi.mock("node:fs", () => ({ existsSync: vi.fn(), createReadStream: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
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
      const content = jsonl(
        { type: "user", message: { id: "u1", content: "hello" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }
      );
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
      const content = jsonl(
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "world" }] }, timestamp: "2024-01-01T00:00:01Z" }
      );
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
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] } }
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
        'invalid json {',
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
        { type: "user", message: { id: "u2", content: "world" }, timestamp: "2024-01-01T00:00:01Z", cwd: "/tmp" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe("u2");
    });

    it("handles compact_boundary system events", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "system", subtype: "compact_boundary", timestamp: "2024-01-01T00:00:00Z", uuid: "sys-1" }
      );
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
      const content = jsonl(
        { type: "system", subtype: "local_command", content: "<local-command-stdout>command output</local-command-stdout>", timestamp: "2024-01-01T00:00:00Z", uuid: "sys-2" }
      );
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

    it("strips CLI XML tags from text", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "user", message: { id: "u1", content: "<task-notification>some notification</task-notification>" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("extracts usage from assistant messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3-5-sonnet": { contextWindow: 200000 } } },
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 50, output_tokens: 100 } }, timestamp: "2024-01-01T00:00:00Z" }
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
      const content = jsonl(
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "No response requested." }] }, timestamp: "2024-01-01T00:00:00Z" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("skips 'API Error: 429 ...' messages", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "API Error: 429 Rate limit exceeded" }] }, timestamp: "2024-01-01T00:00:00Z" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles thinking blocks", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { id: "a3", content: [{ type: "thinking", thinking: "let me think..." }] }, timestamp: "2024-01-01T00:00:00Z" }
      );
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
      const content = jsonl(
        { type: "assistant", message: { id: "a4", content: [{ type: "thinking", signature: "abc123" }] }, timestamp: "2024-01-01T00:00:00Z" }
      );
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
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "part 2" }] }, timestamp: "2024-01-01T00:00:01Z" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toContain("part 1");
      expect(result.messages[0].content).toContain("part 2");
    });

    it("extracts images from user content arrays", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
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
        }
      );
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
      const content = jsonl(
        {
          type: "user",
          message: {
            id: "u1",
            content: '<file path="test.txt">\nfile contents\n</file>',
          },
          timestamp: "2024-01-01T00:00:00Z",
          cwd: "/tmp",
        }
      );
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
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.lastUsage).toEqual({
        used: 45, // 10 + 20 + 15
        total: 200000,
      });
    });

    it("extracts documents (PDFs) from user content arrays", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
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
        }
      );
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
      const content = jsonl(
        { type: "assistant", message: { id: "a1", content: [{ type: "text", text: "hello" }], model: "claude-3-5-sonnet" }, timestamp: "2024-01-01T00:00:00Z" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].model).toBe("claude-3-5-sonnet");
    });

    it("generates UUIDs for messages without IDs", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "user", message: { content: "hello" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBeDefined();
      expect(result.messages[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("sets timestamp from ISO string", async () => {
      (existsSync as any).mockReturnValue(true);
      const isoTime = "2024-01-15T14:30:00Z";
      const content = jsonl(
        { type: "user", message: { id: "u1", content: "hello" }, timestamp: isoTime, cwd: "/tmp" }
      );
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
        }
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
        }
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

      const content = jsonl(
        { type: "user", message: { id: "u1", content: "earlier message" }, timestamp: "2024-01-01T00:00:00Z", cwd: "/tmp" }
      );

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
      const content = jsonl(
        { type: "assistant", message: { id: "a1", content: [] }, timestamp: "2024-01-01T00:00:00Z" }
      );
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

    it("handles thinking-only messages with token count", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "thinking", thinking: "internal reasoning" }],
            usage: { output_tokens: 500 },
          },
          timestamp: "2024-01-01T00:00:00Z",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].blocks[0]).toMatchObject({
        type: "thinking",
        text: "internal reasoning",
        tokens: 500,
      });
    });

    it("handles multiple images in one message", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
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
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].images).toHaveLength(2);
    });

    it("filters out images with incomplete source data", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "user",
          message: {
            id: "u1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png" } },
            ],
          },
          timestamp: "2024-01-01T00:00:00Z",
          cwd: "/tmp",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles local-command-stdout extraction with XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "system",
          subtype: "local_command",
          content: "<local-command-stdout>stdout content</local-command-stdout>",
          timestamp: "2024-01-01T00:00:00Z",
          uuid: "sys-1",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].content).toBe("stdout content");
    });

    it("handles local-command content without XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "system",
          subtype: "local_command",
          content: "raw command output",
          timestamp: "2024-01-01T00:00:00Z",
          uuid: "sys-1",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].content).toBe("raw command output");
    });

    it("skips empty local-command content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "system",
          subtype: "local_command",
          content: "",
          timestamp: "2024-01-01T00:00:00Z",
          uuid: "sys-1",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("skips user messages with only command XML tags", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "user",
          message: { id: "u1", content: "<local-command-caveat>some caveat</local-command-caveat>" },
          timestamp: "2024-01-01T00:00:00Z",
          cwd: "/tmp",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(0);
    });

    it("handles CLI XML stripping in assistant text blocks", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
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
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].content).not.toContain("<local-command-stdout>");
    });

    it("handles tool_use blocks without optional fields", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            id: "a1",
            content: [{ type: "tool_use", input: {} }],
          },
          timestamp: "2024-01-01T00:00:00Z",
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages[0].toolUses[0]).toMatchObject({
        name: "unknown",
        input: "{}",
      });
    });

    it("handles assistant messages without message ID", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "hello" }],
          },
          timestamp: "2024-01-01T00:00:00Z",
        }
      );
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
        }
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
        }
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
        }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadTranscript("session-123", "/tmp");

      expect(result.messages).toHaveLength(2);
    });

    it("extracts multiple text files from content", async () => {
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        {
          type: "user",
          message: {
            id: "u1",
            content: '<file path="file1.txt">\ncontent1\n</file>\n<file path="file2.txt">\ncontent2\n</file>',
          },
          timestamp: "2024-01-01T00:00:00Z",
          cwd: "/tmp",
        }
      );
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
        }
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
      const content = jsonl(
        { type: "assistant", message: { usage: { input_tokens: 1000 } } }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 1000, total: 200000 });
    });

    it("uses contextWindow from result entry", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "result", modelUsage: { "claude-3": { contextWindow: 100000 } } },
        { type: "assistant", message: { usage: { input_tokens: 500, cache_read_input_tokens: 200 } } }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toEqual({ used: 700, total: 100000 });
    });

    it("returns null when no assistant messages have usage", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "user", message: { content: "hello" } }
      );
      (readFile as any).mockResolvedValue(content);

      const result = await loadLastUsage("session-123", "/tmp");
      expect(result).toBeNull();
    });

    it("includes cache_creation_input_tokens in usage calculation", async () => {
      const { loadLastUsage } = await import("@/server/transcript");
      (existsSync as any).mockReturnValue(true);
      const content = jsonl(
        { type: "assistant", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 200 } } }
      );
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
      (createReadStream as any).mockReturnValue({});

      const result = await findSessionCwd("session-123");
      expect(result).toBe("/home/user/my-project");
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
      (readdir as any)
        .mockResolvedValueOnce(["project-a"])
        .mockResolvedValueOnce(["sess1.jsonl", "sess2.jsonl", "other.txt"]);
      (stat as any).mockResolvedValue({ mtimeMs: 2000 });

      const makeRl = (cwd: string, title: string) => {
        const lines = [
          JSON.stringify({ type: "user", cwd, message: { content: title }, timestamp: "2024-01-01T00:00:00Z" }),
        ];
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

      (createReadStream as any).mockReturnValue({});
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
      (readdir as any)
        .mockResolvedValueOnce(["project-a"])
        .mockRejectedValueOnce(new Error("permission denied"));

      const result = await scanAllSessions();
      expect(result).toEqual([]);
    });

    it("sorts groups by most recent session activity", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any)
        .mockResolvedValueOnce(["proj-a", "proj-b"])
        .mockResolvedValueOnce(["s1.jsonl"])
        .mockResolvedValueOnce(["s2.jsonl"]);

      const makeRl = (cwd: string) => {
        const lines = [
          JSON.stringify({ type: "user", cwd, message: { content: "hi" }, timestamp: "2024-01-01T00:00:00Z" }),
        ];
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

      (createReadStream as any).mockReturnValue({});
      (stat as any)
        .mockResolvedValueOnce({ mtimeMs: 1000 })
        .mockResolvedValueOnce({ mtimeMs: 3000 });
      (createInterface as any)
        .mockReturnValueOnce(makeRl("/tmp/old-project"))
        .mockReturnValueOnce(makeRl("/tmp/new-project"));

      const result = await scanAllSessions();
      expect(result).toHaveLength(2);
      expect(result[0].cwd).toBe("/tmp/new-project");
      expect(result[1].cwd).toBe("/tmp/old-project");
    });

    it("skips sessions where extractSessionMeta returns null", async () => {
      const { scanAllSessions } = await import("@/server/transcript");
      const { createReadStream } = await import("node:fs");
      const { createInterface } = await import("node:readline");

      (existsSync as any).mockReturnValue(true);
      (readdir as any)
        .mockResolvedValueOnce(["proj"])
        .mockResolvedValueOnce(["s1.jsonl"]);
      (stat as any).mockRejectedValue(new Error("stat failed"));

      const result = await scanAllSessions();
      expect(result).toEqual([]);
    });
  });
});
