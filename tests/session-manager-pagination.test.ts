import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const emitter = new EventEmitter();
    const stdin = new (require("node:stream").PassThrough)();
    return Object.assign(emitter, {
      pid: 99999,
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
  }),
}));

vi.mock("@/server/debug-logger", () => ({
  logRawLine: vi.fn(),
  logDiag: vi.fn(),
  logParsedEvent: vi.fn(),
  logStatus: vi.fn(),
  logServerMessage: vi.fn(),
  logClientMessage: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
}));

const mockLoadTranscript = vi.fn();
const mockLoadMoreMessages = vi.fn();
const mockTranscriptExists = vi.fn();

vi.mock("@/server/transcript", () => ({
  loadTranscript: (...args: unknown[]) => mockLoadTranscript(...args),
  loadMoreMessages: (...args: unknown[]) => mockLoadMoreMessages(...args),
  transcriptExists: (...args: unknown[]) => mockTranscriptExists(...args),
  findSessionCwd: () => Promise.resolve(null),
}));

vi.mock("@/server/session-prefs", () => ({
  getSessionPrefs: vi.fn(() => undefined),
  setSessionPrefs: vi.fn(),
  deleteSessionPrefs: vi.fn(),
  findChainForCliSession: vi.fn(() => null),
}));

const mockGetDefaults = vi.fn();

vi.mock("@/server/defaults", () => ({
  getDefaults: () => mockGetDefaults(),
}));

import { SessionManager } from "@/server/session-manager";
import type { ChatMessage } from "@/types";

function makeMsg(id: string, role: "user" | "assistant", content: string, ts?: number): ChatMessage {
  return {
    id,
    role,
    content,
    toolUses: [],
    blocks: [],
    timestamp: ts || Date.now(),
  };
}

describe("pagination with message stitching", () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    mockGetDefaults.mockReturnValue({
      thinkingLevel: "high",
      bypassAllPermissions: false,
      diffStyle: "split",
      dismissKeyboardOnSend: true,
      thinkingExpanded: false,
      model: "sonnet",
      messageStitching: true,
    });
    mockTranscriptExists.mockReturnValue(false);
    mockLoadTranscript.mockResolvedValue({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
    mockLoadMoreMessages.mockResolvedValue({ messages: [], newByteOffset: 0 });
  });

  describe("getSession with stitching", () => {
    it("includes ALL current session messages when stitching is active", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 80 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string, _cwd: string, options?: { tailLines?: number }) => {
        if (sessionId === s.cliSessionId) {
          if (options?.tailLines) {
            // Tail-limited: would only return last ~50 messages and have byteOffset > 0
            const tail = currentMessages.slice(-50);
            return Promise.resolve({ messages: tail, byteOffset: 500, totalSize: 2000, lastUsage: null });
          }
          // Full load: all messages, byteOffset = 0
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 2000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 800, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      const result = await manager.getSession(session.id);
      expect(result).not.toBeNull();

      // Buffer should have all current messages + prev messages + marker
      const buf = s.transcriptBuffer as ChatMessage[];
      const totalExpected = prevMessages.length + 1 + currentMessages.length; // prev + marker + current
      expect(buf.length).toBe(totalExpected);

      // Verify chronological order: prev messages first, then marker, then ALL current
      expect(buf[0].id).toBe("prev-0");
      expect(buf[prevMessages.length].content).toBe("__context_reset__");
      expect(buf[prevMessages.length + 1].id).toBe("curr-0");
      expect(buf[buf.length - 1].id).toBe("curr-79");
    });

    it("sends last 50 messages to client from the combined buffer", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 80 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 2000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 800, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      const result = await manager.getSession(session.id);
      // Client should get the most recent 50 from the combined 111 messages
      expect(result!.messages.length).toBe(50);
      expect(result!.hasMore).toBe(true);
      // Last message sent to client should be the last current message
      expect(result!.messages[49].id).toBe("curr-79");
    });

    it("loads current session WITHOUT tailLines when stitching applies", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      mockLoadTranscript.mockResolvedValue({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });

      await manager.getSession(session.id);

      // First call should be for the current session WITHOUT tailLines
      const firstCall = mockLoadTranscript.mock.calls[0];
      expect(firstCall[0]).toBe(s.cliSessionId);
      expect(firstCall[2]).toBeUndefined(); // no options = full load
    });

    it("loads current session WITH tailLines when no stitching needed", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = []; // no previous sessions

      mockLoadTranscript.mockResolvedValue({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });

      await manager.getSession(session.id);

      // Should use tailLines since no stitching
      const firstCall = mockLoadTranscript.mock.calls[0];
      expect(firstCall[2]).toEqual({ tailLines: 150 });
    });

    it("loads current session WITH tailLines when stitching disabled", async () => {
      mockGetDefaults.mockReturnValue({
        thinkingLevel: "high",
        bypassAllPermissions: false,
        diffStyle: "split",
        dismissKeyboardOnSend: true,
        thinkingExpanded: false,
        model: "sonnet",
        messageStitching: false,
      });

      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      mockLoadTranscript.mockResolvedValue({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });

      await manager.getSession(session.id);

      const firstCall = mockLoadTranscript.mock.calls[0];
      expect(firstCall[2]).toEqual({ tailLines: 150 });
    });
  });

  describe("getMoreHistory after stitching", () => {
    it("serves all current session messages on scroll-up without gaps", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 80 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 2000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 800, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      const result = await manager.getSession(session.id);
      // Client has last 50 messages (indices 61-110 of combined 111-msg buffer)
      const clientFirstMsg = result!.messages[0];

      // Scroll up: request messages before the first shown message
      const moreResult = await manager.getMoreHistory(session.id, clientFirstMsg.id);

      // Should get the preceding 50 messages from the buffer
      expect(moreResult.messages.length).toBe(50);
      expect(moreResult.hasMore).toBe(true);

      // Verify no gaps: the last message from getMoreHistory should be
      // immediately before the first client message chronologically
      const buf = s.transcriptBuffer as ChatMessage[];
      const clientFirstIdx = buf.findIndex((m: ChatMessage) => m.id === clientFirstMsg.id);
      const moreLastMsg = moreResult.messages[moreResult.messages.length - 1];
      expect(buf[clientFirstIdx - 1].id).toBe(moreLastMsg.id);
    });

    it("eventually reaches all prev session messages without skipping current ones", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 70 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 40 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 2000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 800, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      const result = await manager.getSession(session.id);

      // Collect ALL messages by paginating backwards
      const allMessages: ChatMessage[] = [...result!.messages];
      let beforeId = allMessages[0].id;
      let iterations = 0;

      while (iterations < 10) {
        const more = await manager.getMoreHistory(session.id, beforeId);
        if (more.messages.length === 0) break;
        allMessages.unshift(...more.messages);
        beforeId = allMessages[0].id;
        iterations++;
        if (!more.hasMore) break;
      }

      // Should have ALL messages: prev + marker + current
      const totalExpected = prevMessages.length + 1 + currentMessages.length;
      expect(allMessages.length).toBe(totalExpected);

      // Verify order: prev messages, marker, then all current messages
      const prevInAll = allMessages.filter((m) => m.id.startsWith("prev-"));
      const currInAll = allMessages.filter((m) => m.id.startsWith("curr-"));
      expect(prevInAll.length).toBe(prevMessages.length);
      expect(currInAll.length).toBe(currentMessages.length);

      // First prev message should come before first current message
      const firstPrevIdx = allMessages.findIndex((m) => m.id === "prev-0");
      const firstCurrIdx = allMessages.findIndex((m) => m.id === "curr-0");
      expect(firstPrevIdx).toBeLessThan(firstCurrIdx);

      // No current messages should appear before any prev messages
      const lastPrevIdx = allMessages.findIndex((m) => m.id === `prev-${prevMessages.length - 1}`);
      expect(lastPrevIdx).toBeLessThan(firstCurrIdx);
    });

    it("current messages are contiguous with no gaps", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 60 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 20 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 2000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 800, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      await manager.getSession(session.id);

      // Collect all messages via pagination
      const buf = s.transcriptBuffer as ChatMessage[];
      const currInBuf = buf.filter((m: ChatMessage) => m.id.startsWith("curr-"));

      // Every current message from 0 to 59 should be present
      for (let i = 0; i < 60; i++) {
        const found = currInBuf.find((m: ChatMessage) => m.id === `curr-${i}`);
        expect(found, `curr-${i} should be in buffer`).toBeDefined();
      }

      // They should be in sequential order
      for (let i = 0; i < currInBuf.length - 1; i++) {
        const thisIdx = parseInt(currInBuf[i].id.split("-")[1], 10);
        const nextIdx = parseInt(currInBuf[i + 1].id.split("-")[1], 10);
        expect(nextIdx).toBe(thisIdx + 1);
      }
    });
  });

  describe("getSessionByCwd with stitching", () => {
    it("loads full current session when stitching applies", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      mockLoadTranscript.mockResolvedValue({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });

      await manager.getSessionByCwd(session.id, "/tmp/project");

      const firstCall = mockLoadTranscript.mock.calls[0];
      expect(firstCall[0]).toBe(s.cliSessionId);
      expect(firstCall[2]).toBeUndefined(); // full load, no tailLines
    });

    it("preserves all current session messages in buffer", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 75 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 25 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 1500, lastUsage: null });
        }
        return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 500, lastUsage: null });
      });

      await manager.getSessionByCwd(session.id, "/tmp/project");

      const buf = s.transcriptBuffer as ChatMessage[];
      const currInBuf = buf.filter((m: ChatMessage) => m.id.startsWith("curr-"));
      expect(currInBuf.length).toBe(75);
    });
  });

  describe("regression: tail-limited load with stitching would lose messages", () => {
    it("would have lost middle messages if tail-limited (regression guard)", async () => {
      // This test verifies the specific scenario that was broken:
      // - Current session has many messages (only tail was loaded)
      // - After stitching, byteOffset pointed to prev session
      // - Pagination from buffer start would read prev session, skipping current's earlier msgs
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      // Simulate: current session has 80 messages total
      // If tail-limited to 50, messages curr-0 through curr-29 would be lost
      const currentMessages = Array.from({ length: 80 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 20 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          // Full load returns all 80 messages
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 2000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 400, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      const result = await manager.getSession(session.id);

      // Paginate to collect everything
      const allMessages: ChatMessage[] = [...result!.messages];
      let beforeId = allMessages[0].id;

      for (let i = 0; i < 10; i++) {
        const more = await manager.getMoreHistory(session.id, beforeId);
        if (more.messages.length === 0) break;
        allMessages.unshift(...more.messages);
        beforeId = allMessages[0].id;
        if (!more.hasMore) break;
      }

      // The regression: curr-0 through curr-29 would have been missing
      // Now verify they're ALL present
      for (let i = 0; i < 80; i++) {
        const found = allMessages.find((m) => m.id === `curr-${i}`);
        expect(found, `curr-${i} must be reachable via pagination`).toBeDefined();
      }

      // Also verify prev messages are all present
      for (let i = 0; i < 20; i++) {
        const found = allMessages.find((m) => m.id === `prev-${i}`);
        expect(found, `prev-${i} must be reachable via pagination`).toBeDefined();
      }
    });

    it("pagination with prev session having earlier data still works", async () => {
      // Prev session has unread earlier messages (byteOffset > 0)
      // Pagination should read them after buffer is exhausted
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 40 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevTailMessages = Array.from({ length: 20 }, (_, i) =>
        makeMsg(`prev-${i + 10}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i + 10}`, 1010 + i),
      );
      const prevEarlierMessages = Array.from({ length: 10 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 1000, lastUsage: null });
        }
        if (sessionId === "prev-session-1") {
          // Prev session has more data (byteOffset > 0)
          return Promise.resolve({ messages: [...prevTailMessages], byteOffset: 200, totalSize: 600, lastUsage: null });
        }
        return Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null });
      });

      mockLoadMoreMessages.mockImplementation((sessionId: string, _cwd: string, byteOffset: number) => {
        if (sessionId === "prev-session-1" && byteOffset === 200) {
          return Promise.resolve({ messages: [...prevEarlierMessages], newByteOffset: 0 });
        }
        return Promise.resolve({ messages: [], newByteOffset: 0 });
      });

      const result = await manager.getSession(session.id);

      // Paginate backwards through everything
      const allMessages: ChatMessage[] = [...result!.messages];
      let beforeId = allMessages[0].id;

      for (let i = 0; i < 10; i++) {
        const more = await manager.getMoreHistory(session.id, beforeId);
        if (more.messages.length === 0) break;
        allMessages.unshift(...more.messages);
        beforeId = allMessages[0].id;
        if (!more.hasMore) break;
      }

      // All current messages present
      for (let i = 0; i < 40; i++) {
        expect(
          allMessages.find((m) => m.id === `curr-${i}`),
          `curr-${i}`,
        ).toBeDefined();
      }

      // All prev tail messages present
      for (let i = 10; i < 30; i++) {
        expect(
          allMessages.find((m) => m.id === `prev-${i}`),
          `prev-${i}`,
        ).toBeDefined();
      }

      // Earlier prev messages loaded via loadMoreMessages
      for (let i = 0; i < 10; i++) {
        expect(
          allMessages.find((m) => m.id === `prev-${i}`),
          `prev-${i}`,
        ).toBeDefined();
      }
    });

    it("messages maintain chronological order across pagination boundaries", async () => {
      const session = manager.createSession("/tmp/project");
      const s = (manager as any).sessions.get(session.id)!;
      s.previousCliSessionIds = ["prev-session-1"];

      const currentMessages = Array.from({ length: 60 }, (_, i) =>
        makeMsg(`curr-${i}`, i % 2 === 0 ? "user" : "assistant", `current msg ${i}`, 2000 + i),
      );
      const prevMessages = Array.from({ length: 30 }, (_, i) =>
        makeMsg(`prev-${i}`, i % 2 === 0 ? "user" : "assistant", `prev msg ${i}`, 1000 + i),
      );

      mockLoadTranscript.mockImplementation((sessionId: string) => {
        if (sessionId === s.cliSessionId) {
          return Promise.resolve({ messages: [...currentMessages], byteOffset: 0, totalSize: 1500, lastUsage: null });
        }
        return Promise.resolve({ messages: [...prevMessages], byteOffset: 0, totalSize: 600, lastUsage: null });
      });

      const result = await manager.getSession(session.id);

      // Paginate to get everything
      const allMessages: ChatMessage[] = [...result!.messages];
      let beforeId = allMessages[0].id;

      for (let i = 0; i < 10; i++) {
        const more = await manager.getMoreHistory(session.id, beforeId);
        if (more.messages.length === 0) break;
        allMessages.unshift(...more.messages);
        beforeId = allMessages[0].id;
        if (!more.hasMore) break;
      }

      // Verify timestamps are monotonically non-decreasing
      // (marker has its own timestamp but that's fine)
      const nonMarker = allMessages.filter((m) => m.content !== "__context_reset__");
      for (let i = 0; i < nonMarker.length - 1; i++) {
        const curr = nonMarker[i];
        const next = nonMarker[i + 1];
        // Allow same-timestamp (marker boundary) but no going backwards
        if (curr.id.startsWith("prev-") && next.id.startsWith("curr-")) {
          // Cross-boundary: prev timestamps < current timestamps
          expect(curr.timestamp!).toBeLessThan(next.timestamp!);
        } else if (curr.id.startsWith("prev-") && next.id.startsWith("prev-")) {
          expect(curr.timestamp!).toBeLessThanOrEqual(next.timestamp!);
        } else if (curr.id.startsWith("curr-") && next.id.startsWith("curr-")) {
          expect(curr.timestamp!).toBeLessThanOrEqual(next.timestamp!);
        }
      }
    });
  });
});
