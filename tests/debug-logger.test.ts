import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendFile, mkdir, stat, rename } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
  appendFile: vi.fn(() => Promise.resolve()),
  mkdir: vi.fn(() => Promise.resolve()),
  stat: vi.fn(() => Promise.resolve({ size: 100 })),
  rename: vi.fn(() => Promise.resolve()),
}));

const mockAppendFile = vi.mocked(appendFile);
const mockMkdir = vi.mocked(mkdir);
const mockStat = vi.mocked(stat);
const mockRename = vi.mocked(rename);

describe("debug-logger", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAppendFile.mockReset().mockResolvedValue(undefined);
    mockMkdir.mockReset().mockResolvedValue(undefined as never);
    mockStat.mockReset().mockResolvedValue({ size: 100 } as never);
    mockRename.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.COCKPIT_DEBUG;
  });

  describe("isDebugEnabled", () => {
    it("returns false when COCKPIT_DEBUG is not set", async () => {
      delete process.env.COCKPIT_DEBUG;
      const { isDebugEnabled } = await import("@/server/debug-logger");
      expect(isDebugEnabled()).toBe(false);
    });

    it("returns true when COCKPIT_DEBUG=1", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { isDebugEnabled } = await import("@/server/debug-logger");
      expect(isDebugEnabled()).toBe(true);
    });
  });

  describe("logRawLine", () => {
    it("is no-op when debug disabled", async () => {
      delete process.env.COCKPIT_DEBUG;
      const { logRawLine } = await import("@/server/debug-logger");
      logRawLine("s1", "line");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockAppendFile).not.toHaveBeenCalled();
    });

    it("writes to file when debug enabled", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logRawLine } = await import("@/server/debug-logger");
      logRawLine("s1", "some raw line");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockAppendFile).toHaveBeenCalled();
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.dir).toBe("raw");
      expect(parsed.sessionId).toBe("s1");
      expect(parsed.raw).toBe("some raw line");
      expect(parsed.ts).toBeDefined();
    });
  });

  describe("logParsedEvent", () => {
    it("writes to file when debug enabled", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logParsedEvent } = await import("@/server/debug-logger");
      logParsedEvent("s1", { type: "text_delta", text: "hello" } as never);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockAppendFile).toHaveBeenCalled();
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.dir).toBe("event");
      expect(parsed.sessionId).toBe("s1");
    });
  });

  describe("logServerMessage", () => {
    it("writes to file when debug enabled", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logServerMessage } = await import("@/server/debug-logger");
      logServerMessage({ type: "init" } as never);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockAppendFile).toHaveBeenCalled();
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.dir).toBe("out");
    });
  });

  describe("logClientMessage", () => {
    it("writes to file when debug enabled", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logClientMessage } = await import("@/server/debug-logger");
      logClientMessage({ type: "ping" } as never);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockAppendFile).toHaveBeenCalled();
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.dir).toBe("in");
    });
  });

  describe("logStatus", () => {
    it("writes to file when debug enabled", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logStatus } = await import("@/server/debug-logger");
      logStatus("s1", "running");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockAppendFile).toHaveBeenCalled();
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.dir).toBe("status");
      expect(parsed.status).toBe("running");
    });
  });

  describe("logDiag", () => {
    it("writes to file when debug enabled", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logDiag } = await import("@/server/debug-logger");
      logDiag("s1", "test-label");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockAppendFile).toHaveBeenCalled();
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.dir).toBe("diag");
      expect(parsed.label).toBe("test-label");
    });

    it("includes extra data in the written line", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logDiag } = await import("@/server/debug-logger");
      logDiag("s1", "lbl", { count: 42 });
      await new Promise((r) => setTimeout(r, 50));
      const parsed = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
      expect(parsed.count).toBe(42);
    });
  });

  describe("maybeRotate", () => {
    it("rotates log file when size exceeds threshold after CHECK_INTERVAL writes", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logRawLine } = await import("@/server/debug-logger");
      mockStat.mockResolvedValue({ size: 60 * 1024 * 1024 } as never);

      for (let i = 0; i < 500; i++) {
        logRawLine("s1", `line-${i}`);
      }
      await new Promise((r) => setTimeout(r, 100));

      expect(mockStat).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();
    });

    it("does not rotate when file is under size threshold", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logRawLine } = await import("@/server/debug-logger");
      mockStat.mockResolvedValue({ size: 100 } as never);

      for (let i = 0; i < 500; i++) {
        logRawLine("s1", `line-${i}`);
      }
      await new Promise((r) => setTimeout(r, 100));

      expect(mockStat).toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it("handles stat errors gracefully during rotation", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logRawLine } = await import("@/server/debug-logger");
      mockStat.mockRejectedValue(new Error("ENOENT"));

      for (let i = 0; i < 500; i++) {
        logRawLine("s1", `line-${i}`);
      }
      await new Promise((r) => setTimeout(r, 100));

      expect(mockStat).toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });
  });

  describe("initialization", () => {
    it("creates .cockpit directory on first write", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logRawLine } = await import("@/server/debug-logger");
      logRawLine("s1", "test");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockMkdir).toHaveBeenCalledTimes(1);
    });

    it("reuses init promise for subsequent calls", async () => {
      process.env.COCKPIT_DEBUG = "1";
      const { logRawLine, logStatus } = await import("@/server/debug-logger");
      logRawLine("s1", "test");
      logStatus("s1", "running");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockMkdir).toHaveBeenCalledTimes(1);
    });
  });
});
