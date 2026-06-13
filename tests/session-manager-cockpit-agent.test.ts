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

vi.mock("@/server/singleton", () => ({
  getHookRouter: vi.fn(() => ({ register: vi.fn(), unregister: vi.fn() })),
  getSessionManager: vi.fn(),
}));

vi.mock("@/server/transcript-watcher", () => {
  class MockTranscriptWatcher {
    start = vi.fn();
    stop = vi.fn();
  }
  return { TranscriptWatcher: MockTranscriptWatcher };
});

vi.mock("@/server/paths", () => ({
  getCockpitDir: () => "/tmp/cockpit-config",
  getCockpitCacheDir: () => "/tmp/cockpit-cache",
}));

import { getAssistantSettings, updateAssistantSettings } from "@/server/assistant-settings";
import { SessionManager } from "@/server/session-manager";
import { getSessionPrefs, setSessionPrefs } from "@/server/session-prefs";
import { findSessionCwd } from "@/server/transcript";

const mockGetSettings = vi.mocked(getAssistantSettings);
const mockUpdateSettings = vi.mocked(updateAssistantSettings);
const mockGetPrefs = vi.mocked(getSessionPrefs);
const mockSetPrefs = vi.mocked(setSessionPrefs);
const mockFindCwd = vi.mocked(findSessionCwd);

describe("SessionManager cockpit agent session", () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high" });
    mockUpdateSettings.mockImplementation((p) => ({ model: "sonnet", thinkingLevel: "high", ...p }));
    mockGetPrefs.mockReturnValue(undefined);
    mockFindCwd.mockResolvedValue(null);
    manager = new SessionManager();
  });

  it("creates a new session when no sessionId is stored", async () => {
    const createSpy = vi.spyOn(manager, "createSession");
    const id = await manager.getOrCreateCockpitAgentSession();

    expect(id).toBeTruthy();
    expect(createSpy).toHaveBeenCalledTimes(1);
    // prefs write persists the cockpitAgent flag
    expect(mockSetPrefs).toHaveBeenCalledWith(id, expect.objectContaining({ cockpitAgent: true }));
    // the new session id is persisted to assistant.json
    expect(mockUpdateSettings).toHaveBeenCalledWith({ sessionId: id });
    expect((manager as any).sessions.get(id).cockpitAgent).toBe(true);
  });

  it("returns the stored id without creating when the session is already in memory", async () => {
    const created = manager.createSession("/tmp/cockpit-config", undefined, { cockpitAgent: true });
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high", sessionId: created.id });

    const createSpy = vi.spyOn(manager, "createSession");
    const id = await manager.getOrCreateCockpitAgentSession();

    expect(id).toBe(created.id);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("restores a stored session from disk after a server restart", async () => {
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high", sessionId: "S" });
    mockGetPrefs.mockReturnValue({ cockpitAgent: true, cliSessionId: "S" });
    mockFindCwd.mockResolvedValue("/tmp/cockpit-config");

    const createSpy = vi.spyOn(manager, "createSession");
    const id = await manager.getOrCreateCockpitAgentSession();

    expect(id).toBe("S");
    expect(createSpy).not.toHaveBeenCalled();
    const session = (manager as any).sessions.get("S");
    expect(session.cockpitAgent).toBe(true);
    expect(session.cockpitAgentCleanups.length).toBeGreaterThan(0);
  });

  it("restores the stored cockpit-agent id without recreating when it has no transcript yet (so model/thinking prefs survive)", async () => {
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high", sessionId: "gone" });
    mockGetPrefs.mockReturnValue({ cockpitAgent: true, cliSessionId: "gone" });
    mockFindCwd.mockResolvedValue(null);

    const createSpy = vi.spyOn(manager, "createSession");
    const id = await manager.getOrCreateCockpitAgentSession();

    // The assistant's cwd is always getCockpitDir(), so a missing transcript must
    // NOT trigger a fresh recreate from the assistant.json fallback (which would
    // drop the user's model/thinking). It restores the stored id from prefs.
    expect(id).toBe("gone");
    expect(createSpy).not.toHaveBeenCalled();
    expect((manager as any).sessions.get("gone").cockpitAgent).toBe(true);
  });

  it("restores previousCliSessionIds across a /clear round-trip", async () => {
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high", sessionId: "S" });
    mockGetPrefs.mockReturnValue({
      cockpitAgent: true,
      cliSessionId: "new-cli",
      previousCliSessionIds: ["old-cli"],
    });
    mockFindCwd.mockResolvedValue("/tmp/cockpit-config");

    const id = await manager.getOrCreateCockpitAgentSession();
    expect(id).toBe("S");
    expect((manager as any).sessions.get("S").previousCliSessionIds).toContain("old-cli");
  });

  it("funnels concurrent first-opens onto a single create", async () => {
    const createSpy = vi.spyOn(manager, "createSession");
    const [a, b] = await Promise.all([manager.getOrCreateCockpitAgentSession(), manager.getOrCreateCockpitAgentSession()]);
    expect(a).toBe(b);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("restore does not clobber an in-modal model choice with stale assistant.json", async () => {
    // assistant.json is stale (sonnet) but session-prefs holds the newer in-modal choice (opus)
    mockGetSettings.mockReturnValue({ model: "sonnet", thinkingLevel: "high", sessionId: "S" });
    mockGetPrefs.mockReturnValue({ cockpitAgent: true, modelSlots: { main: "opus" }, cliSessionId: "S" });
    mockFindCwd.mockResolvedValue("/tmp/cockpit-config");

    await manager.getOrCreateCockpitAgentSession();
    expect((manager as any).sessions.get("S").info.model).toBe("opus");
  });
});
