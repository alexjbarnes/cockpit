import { EventEmitter } from "node:events";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ manager: null as any }));

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

vi.mock("@/server/auth", () => ({ validateSession: (t: string) => t === "valid" }));

vi.mock("@/server/paths", () => ({
  getCockpitDir: () => "/tmp/cockpit-config",
  getCockpitCacheDir: () => "/tmp/cockpit-cache",
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
  findSessionCwd: vi.fn(() => Promise.resolve(null)),
  findTranscriptFile: vi.fn(() => Promise.resolve(null)),
  getTranscriptPath: () => "/tmp/fake.jsonl",
  loadPromptHistory: () => Promise.resolve([]),
  transcriptExists: () => false,
  loadMoreMessages: () => Promise.resolve({ messages: [], newByteOffset: 0 }),
}));

vi.mock("@/server/session-prefs", () => ({
  getSessionPrefs: vi.fn(() => undefined),
  setSessionPrefs: vi.fn(),
  findChainForCliSession: vi.fn(() => null),
  deleteSessionPrefs: vi.fn(),
}));

vi.mock("@/server/assistant-settings", () => ({
  getAssistantSettings: vi.fn(() => ({ model: "sonnet", thinkingLevel: "high" })),
  updateAssistantSettings: vi.fn((p) => ({ model: "sonnet", thinkingLevel: "high", ...p })),
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

vi.mock("@/server/pty-runtime", () => {
  class MockPtyRuntime {
    isAlive = true;
    pid = 12345;
    start = vi.fn().mockResolvedValue(undefined);
    kill = vi.fn().mockResolvedValue(undefined);
    sendText = vi.fn().mockResolvedValue(undefined);
    interrupt = vi.fn();
    notifyPermissionDecision = vi.fn();
  }
  return { PtyRuntime: MockPtyRuntime };
});

vi.mock("@/server/transcript-watcher", () => {
  class MockTranscriptWatcher {
    start = vi.fn();
    stop = vi.fn();
  }
  return { TranscriptWatcher: MockTranscriptWatcher };
});

vi.mock("@/server/singleton", () => ({
  getSessionManager: () => h.manager,
  getHookRouter: () => ({ register: vi.fn(), unregister: vi.fn() }),
  getCockpitMcp: vi.fn(),
}));

import { GET } from "@/app/api/assistant-session/route";
import { getAssistantSettings, updateAssistantSettings } from "@/server/assistant-settings";
import { SessionManager } from "@/server/session-manager";
import { getSessionPrefs } from "@/server/session-prefs";
import { findSessionCwd } from "@/server/transcript";

const mockGetSettings = vi.mocked(getAssistantSettings);
const mockUpdateSettings = vi.mocked(updateAssistantSettings);
const mockGetPrefs = vi.mocked(getSessionPrefs);
const mockFindCwd = vi.mocked(findSessionCwd);

function authedReq(): NextRequest {
  return new NextRequest("http://localhost/api/assistant-session", {
    headers: { cookie: "cockpit_session=valid" },
  });
}

describe("GET /api/assistant-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high" });
    mockUpdateSettings.mockImplementation((p) => ({ model: "sonnet", thinkingLevel: "high", ...p }));
    mockGetPrefs.mockReturnValue(undefined);
    mockFindCwd.mockResolvedValue(null);
    h.manager = new SessionManager();
  });

  it("returns a sessionId and the cockpit cwd when authed", async () => {
    const res = await GET(authedReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessionId).toBeTruthy();
    expect(body.cwd).toBe("/tmp/cockpit-config");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await GET(new NextRequest("http://localhost/api/assistant-session"));
    expect(res.status).toBe(401);
  });

  it("returns the same id across a simulated server restart", async () => {
    // First open: create + persist sessionId.
    const first = await (await GET(authedReq())).json();
    const id = first.sessionId;

    // Simulate restart: the session is gone from memory but its transcript and
    // stored id survive on disk.
    (h.manager as any).sessions.delete(id);
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high", sessionId: id });
    mockGetPrefs.mockReturnValue({ cockpitAgent: true, cliSessionId: id });
    mockFindCwd.mockResolvedValue("/tmp/cockpit-config");

    const second = await (await GET(authedReq())).json();
    expect(second.sessionId).toBe(id);
    expect((h.manager as any).sessions.has(id)).toBe(true);
  });
});
