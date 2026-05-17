import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedEvent } from "@/server/event-parser";

const ptyMocks = vi.hoisted(() => ({
  isAlive: false,
  start: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn().mockResolvedValue(undefined),
  interrupt: vi.fn(),
  notifyPermissionDecision: vi.fn().mockReturnValue(true),
  capturedOpts: null as null | {
    sessionId: string;
    cliSessionId: string;
    cwd: string;
    extraArgs: string[];
    onEvents: (events: ParsedEvent[]) => void;
    onError: (err: string) => void;
    onExit: (info: { exitCode: number; signal?: number }) => void;
  },
}));

const mockHookRouter = vi.hoisted(() => ({
  register: vi.fn().mockReturnValue("mock-token"),
  unregister: vi.fn(),
  getUrl: vi.fn().mockReturnValue("http://localhost:9999/hooks"),
}));

vi.mock("@/server/pty-runtime", () => ({
  PtyRuntime: class {
    constructor(opts: Record<string, unknown>) {
      ptyMocks.capturedOpts = opts as typeof ptyMocks.capturedOpts;
    }
    get pid() {
      return 12345;
    }
    get isAlive() {
      return ptyMocks.isAlive;
    }
    start(text?: string) {
      ptyMocks.isAlive = true;
      return ptyMocks.start(text);
    }
    sendText(text: string) {
      return ptyMocks.sendText(text);
    }
    sendSlash() {}
    sendKey() {}
    interrupt() {
      ptyMocks.interrupt();
    }
    resize() {}
    kill() {
      ptyMocks.isAlive = false;
      return ptyMocks.kill();
    }
    notifyPermissionDecision(id: string, decision: unknown) {
      return ptyMocks.notifyPermissionDecision(id, decision);
    }
  },
}));

vi.mock("@/server/singleton", () => ({
  getHookRouter: vi.fn(() => mockHookRouter),
  setHookRouter: vi.fn(),
  getTerminalManager: vi.fn(() => null),
  setTerminalManager: vi.fn(),
}));

vi.mock("@/server/debug-logger", () => ({
  debugLog: vi.fn(),
  logRawLine: vi.fn(),
  logDiag: vi.fn(),
  logParsedEvent: vi.fn(),
  logStatus: vi.fn(),
  logServerMessage: vi.fn(),
  logClientMessage: vi.fn(),
  isDebugEnabled: vi.fn(() => false),
}));

vi.mock("@/server/transcript", () => ({
  loadTranscript: vi.fn().mockResolvedValue({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null }),
  loadMoreMessages: vi.fn().mockResolvedValue({ messages: [], newByteOffset: 0 }),
  transcriptExists: vi.fn().mockReturnValue(false),
  findSessionCwd: vi.fn().mockResolvedValue(null),
  loadLastAssistantMessage: vi.fn().mockResolvedValue(null),
  getTranscriptPath: vi.fn().mockReturnValue("/tmp/fake-transcript.jsonl"),
}));

vi.mock("@/server/session-prefs", () => ({
  getSessionPrefs: vi.fn(() => undefined),
  setSessionPrefs: vi.fn(),
  deleteSessionPrefs: vi.fn(),
  findChainForCliSession: vi.fn(() => null),
}));

vi.mock("@/server/defaults", () => ({
  getDefaults: () => ({
    thinkingLevel: "high",
    bypassAllPermissions: false,
    diffStyle: "split",
    dismissKeyboardOnSend: true,
    thinkingExpanded: false,
    modelSlots: { main: "sonnet" },
  }),
}));

import { SessionManager } from "@/server/session-manager";

// Drives processEvents to set status=idle without clearing ptyRuntime (unlike onExit).
// Keeps session.ptyRuntime alive so tests can call methods on it after a "turn".
function emitMessageDone(): void {
  ptyMocks.capturedOpts!.onEvents([
    {
      type: "message_done",
      clearPending: true,
      message: {
        id: "test-msg",
        role: "assistant",
        content: "done",
        toolUses: [],
        blocks: [],
        timestamp: Date.now(),
      },
    } as ParsedEvent,
  ]);
}

describe("SessionManager PTY runtime (unit)", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    ptyMocks.isAlive = false;
    ptyMocks.capturedOpts = null;
    ptyMocks.start.mockClear().mockResolvedValue(undefined);
    ptyMocks.sendText.mockClear().mockResolvedValue(undefined);
    ptyMocks.kill.mockClear().mockResolvedValue(undefined);
    ptyMocks.interrupt.mockClear();
    ptyMocks.notifyPermissionDecision.mockClear().mockReturnValue(true);
  });

  describe("createSession", () => {
    it("accepts explicit pty runtime", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      expect(session.runtime).toBe("pty");
    });

    it("defaults to stream runtime", () => {
      const session = manager.createSession("/tmp");
      expect(session.runtime).toBe("stream");
    });
  });

  describe("sendMessage", () => {
    it("constructs PtyRuntime with correct identifiers on first send", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      expect(ptyMocks.capturedOpts).not.toBeNull();
      expect(ptyMocks.capturedOpts?.sessionId).toBe(session.id);
      expect(ptyMocks.capturedOpts?.cliSessionId).toBe(session.id);
      expect(ptyMocks.capturedOpts?.cwd).toBe("/tmp");
    });

    it("calls start() with the initial text", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");
      expect(ptyMocks.start).toHaveBeenCalledWith("hello");
    });

    it("sets session status to running", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const statuses: string[] = [];
      manager.onStatus(session.id, (s) => statuses.push(s));

      manager.sendMessage(session.id, "hello");
      expect(statuses).toContain("running");
    });

    it("sends text via ptyRuntime.sendText when alive and session is idle", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "first");
      // Simulate the PTY turn completing: status → idle, ptyRuntime stays alive
      emitMessageDone();

      manager.sendMessage(session.id, "second");
      expect(ptyMocks.sendText).toHaveBeenCalledWith("second");
    });

    it("includes --permission-mode plan when plan mode active", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.setPlanMode(session.id);
      manager.sendMessage(session.id, "hello");

      expect(ptyMocks.capturedOpts?.extraArgs).toContain("--permission-mode");
      expect(ptyMocks.capturedOpts?.extraArgs).toContain("plan");
    });

    it("includes --permission-mode bypassPermissions when bypass active", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      // Set bypass before any spawn so the next spawn picks it up
      manager.setBypassAllPermissions(session.id);
      manager.sendMessage(session.id, "hello");

      expect(ptyMocks.capturedOpts?.extraArgs).toContain("--permission-mode");
      expect(ptyMocks.capturedOpts?.extraArgs).toContain("bypassPermissions");
    });
  });

  describe("PTY slash timeout", () => {
    it("sets a timeout when an unhandled slash command is forwarded to the PTY", () => {
      vi.useFakeTimers();
      try {
        const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
        manager.sendMessage(session.id, "hello");
        emitMessageDone();

        const statuses: string[] = [];
        manager.onStatus(session.id, (s) => statuses.push(s));

        manager.sendMessage(session.id, "/unknown-slash-cmd");
        expect(statuses).toContain("running");

        vi.advanceTimersByTime(8001);

        expect(ptyMocks.interrupt).toHaveBeenCalledTimes(1);
        expect(manager.listKnownSessions().find((s) => s.id === session.id)?.status).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears the timeout when PTY events arrive before it fires", () => {
      vi.useFakeTimers();
      try {
        const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
        manager.sendMessage(session.id, "hello");
        emitMessageDone();

        manager.sendMessage(session.id, "/unknown-slash-cmd");
        emitMessageDone();

        vi.advanceTimersByTime(8001);

        expect(ptyMocks.interrupt).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("PTY lifecycle callbacks", () => {
    it("onExit sets session status to idle", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      const statuses: string[] = [];
      manager.onStatus(session.id, (s) => statuses.push(s));

      ptyMocks.capturedOpts!.onExit({ exitCode: 0 });
      expect(statuses).toContain("idle");
      expect(manager.listKnownSessions().find((s) => s.id === session.id)?.status).toBe("idle");
    });

    it("onExit flushes a queued message by spawning again", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "queued"); // queued while running
      ptyMocks.start.mockClear();
      ptyMocks.capturedOpts!.onExit({ exitCode: 0 });
      expect(ptyMocks.start).toHaveBeenCalledTimes(1);
    });

    it("onEvents drives stream processing without throwing", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      expect(() => {
        ptyMocks.capturedOpts!.onEvents([{ type: "text_delta", text: "world" }]);
      }).not.toThrow();
    });

    it("start failure resets status to idle", async () => {
      ptyMocks.start.mockImplementationOnce(async () => {
        throw new Error("PTY launch failed");
      });

      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const errors: string[] = [];
      const statuses: string[] = [];
      manager.onError(session.id, (e) => errors.push(e));
      manager.onStatus(session.id, (s) => statuses.push(s));

      manager.sendMessage(session.id, "hello");
      await new Promise((r) => setTimeout(r, 0));

      expect(statuses).toContain("idle");
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("interrupt", () => {
    it("calls ptyRuntime.interrupt when alive", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");
      manager.interrupt(session.id);
      expect(ptyMocks.interrupt).toHaveBeenCalled();
    });

    it("is a no-op when pty is not alive", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.interrupt(session.id);
      expect(ptyMocks.interrupt).not.toHaveBeenCalled();
    });
  });

  describe("respondToPermission", () => {
    it("calls notifyPermissionDecision with allow + updatedInput", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      const toolInput = { command: "ls" };
      const result = manager.respondToPermission(session.id, "req-1", true, toolInput);

      expect(result).toBe(true);
      expect(ptyMocks.notifyPermissionDecision).toHaveBeenCalledWith("req-1", {
        behavior: "allow",
        updatedInput: toolInput,
      });
    });

    it("calls notifyPermissionDecision with deny when disallowed", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      const result = manager.respondToPermission(session.id, "req-1", false, undefined, undefined, "no thanks");

      expect(result).toBe(true);
      expect(ptyMocks.notifyPermissionDecision).toHaveBeenCalledWith("req-1", {
        behavior: "deny",
        message: "no thanks",
      });
    });

    it("omits updatedInput on allow when toolInput is undefined", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      manager.respondToPermission(session.id, "req-1", true, undefined);

      expect(ptyMocks.notifyPermissionDecision).toHaveBeenCalledWith("req-1", { behavior: "allow" });
    });

    it("returns false when pty is not alive", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const result = manager.respondToPermission(session.id, "req-1", true, undefined);
      expect(result).toBe(false);
    });
  });

  describe("setPlanMode", () => {
    it("kills alive PTY runtime", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");
      manager.setPlanMode(session.id);
      expect(ptyMocks.kill).toHaveBeenCalled();
    });

    it("sets status to idle after killing PTY", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");

      const statuses: string[] = [];
      manager.onStatus(session.id, (s) => statuses.push(s));

      manager.setPlanMode(session.id);
      expect(statuses).toContain("idle");
    });

    it("does not call kill when pty is not alive", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.setPlanMode(session.id);
      expect(ptyMocks.kill).not.toHaveBeenCalled();
    });
  });

  describe("clearPlanMode", () => {
    it("kills alive PTY runtime", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.setPlanMode(session.id);
      manager.sendMessage(session.id, "hello");
      manager.clearPlanMode(session.id);
      expect(ptyMocks.kill).toHaveBeenCalled();
    });
  });

  describe("scheduleRespawnForPermissions", () => {
    it("kills the PTY when session goes idle and bypass is toggled", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");
      // Drive status to idle via message_done while keeping ptyRuntime alive
      emitMessageDone();
      ptyMocks.kill.mockClear();

      // Now session is idle and ptyRuntime is alive → scheduleRespawnForPermissions should kill it
      manager.setBypassAllPermissions(session.id);
      expect(ptyMocks.kill).toHaveBeenCalled();
    });
  });

  describe("ensureProcess", () => {
    it("does not spawn when PTY is already alive", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello"); // spawns
      ptyMocks.start.mockClear();

      manager.ensureProcess(session.id);
      expect(ptyMocks.start).not.toHaveBeenCalled();
    });
  });

  describe("setRuntime", () => {
    it("kills PTY runtime when switching to stream", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");
      manager.setRuntime(session.id, "stream");
      expect(ptyMocks.kill).toHaveBeenCalled();
    });

    it("updates session info runtime to stream", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.setRuntime(session.id, "stream");
      const info = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(info?.runtime).toBe("stream");
    });
  });

  describe("PTY-handled slash commands", () => {
    it("/cost emits token usage without throwing", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const msgs: string[] = [];
      manager.onSystem(session.id, (m) => msgs.push(m));
      expect(manager.sendMessage(session.id, "/cost")).toBe(true);
      expect(msgs.some((m) => m.includes("Input tokens"))).toBe(true);
    });

    it("/context emits context usage without throwing", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const msgs: string[] = [];
      manager.onSystem(session.id, (m) => msgs.push(m));
      expect(manager.sendMessage(session.id, "/context")).toBe(true);
      expect(msgs.some((m) => m.includes("Context"))).toBe(true);
    });

    it("/status emits session info without throwing", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const msgs: string[] = [];
      manager.onSystem(session.id, (m) => msgs.push(m));
      expect(manager.sendMessage(session.id, "/status")).toBe(true);
      expect(msgs.some((m) => m.includes("Model"))).toBe(true);
    });

    it("/status shows plan mode suffix when plan mode is active", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      const msgs: string[] = [];
      manager.onSystem(session.id, (m) => msgs.push(m));
      manager.setPlanMode(session.id);
      expect(manager.sendMessage(session.id, "/status")).toBe(true);
      expect(msgs.some((m) => m.includes("[plan]"))).toBe(true);
    });

    it("intercepts dialog commands with warning in PTY mode", () => {
      const session = manager.createSession("/tmp", undefined, { runtime: "pty" });
      manager.sendMessage(session.id, "hello");
      const msgs: string[] = [];
      manager.onSystem(session.id, (m) => msgs.push(m));
      expect(manager.sendMessage(session.id, "/config")).toBe(true);
      expect(msgs.some((m) => m.includes("interactive CLI dialog"))).toBe(true);
    });

    it("passes dialog commands through in stream mode without warning", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (m) => msgs.push(m));
      manager.sendMessage(session.id, "/config");
      expect(msgs.every((m) => !m.includes("interactive CLI dialog"))).toBe(true);
    });
  });
});
