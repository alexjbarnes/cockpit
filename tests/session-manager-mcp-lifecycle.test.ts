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
  loadTranscript: () => Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null }),
  loadMoreMessages: () => Promise.resolve({ messages: [], newByteOffset: 0 }),
  transcriptExists: () => false,
  findSessionCwd: () => Promise.resolve(null),
  getTranscriptPath: () => "/tmp/fake-transcript.jsonl",
  loadPromptHistory: () => Promise.resolve([]),
}));

vi.mock("@/server/session-prefs", () => ({
  getSessionPrefs: vi.fn(() => undefined),
  setSessionPrefs: vi.fn(),
  deleteSessionPrefs: vi.fn(),
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

const ptyInstances: { opts: { extraArgs: string[] } }[] = [];
vi.mock("@/server/pty-runtime", () => {
  class MockPtyRuntime {
    isAlive = false;
    kill = vi.fn().mockResolvedValue(undefined);
    start = vi.fn().mockResolvedValue(undefined);
    constructor(public opts: { extraArgs: string[] }) {
      ptyInstances.push(this);
    }
  }
  return { PtyRuntime: MockPtyRuntime };
});

const mockRegisterAuthToken = vi.fn();
const mockClearToken = vi.fn();
vi.mock("@/server/mcp/run-context", () => ({
  registerAuthToken: (t: string) => mockRegisterAuthToken(t),
  registerRunContext: vi.fn(),
  isValidToken: vi.fn(() => true),
  lookupRunContext: vi.fn(() => null),
  clearToken: (t: string) => mockClearToken(t),
}));

const mockGetUrl = vi.fn(() => "http://127.0.0.1:9999");
vi.mock("@/server/singleton", () => ({
  getHookRouter: vi.fn(() => ({
    register: vi.fn(() => "hook-token"),
    unregister: vi.fn(),
  })),
  getSessionManager: vi.fn(),
  getCockpitMcp: vi.fn(() => ({ getUrl: mockGetUrl })),
}));

vi.mock("@/server/transcript-watcher", () => {
  class MockTranscriptWatcher {
    start = vi.fn();
    stop = vi.fn();
  }
  return { TranscriptWatcher: MockTranscriptWatcher };
});

vi.mock("@/server/todo-watcher", () => {
  class MockTodoWatcher {
    start = vi.fn();
    stop = vi.fn();
  }
  return { TodoWatcher: MockTodoWatcher };
});

import { spawn } from "node:child_process";
import { COCKPIT_AGENT_SYSTEM_PROMPT } from "@/server/mcp/cockpit-agent-prompt";
import { SessionManager } from "@/server/session-manager";

describe("SessionManager MCP token lifecycle", () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyInstances.length = 0;
    manager = new SessionManager();
  });

  it("spawning a cockpit-agent session registers a token and sets mcpToken", () => {
    const info = manager.createSession("/tmp", undefined, { cockpitAgent: true });
    const mgr = manager as unknown as { sessions: Map<string, Record<string, unknown>>; spawnProcess: (s: unknown, id: string) => void };
    const s = mgr.sessions.get(info.id);
    expect(s).toBeDefined();

    mgr.spawnProcess(s, info.id);

    expect(mockRegisterAuthToken).toHaveBeenCalledOnce();
    const token = mockRegisterAuthToken.mock.calls[0][0];
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(s!.mcpToken).toBe(token);
  });

  it("destroySession clears the mcpToken", async () => {
    const info = manager.createSession("/tmp", undefined, { cockpitAgent: true });
    const mgr = manager as unknown as { sessions: Map<string, Record<string, unknown>>; spawnProcess: (s: unknown, id: string) => void };
    const s = mgr.sessions.get(info.id);
    expect(s).toBeDefined();

    mgr.spawnProcess(s, info.id);

    const token = s!.mcpToken as string;
    expect(typeof token).toBe("string");

    await manager.destroySession(info.id);

    expect(mockClearToken).toHaveBeenCalledWith(token);
  });

  it("cockpit-agent stream spawn includes --append-system-prompt", () => {
    const info = manager.createSession("/tmp", undefined, { cockpitAgent: true });
    const mgr = manager as unknown as { sessions: Map<string, unknown>; spawnProcess: (s: unknown, id: string) => void };
    const s = mgr.sessions.get(info.id);
    mgr.spawnProcess(s, info.id);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe(COCKPIT_AGENT_SYSTEM_PROMPT);
  });

  it("non-cockpit stream spawn does not include --append-system-prompt", () => {
    const info = manager.createSession("/tmp");
    const mgr = manager as unknown as { sessions: Map<string, unknown>; spawnProcess: (s: unknown, id: string) => void };
    const s = mgr.sessions.get(info.id);
    mgr.spawnProcess(s, info.id);

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).not.toContain("--append-system-prompt");
  });

  it("cockpit-agent PTY spawn includes --append-system-prompt in extraArgs", () => {
    const info = manager.createSession("/tmp", undefined, { cockpitAgent: true, runtime: "pty" });
    const mgr = manager as unknown as {
      sessions: Map<string, unknown>;
      spawnPtyProcess: (s: unknown, id: string) => void;
    };
    const s = mgr.sessions.get(info.id);
    mgr.spawnPtyProcess(s, info.id);

    expect(ptyInstances.length).toBeGreaterThan(0);
    const last = ptyInstances[ptyInstances.length - 1];
    expect(last.opts.extraArgs).toContain("--append-system-prompt");
    const idx = last.opts.extraArgs.indexOf("--append-system-prompt");
    expect(last.opts.extraArgs[idx + 1]).toBe(COCKPIT_AGENT_SYSTEM_PROMPT);
  });
});
