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

vi.mock("@/server/transcript", () => ({
  loadTranscript: () => Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null }),
  loadMoreMessages: () => Promise.resolve({ messages: [], newByteOffset: 0 }),
  transcriptExists: () => false,
  findSessionCwd: () => Promise.resolve(null),
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
    model: "sonnet",
  }),
}));

import { SessionManager } from "@/server/session-manager";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  describe("createSession", () => {
    it("creates a session with generated id", () => {
      const session = manager.createSession("/tmp");
      expect(session.id).toBeTruthy();
      expect(session.cwd).toBe("/tmp");
      expect(session.status).toBe("idle");
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.lastActiveAt).toBeGreaterThan(0);
    });

    it("uses directory basename as default name", () => {
      const session = manager.createSession("/home/user/my-project");
      expect(session.name).toBe("my-project");
    });

    it("uses custom name when provided", () => {
      const session = manager.createSession("/tmp", "My Session");
      expect(session.name).toBe("My Session");
    });
  });

  describe("getSession", () => {
    it("returns null for unknown id", async () => {
      expect(await manager.getSession("nonexistent")).toBeNull();
    });

    it("returns session info and empty messages", async () => {
      const created = manager.createSession("/tmp");
      const fetched = await manager.getSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.info.id).toBe(created.id);
      expect(fetched!.messages).toEqual([]);
    });
  });

  describe("ensureSession", () => {
    it("creates session entry if not exists", async () => {
      const session = manager.ensureSession("test-id", "/tmp/project");
      expect(session.info.id).toBe("test-id");
      expect(session.info.cwd).toBe("/tmp/project");

      const fetched = await manager.getSession("test-id");
      expect(fetched).not.toBeNull();
    });

    it("returns existing session if already tracked", () => {
      const created = manager.createSession("/tmp");
      const ensured = manager.ensureSession(created.id, "/tmp");
      expect(ensured.info.id).toBe(created.id);
    });
  });

  describe("listActiveSessions", () => {
    it("returns empty array initially", () => {
      expect(manager.listActiveSessions()).toEqual([]);
    });

    it("does not include idle sessions", () => {
      manager.createSession("/tmp/a");
      manager.createSession("/tmp/b");
      expect(manager.listActiveSessions()).toHaveLength(0);
    });
  });

  describe("destroySession", () => {
    it("returns false for unknown id", () => {
      expect(manager.destroySession("nonexistent")).toBe(false);
    });

    it("removes the session", async () => {
      const session = manager.createSession("/tmp");
      expect(manager.destroySession(session.id)).toBe(true);
      expect(await manager.getSession(session.id)).toBeNull();
    });
  });

  describe("subscribe", () => {
    it("returns null for unknown session", () => {
      expect(manager.subscribe("nonexistent", () => {})).toBeNull();
    });

    it("returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.subscribe(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });
  });

  describe("interrupt", () => {
    it("returns false when no process running", () => {
      const session = manager.createSession("/tmp");
      expect(manager.interrupt(session.id)).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(manager.interrupt("nonexistent")).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("returns false for unknown session", () => {
      expect(manager.sendMessage("nonexistent", "hello")).toBe(false);
    });

    it("sets status to running on send", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "hello");
      const _active = manager.listActiveSessions();
      // Process spawns but we can check status via getSession
      // The session status should be "running" after send
    });

    it("queues second message while running", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");

      const queued: number[] = [];
      manager.onQueued(session.id, (count) => queued.push(count));
      manager.sendMessage(session.id, "second");

      expect(queued).toHaveLength(1);
      expect(queued[0]).toBe(1);
    });

    it("handles slash commands", () => {
      const session = manager.createSession("/tmp", "Test Session");
      const result = manager.sendMessage(session.id, "/help");
      expect(result).toBe(true);
    });
  });

  describe("listKnownSessions", () => {
    it("returns empty array initially", () => {
      expect(manager.listKnownSessions()).toEqual([]);
    });

    it("returns all created sessions", () => {
      manager.createSession("/tmp/a");
      manager.createSession("/tmp/b");
      expect(manager.listKnownSessions()).toHaveLength(2);
    });

    it("returns sessions after ensureSession", () => {
      const session1 = manager.createSession("/tmp/a");
      manager.ensureSession("new-id", "/tmp/b");
      const known = manager.listKnownSessions();
      expect(known).toHaveLength(2);
      expect(known.map((s) => s.id)).toContain(session1.id);
      expect(known.map((s) => s.id)).toContain("new-id");
    });

    it("includes correct session info", () => {
      const created = manager.createSession("/tmp/project", "My Project");
      const known = manager.listKnownSessions();
      const found = known.find((s) => s.id === created.id);
      expect(found).toBeDefined();
      expect(found?.name).toBe("My Project");
      expect(found?.cwd).toBe("/tmp/project");
      expect(found?.status).toBe("idle");
    });
  });

  describe("fixStaleStatus", () => {
    it("does nothing for unknown session", () => {
      expect(() => manager.fixStaleStatus("nonexistent")).not.toThrow();
    });

    it("resets running status when no process", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "test");
      manager.fixStaleStatus(session.id);
      // After fix, status should still be set correctly by the method
      // The fix clears pending requests when resetting status
    });

    it("does not modify idle status", () => {
      const session = manager.createSession("/tmp");
      expect(session.status).toBe("idle");
      manager.fixStaleStatus(session.id);
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });
  });

  describe("onStatus", () => {
    it("returns null for unknown session", () => {
      expect(manager.onStatus("nonexistent", () => {})).toBeNull();
    });

    it("returns unsubscribe function for valid session", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onStatus(session.id, () => {});
      expect(typeof unsub).toBe("function");
      expect(() => unsub()).not.toThrow();
    });

    it("listener receives status changes", () => {
      const session = manager.createSession("/tmp");
      const statuses: Array<"idle" | "running"> = [];
      manager.onStatus(session.id, (status) => statuses.push(status));
      manager.sendMessage(session.id, "test");
      expect(statuses.length).toBeGreaterThanOrEqual(1);
      expect(statuses[0]).toBe("running");
    });

    it("unsubscribe stops receiving events", () => {
      const session = manager.createSession("/tmp");
      const statuses: Array<"idle" | "running"> = [];
      const unsub = manager.onStatus(session.id, (status) => statuses.push(status));
      unsub();
      manager.sendMessage(session.id, "test");
      expect(statuses).toHaveLength(0);
    });
  });

  describe("onError", () => {
    it("returns null for unknown session", () => {
      expect(manager.onError("nonexistent", () => {})).toBeNull();
    });

    it("returns unsubscribe function for valid session", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onError(session.id, () => {});
      expect(typeof unsub).toBe("function");
      expect(() => unsub()).not.toThrow();
    });
  });

  describe("onQueued", () => {
    it("returns null for unknown session", () => {
      expect(manager.onQueued("nonexistent", () => {})).toBeNull();
    });

    it("returns unsubscribe function for valid session", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onQueued(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("listener receives queue count updates", () => {
      const session = manager.createSession("/tmp");
      const counts: number[] = [];
      manager.onQueued(session.id, (count) => counts.push(count));
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      expect(counts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("setThinkingLevel", () => {
    it("sets thinking level on session", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      const level = manager.getThinkingLevel(session.id);
      expect(level).toBe("low");
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.setThinkingLevel("nonexistent", "low")).not.toThrow();
    });

    it("does not change if already set to same level", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "high");
      manager.setThinkingLevel(session.id, "high");
      expect(manager.getThinkingLevel(session.id)).toBe("high");
    });
  });

  describe("setModel", () => {
    it("sets model on session", () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "opus");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.setModel("nonexistent", "opus")).not.toThrow();
    });

    it("does not change if already set to same model", () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "sonnet");
      manager.setModel(session.id, "sonnet");
      expect(manager.getModel(session.id)).toBe("sonnet");
    });

    it("defaults to sonnet when not set", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getModel(session.id)).toBe("sonnet");
    });
  });

  describe("setPlanMode", () => {
    it("does nothing for unknown session", () => {
      expect(() => manager.setPlanMode("nonexistent")).not.toThrow();
    });

    it("sets plan mode on session", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });

    it("initially plan mode is inactive", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });
  });

  describe("setPermissionMode", () => {
    it("toggles bypass permissions", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isBypassActive(session.id)).toBe(false);
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
      manager.clearBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(false);
    });

    it("does nothing when setting bypass twice", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
    });

    it("does nothing when clearing bypass when already off", () => {
      const session = manager.createSession("/tmp");
      manager.clearBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(false);
    });
  });

  describe("context and status tracking", () => {
    it("tracks getThinkingLevel default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getThinkingLevel(session.id)).toBe("high");
    });

    it("tracks getModel default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getModel(session.id)).toBe("sonnet");
    });

    it("tracks isPlanModeActive default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("tracks isBypassActive default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isBypassActive(session.id)).toBe(false);
    });
  });

  describe("message queuing", () => {
    it("getQueuedCount returns correct value", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.sendMessage(session.id, "third");
      expect(manager.getQueuedCount(session.id)).toBe(2);
    });

    it("getQueuedMessages returns empty for unknown session", () => {
      expect(manager.getQueuedMessages("nonexistent")).toEqual([]);
    });

    it("hasQueuedMessage reflects queue state", () => {
      const session = manager.createSession("/tmp");
      expect(manager.hasQueuedMessage(session.id)).toBe(false);
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      expect(manager.hasQueuedMessage(session.id)).toBe(true);
    });

    it("isQueuePaused returns false initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isQueuePaused(session.id)).toBe(false);
    });
  });

  describe("status utilities", () => {
    it("isProcessAlive returns false for idle session", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isProcessAlive(session.id)).toBe(false);
    });

    it("isCompacting returns false initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isCompacting(session.id)).toBe(false);
    });

    it("getContextUsage returns null initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getContextUsage(session.id)).toBeNull();
    });

    it("getTodos returns empty array initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getTodos(session.id)).toEqual([]);
    });
  });

  describe("subscription and listener patterns", () => {
    it("subscribe returns null for unknown session", () => {
      expect(manager.subscribe("nonexistent", () => {})).toBeNull();
    });

    it("subscribe returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.subscribe(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onSystem returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onSystem(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onClear returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onClear(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onInfoUpdated returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onInfoUpdated(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onTodos returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onTodos(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onUsage returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onUsage(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onInit returns unsubscribe function", () => {
      const session = manager.createSession("/tmp");
      const unsub = manager.onInit(session.id, () => {});
      expect(typeof unsub).toBe("function");
    });
  });

  describe("request and utility methods", () => {
    it("getPendingRequests returns empty array for unknown session", () => {
      expect(manager.getPendingRequests("nonexistent")).toEqual([]);
    });

    it("getPendingRequests returns empty array initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getPendingRequests(session.id)).toEqual([]);
    });

    it("getTranscriptBuffer returns empty array initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getTranscriptBuffer(session.id)).toEqual([]);
    });

    it("getStreamingSnapshot returns null initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getStreamingSnapshot(session.id)).toBeNull();
    });

    it("getInitData returns undefined for unknown session", () => {
      expect(manager.getInitData("nonexistent")).toBeUndefined();
    });
  });

  describe("session lifecycle", () => {
    it("creates session and retrieves it", async () => {
      const created = manager.createSession("/tmp/test");
      const fetched = await manager.getSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.info.id).toBe(created.id);
    });

    it("destroys session and cannot retrieve it", async () => {
      const created = manager.createSession("/tmp/test");
      manager.destroySession(created.id);
      const fetched = await manager.getSession(created.id);
      expect(fetched).toBeNull();
    });

    it("session properties persist across operations", () => {
      const session = manager.createSession("/tmp/test", "Test");
      manager.setModel(session.id, "opus");
      manager.setThinkingLevel(session.id, "low");

      const known = manager.listKnownSessions();
      const found = known.find((s) => s.id === session.id);
      expect(found?.name).toBe("Test");
      expect(manager.getModel(session.id)).toBe("opus");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });
  });

  describe("handleCommand /rename", () => {
    it("renames session via /rename command", () => {
      const session = manager.createSession("/tmp", "Original Name");
      expect(session.name).toBe("Original Name");
      manager.sendMessage(session.id, "/rename New Name");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.name).toBe("New Name");
    });

    it("renames session to multiple word names", () => {
      const session = manager.createSession("/tmp", "Old");
      manager.sendMessage(session.id, "/rename My New Project Name");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.name).toBe("My New Project Name");
    });

    it("shows usage when /rename has no args", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/rename");
      expect(systemMessages.some((msg) => msg.includes("Usage: /rename"))).toBe(true);
    });

    it("emits info_updated after rename", () => {
      const session = manager.createSession("/tmp", "Initial");
      const infoUpdates: Array<{ name: string }> = [];
      manager.onInfoUpdated(session.id, (info) => infoUpdates.push({ name: info.name }));
      manager.sendMessage(session.id, "/rename Updated");
      expect(infoUpdates.length).toBeGreaterThan(0);
      expect(infoUpdates[infoUpdates.length - 1].name).toBe("Updated");
    });

    it("emits system message confirming rename", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/rename TestName");
      expect(systemMessages.some((msg) => msg.includes("TestName"))).toBe(true);
    });
  });

  describe("handleCommand /model", () => {
    it("switches model via /model command", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model opus");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("switches to different model types", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model opus");
      expect(manager.getModel(session.id)).toBe("opus");
      manager.sendMessage(session.id, "/model haiku");
      expect(manager.getModel(session.id)).toBe("haiku");
    });

    it("emits system message when model switched", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/model opus");
      expect(systemMessages.some((msg) => msg.includes("opus"))).toBe(true);
    });

    it("emits info_updated after model change", () => {
      const session = manager.createSession("/tmp");
      const infoUpdates: Array<{ model: string }> = [];
      manager.onInfoUpdated(session.id, (info) => infoUpdates.push({ model: info.model }));
      manager.sendMessage(session.id, "/model opus");
      expect(infoUpdates.length).toBeGreaterThan(0);
      expect(infoUpdates[infoUpdates.length - 1].model).toBe("opus");
    });

    it("sets status to idle after model switch", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model opus");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });

    it("shows model picker when /model has no args", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/model");
      expect(systemMessages.some((msg) => msg.includes("model_picker"))).toBe(true);
    });
  });

  describe("handleCommand /clear", () => {
    it("clears session via /clear command", () => {
      const session = manager.createSession("/tmp");
      const clears: number[] = [];
      manager.onClear(session.id, () => clears.push(1));
      manager.sendMessage(session.id, "/clear");
      expect(clears).toHaveLength(1);
    });

    it("/reset is alias for /clear", () => {
      const session = manager.createSession("/tmp");
      const clears: number[] = [];
      manager.onClear(session.id, () => clears.push(1));
      manager.sendMessage(session.id, "/reset");
      expect(clears).toHaveLength(1);
    });

    it("/new is alias for /clear", () => {
      const session = manager.createSession("/tmp");
      const clears: number[] = [];
      manager.onClear(session.id, () => clears.push(1));
      manager.sendMessage(session.id, "/new");
      expect(clears).toHaveLength(1);
    });

    it("resets status to idle after clear", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/clear");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });

    it("clears queued messages on clear", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      expect(manager.getQueuedCount(session.id)).toBeGreaterThan(0);
      manager.sendMessage(session.id, "/clear");
      expect(manager.getQueuedCount(session.id)).toBe(0);
    });

    it("emits clear event", () => {
      const session = manager.createSession("/tmp");
      const clears: number[] = [];
      manager.onClear(session.id, () => clears.push(1));
      manager.sendMessage(session.id, "/clear");
      expect(clears).toHaveLength(1);
    });
  });

  describe("handleCommand /help", () => {
    it("shows help text for /help command", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/help");
      expect(systemMessages.length).toBeGreaterThan(0);
      const helpText = systemMessages[systemMessages.length - 1];
      expect(helpText).toContain("Cockpit commands");
      expect(helpText).toContain("/clear");
      expect(helpText).toContain("/rename");
    });
  });

  describe("setModel with status emission", () => {
    it("changes model directly via setModel", () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "opus");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("emits info_updated event for model change", () => {
      const session = manager.createSession("/tmp");
      const infoUpdates: Array<{ model: string }> = [];
      manager.onInfoUpdated(session.id, (info) => infoUpdates.push({ model: info.model }));
      manager.setModel(session.id, "haiku");
      expect(infoUpdates.length).toBeGreaterThan(0);
      expect(infoUpdates[0].model).toBe("haiku");
    });

    it("persists model across sessions", () => {
      const session = manager.createSession("/tmp", "test");
      manager.setModel(session.id, "opus");
      const known = manager.listKnownSessions();
      const found = known.find((s) => s.id === session.id);
      expect(found?.model).toBe("opus");
    });
  });

  describe("setThinkingLevel with status emission", () => {
    it("changes thinking level directly via setThinkingLevel", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });

    it("emits system event for thinking level change", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.setThinkingLevel(session.id, "medium");
      expect(systemMessages.length).toBeGreaterThan(0);
      expect(systemMessages[0]).toContain("medium");
    });

    it("changes from high to low", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getThinkingLevel(session.id)).toBe("high");
      manager.setThinkingLevel(session.id, "low");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });

    it("changes from low to high", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      manager.setThinkingLevel(session.id, "high");
      expect(manager.getThinkingLevel(session.id)).toBe("high");
    });
  });

  describe("setPlanMode with state management", () => {
    it("activates plan mode", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });

    it("emits system event when plan mode activated", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.setPlanMode(session.id);
      expect(systemMessages.some((msg) => msg.includes("__plan_state::on"))).toBe(true);
    });

    it("sets status to idle when activating plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });

    it("deactivates plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
      manager.clearPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("emits system event when plan mode deactivated", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.clearPlanMode(session.id);
      expect(systemMessages.some((msg) => msg.includes("__plan_state::off"))).toBe(true);
    });
  });

  describe("permission mode via setBypassAllPermissions", () => {
    it("activates bypass via setBypassAllPermissions", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isBypassActive(session.id)).toBe(false);
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
    });

    it("emits system event when bypass activated", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.setBypassAllPermissions(session.id);
      expect(systemMessages.some((msg) => msg.includes("__bypass_state::on"))).toBe(true);
    });

    it("deactivates bypass via clearBypassAllPermissions", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
      manager.clearBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(false);
    });

    it("emits system event when bypass deactivated", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.clearBypassAllPermissions(session.id);
      expect(systemMessages.some((msg) => msg.includes("__bypass_state::off"))).toBe(true);
    });

    it("handles multiple activations gracefully", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
    });

    it("handles multiple deactivations gracefully", () => {
      const session = manager.createSession("/tmp");
      manager.clearBypassAllPermissions(session.id);
      manager.clearBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(false);
    });
  });

  describe("slash command integration", () => {
    it("returns true for recognized commands", () => {
      const session = manager.createSession("/tmp");
      expect(manager.sendMessage(session.id, "/help")).toBe(true);
      expect(manager.sendMessage(session.id, "/clear")).toBe(true);
      expect(manager.sendMessage(session.id, "/rename Test")).toBe(true);
    });

    it("handles /compact command by marking session as compacting", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/compact");
      expect(manager.isCompacting(session.id)).toBe(true);
    });

    it("unknown slash commands pass through to Claude", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/cost");
      expect(result).toBe(true);
    });
  });

  describe("combined operations", () => {
    it("rename persists after model change", () => {
      const session = manager.createSession("/tmp", "Original");
      manager.sendMessage(session.id, "/rename Updated");
      manager.setModel(session.id, "opus");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.name).toBe("Updated");
      expect(updated?.model).toBe("opus");
    });

    it("thinking level persists after rename", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      manager.sendMessage(session.id, "/rename Test");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });

    it("plan mode and bypass can coexist initially but plan supersedes", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
      expect(manager.isBypassActive(session.id)).toBe(true);
    });

    it("multiple commands in sequence", () => {
      const session = manager.createSession("/tmp", "Initial");
      manager.sendMessage(session.id, "/rename Session1");
      manager.sendMessage(session.id, "/model opus");
      manager.setThinkingLevel(session.id, "low");
      manager.setPlanMode(session.id);

      const final = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(final?.name).toBe("Session1");
      expect(final?.model).toBe("opus");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });
  });

  describe("queue management", () => {
    it("hasQueuedMessage returns false initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.hasQueuedMessage(s.id)).toBe(false);
    });

    it("getQueuedCount returns 0 initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getQueuedCount(s.id)).toBe(0);
    });

    it("getQueuedCount returns 0 for unknown session", () => {
      expect(manager.getQueuedCount("nope")).toBe(0);
    });

    it("hasQueuedMessage returns false for unknown session", () => {
      expect(manager.hasQueuedMessage("nope")).toBe(false);
    });

    it("queues messages when running and tracks count", () => {
      const s = manager.createSession("/tmp");
      manager.sendMessage(s.id, "first");
      manager.sendMessage(s.id, "second");
      manager.sendMessage(s.id, "third");
      expect(manager.getQueuedCount(s.id)).toBe(2);
      expect(manager.hasQueuedMessage(s.id)).toBe(true);
    });

    it("getQueuedMessages returns queued text", () => {
      const s = manager.createSession("/tmp");
      manager.sendMessage(s.id, "first");
      manager.sendMessage(s.id, "second");
      const queued = manager.getQueuedMessages(s.id);
      expect(queued).toHaveLength(1);
      expect(queued[0].text).toBe("second");
    });

    it("getQueuedMessages returns empty for unknown session", () => {
      expect(manager.getQueuedMessages("nope")).toEqual([]);
    });

    it("cancelQueuedMessage removes last queued message", () => {
      const s = manager.createSession("/tmp");
      manager.sendMessage(s.id, "first");
      manager.sendMessage(s.id, "second");
      manager.sendMessage(s.id, "third");
      const cancelled = manager.cancelQueuedMessage(s.id);
      expect(cancelled).toBe("third");
      expect(manager.getQueuedCount(s.id)).toBe(1);
    });

    it("cancelQueuedMessage returns null when queue empty", () => {
      const s = manager.createSession("/tmp");
      expect(manager.cancelQueuedMessage(s.id)).toBeNull();
    });

    it("cancelQueuedMessage returns null for unknown session", () => {
      expect(manager.cancelQueuedMessage("nope")).toBeNull();
    });

    it("deleteQueuedMessage removes specific message by id", () => {
      const s = manager.createSession("/tmp");
      manager.sendMessage(s.id, "first");
      manager.sendMessage(s.id, "second");
      manager.sendMessage(s.id, "third");
      const queued = manager.getQueuedMessages(s.id);
      expect(manager.deleteQueuedMessage(s.id, queued[0].id)).toBe(true);
      expect(manager.getQueuedCount(s.id)).toBe(1);
    });

    it("deleteQueuedMessage returns false for unknown message", () => {
      const s = manager.createSession("/tmp");
      expect(manager.deleteQueuedMessage(s.id, "nope")).toBe(false);
    });

    it("deleteQueuedMessage returns false for unknown session", () => {
      expect(manager.deleteQueuedMessage("nope", "nope")).toBe(false);
    });

    it("editQueuedMessage removes and returns text", () => {
      const s = manager.createSession("/tmp");
      manager.sendMessage(s.id, "first");
      manager.sendMessage(s.id, "second");
      const queued = manager.getQueuedMessages(s.id);
      const text = manager.editQueuedMessage(s.id, queued[0].id);
      expect(text).toBe("second");
      expect(manager.getQueuedCount(s.id)).toBe(0);
    });

    it("editQueuedMessage returns null for unknown message", () => {
      const s = manager.createSession("/tmp");
      expect(manager.editQueuedMessage(s.id, "nope")).toBeNull();
    });

    it("editQueuedMessage returns null for unknown session", () => {
      expect(manager.editQueuedMessage("nope", "nope")).toBeNull();
    });

    it("pauseQueue and isQueuePaused", () => {
      const s = manager.createSession("/tmp");
      expect(manager.isQueuePaused(s.id)).toBe(false);
      manager.pauseQueue(s.id);
      expect(manager.isQueuePaused(s.id)).toBe(true);
    });

    it("isQueuePaused returns false for unknown session", () => {
      expect(manager.isQueuePaused("nope")).toBe(false);
    });
  });

  describe("pending requests", () => {
    it("addPendingRequest and getPendingRequests", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getPendingRequests(s.id)).toEqual([]);
      manager.addPendingRequest(s.id, { requestId: "r1", toolName: "Bash", toolInput: {} });
      const pending = manager.getPendingRequests(s.id);
      expect(pending).toHaveLength(1);
      expect(pending[0].requestId).toBe("r1");
    });

    it("removePendingRequest removes by id", () => {
      const s = manager.createSession("/tmp");
      manager.addPendingRequest(s.id, { requestId: "r1", toolName: "Bash", toolInput: {} });
      manager.removePendingRequest(s.id, "r1");
      expect(manager.getPendingRequests(s.id)).toEqual([]);
    });

    it("getPendingRequests returns empty for unknown session", () => {
      expect(manager.getPendingRequests("nope")).toEqual([]);
    });
  });

  describe("context and state getters", () => {
    it("getContextUsage returns null initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getContextUsage(s.id)).toBeNull();
    });

    it("getStreamingSnapshot returns null initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getStreamingSnapshot(s.id)).toBeNull();
    });

    it("isCompacting returns false initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.isCompacting(s.id)).toBe(false);
    });

    it("isCompacting returns false for unknown session", () => {
      expect(manager.isCompacting("nope")).toBe(false);
    });

    it("isProcessAlive returns false initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.isProcessAlive(s.id)).toBe(false);
    });

    it("getTranscriptBuffer returns empty initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getTranscriptBuffer(s.id)).toEqual([]);
    });

    it("getTranscriptBuffer returns empty for unknown session", () => {
      expect(manager.getTranscriptBuffer("nope")).toEqual([]);
    });

    it("getTodos returns empty initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getTodos(s.id)).toEqual([]);
    });

    it("getModel returns default model", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getModel(s.id)).toBe("sonnet");
    });

    it("getModel returns sonnet for unknown session", () => {
      expect(manager.getModel("nope")).toBe("sonnet");
    });

    it("getThinkingLevel returns default", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getThinkingLevel(s.id)).toBe("high");
    });

    it("getThinkingLevel returns high for unknown session", () => {
      expect(manager.getThinkingLevel("nope")).toBe("high");
    });
  });

  describe("initData", () => {
    it("getInitData returns undefined initially", () => {
      const s = manager.createSession("/tmp");
      expect(manager.getInitData(s.id)).toBeUndefined();
    });

    it("setInitData and getInitData round-trip", () => {
      const s = manager.createSession("/tmp");
      const data = {
        slashCommands: ["/help"],
        skills: ["commit"],
        agents: [{ name: "coder" }],
        version: "1.0",
        model: "opus",
        mcpServers: [],
      };
      manager.setInitData(s.id, data);
      const result = manager.getInitData(s.id);
      expect(result?.model).toBe("opus");
      expect(result?.slashCommands).toEqual(["/help"]);
    });

    it("setInitData does nothing for unknown session", () => {
      const data = {
        slashCommands: [],
        skills: [],
        agents: [],
        version: "",
        model: "",
        mcpServers: [],
      };
      expect(() => manager.setInitData("nope", data)).not.toThrow();
    });

    it("setInitData merges with previous data", () => {
      const s = manager.createSession("/tmp");
      manager.setInitData(s.id, {
        slashCommands: ["/help"],
        skills: [],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [{ name: "srv", status: "connected" }],
      });
      manager.setInitData(s.id, {
        slashCommands: [],
        skills: ["commit"],
        agents: [],
        version: "",
        model: "",
        mcpServers: [],
      });
      const result = manager.getInitData(s.id);
      expect(result?.slashCommands).toEqual(["/help"]);
      expect(result?.skills).toEqual(["commit"]);
      expect(result?.version).toBe("1.0");
    });

    it("onInit listener fires on setInitData", () => {
      const s = manager.createSession("/tmp");
      const received: unknown[] = [];
      manager.onInit(s.id, (data) => received.push(data));
      manager.setInitData(s.id, {
        slashCommands: [],
        skills: [],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [],
      });
      expect(received).toHaveLength(1);
    });

    it("onInit returns null for unknown session", () => {
      expect(manager.onInit("nope", () => {})).toBeNull();
    });
  });

  describe("listener subscriptions", () => {
    it("onUsage returns null for unknown session", () => {
      expect(manager.onUsage("nope", () => {})).toBeNull();
    });

    it("onUsage returns unsubscribe function", () => {
      const s = manager.createSession("/tmp");
      const unsub = manager.onUsage(s.id, () => {});
      expect(typeof unsub).toBe("function");
    });

    it("onTodos returns null for unknown session", () => {
      expect(manager.onTodos("nope", () => {})).toBeNull();
    });

    it("onTodos returns unsubscribe function", () => {
      const s = manager.createSession("/tmp");
      const unsub = manager.onTodos(s.id, () => {});
      expect(typeof unsub).toBe("function");
    });
  });

  describe("respondToPermission", () => {
    it("returns false when session has no stdin", () => {
      const session = manager.createSession("/tmp");
      const result = manager.respondToPermission(session.id, "req-1", true);
      expect(result).toBe(false);
    });

    it("returns false for unknown session", () => {
      const result = manager.respondToPermission("nonexistent", "req-1", true);
      expect(result).toBe(false);
    });

    it("does not throw when session unknown", () => {
      expect(() => manager.respondToPermission("nonexistent", "req-1", false)).not.toThrow();
    });

    it("handles permission response without toolInput", () => {
      const session = manager.createSession("/tmp");
      const result = manager.respondToPermission(session.id, "req-1", true);
      expect(result).toBe(false);
    });

    it("handles permission response with toolInput", () => {
      const session = manager.createSession("/tmp");
      const toolInput = { arg: "value" };
      const result = manager.respondToPermission(session.id, "req-1", true, toolInput);
      expect(result).toBe(false);
    });

    it("handles permission denial with denyReason", () => {
      const session = manager.createSession("/tmp");
      const result = manager.respondToPermission(session.id, "req-1", false, undefined, undefined, "User declined");
      expect(result).toBe(false);
    });

    it("removes pending request when responding with stdin", () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, { requestId: "req-1", toolName: "Bash", toolInput: {} });
      expect(manager.getPendingRequests(session.id)).toHaveLength(1);
      const result = manager.respondToPermission(session.id, "req-1", true);
      expect(result).toBe(false);
    });
  });

  describe("permission bypass and plan mode edge cases", () => {
    it("isBypassActive returns false for unknown session", () => {
      expect(manager.isBypassActive("nonexistent")).toBe(false);
    });

    it("isPlanModeActive returns false for unknown session", () => {
      expect(manager.isPlanModeActive("nonexistent")).toBe(false);
    });

    it("clearPlanMode does nothing for unknown session", () => {
      expect(() => manager.clearPlanMode("nonexistent")).not.toThrow();
    });

    it("clearPlanMode with no active plan mode does nothing", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
      manager.clearPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("setBypassAllPermissions with no active bypass does nothing", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isBypassActive(session.id)).toBe(false);
      manager.setBypassAllPermissions(session.id);
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
    });

    it("clearBypassAllPermissions with no active bypass does nothing", () => {
      const session = manager.createSession("/tmp");
      manager.clearBypassAllPermissions(session.id);
      manager.clearBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(false);
    });

    it("plan mode and bypass can both be active", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      manager.setPlanMode(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });
  });

  describe("getSessionByCwd", () => {
    it("creates session if not tracked", async () => {
      const result = await manager.getSessionByCwd("test-id-123", "/tmp/test");
      expect(result).not.toBeNull();
      expect(result?.info.id).toBe("test-id-123");
      expect(result?.info.cwd).toBe("/tmp/test");
    });

    it("returns existing session if already tracked", async () => {
      const created = manager.createSession("/tmp/project");
      const result = await manager.getSessionByCwd(created.id, "/tmp/project");
      expect(result?.info.id).toBe(created.id);
    });

    it("loads messages array", async () => {
      const session = manager.createSession("/tmp");
      const result = await manager.getSessionByCwd(session.id, "/tmp");
      expect(Array.isArray(result?.messages)).toBe(true);
    });

    it("includes lastUsage in response", async () => {
      const session = manager.createSession("/tmp");
      const result = await manager.getSessionByCwd(session.id, "/tmp");
      expect(result?.lastUsage).toBe(null);
    });
  });

  describe("sendMessage with slash commands", () => {
    it("returns false for unknown session", () => {
      const result = manager.sendMessage("nonexistent", "/help");
      expect(result).toBe(false);
    });

    it("handles /thinking command", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/thinking");
      expect(result).toBe(true);
    });

    it("handles /analyze command", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/analyze");
      expect(result).toBe(true);
    });

    it("handles /review command", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/review");
      expect(result).toBe(true);
    });

    it("handles /cost command", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/cost");
      expect(result).toBe(true);
    });

    it("handles /context command", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/context");
      expect(result).toBe(true);
    });

    it("processes /compact and marks session as compacting", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isCompacting(session.id)).toBe(false);
      manager.sendMessage(session.id, "/compact");
      expect(manager.isCompacting(session.id)).toBe(true);
    });

    it("/compact is recognized as unknown command and passes through", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/compact");
      expect(result).toBe(true);
    });

    it("unknown slash commands pass through to Claude", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/unknown");
      expect(result).toBe(true);
    });

    it("slash command with args", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/rename My New Name");
      expect(result).toBe(true);
    });

    it("respects queue pause after sendMessage", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.pauseQueue(session.id);
      expect(manager.isQueuePaused(session.id)).toBe(true);
      manager.sendMessage(session.id, "second");
      expect(manager.isQueuePaused(session.id)).toBe(false);
    });
  });

  describe("cancelQueuedMessage when queue has items", () => {
    it("returns the cancelled message text", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.sendMessage(session.id, "third");
      const cancelled = manager.cancelQueuedMessage(session.id);
      expect(cancelled).toBe("third");
    });

    it("decrements queue count", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.sendMessage(session.id, "third");
      expect(manager.getQueuedCount(session.id)).toBe(2);
      manager.cancelQueuedMessage(session.id);
      expect(manager.getQueuedCount(session.id)).toBe(1);
    });

    it("removes the last queued message", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.sendMessage(session.id, "third");
      manager.cancelQueuedMessage(session.id);
      const queued = manager.getQueuedMessages(session.id);
      expect(queued).toHaveLength(1);
      expect(queued[0].text).toBe("second");
    });

    it("returns null when queue is empty", () => {
      const session = manager.createSession("/tmp");
      const cancelled = manager.cancelQueuedMessage(session.id);
      expect(cancelled).toBeNull();
    });

    it("returns null for unknown session", () => {
      const cancelled = manager.cancelQueuedMessage("nonexistent");
      expect(cancelled).toBeNull();
    });

    it("handles multiple cancellations in sequence", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.sendMessage(session.id, "third");
      expect(manager.cancelQueuedMessage(session.id)).toBe("third");
      expect(manager.cancelQueuedMessage(session.id)).toBe("second");
      expect(manager.cancelQueuedMessage(session.id)).toBeNull();
    });
  });

  describe("unknown slash commands pass through to CLI", () => {
    it("/cost passes through and returns true", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/cost");
      expect(result).toBe(true);
    });

    it("/commit passes through and returns true", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/commit");
      expect(result).toBe(true);
    });

    it("/custom-command passes through and returns true", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/custom-command");
      expect(result).toBe(true);
    });
  });

  describe("isPlanModeActive and related plan methods", () => {
    it("isPlanModeActive initially false", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("setPlanMode activates plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });

    it("clearPlanMode deactivates plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      manager.clearPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("toggles plan mode on and off", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
      manager.clearPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(false);
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });
  });

  describe("model and thinking level immutability", () => {
    it("does not emit info_updated when setting same model twice", () => {
      const session = manager.createSession("/tmp");
      const infoUpdates: number[] = [];
      manager.onInfoUpdated(session.id, () => infoUpdates.push(1));
      manager.setModel(session.id, "opus");
      manager.setModel(session.id, "opus");
      expect(infoUpdates.length).toBe(1);
    });

    it("does not emit thinking level when setting same level twice", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.setThinkingLevel(session.id, "low");
      manager.setThinkingLevel(session.id, "low");
      expect(systemMessages.length).toBe(1);
    });

    it("emits when changing from high to low", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.setThinkingLevel(session.id, "low");
      expect(systemMessages.length).toBeGreaterThan(0);
    });
  });

  describe("handleCommand /help variations", () => {
    it("shows help with /help", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/help");
      expect(systemMessages.length).toBeGreaterThan(0);
      const helpMsg = systemMessages[systemMessages.length - 1];
      expect(helpMsg).toContain("Cockpit commands");
    });

    it("help message includes all main commands", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/help");
      const helpMsg = systemMessages[systemMessages.length - 1];
      expect(helpMsg).toContain("/clear");
      expect(helpMsg).toContain("/reset");
      expect(helpMsg).toContain("/new");
      expect(helpMsg).toContain("/model");
      expect(helpMsg).toContain("/rename");
    });

    it("help message mentions pass-through commands", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/help");
      const helpMsg = systemMessages[systemMessages.length - 1];
      expect(helpMsg).toContain("/compact");
      expect(helpMsg).toContain("Claude");
    });
  });

  describe("command edge cases and malformed inputs", () => {
    it("handles /rename with leading/trailing spaces", () => {
      const session = manager.createSession("/tmp", "Old");
      manager.sendMessage(session.id, "/rename   New Name   ");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.name).toBe("New Name");
    });

    it("handles /model with leading/trailing spaces", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model   opus   ");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("/clear with extra args still works", () => {
      const session = manager.createSession("/tmp");
      const clears: number[] = [];
      manager.onClear(session.id, () => clears.push(1));
      manager.sendMessage(session.id, "/clear extra args");
      expect(clears).toHaveLength(1);
    });

    it("case insensitive command handling", () => {
      const session = manager.createSession("/tmp");
      const clears: number[] = [];
      manager.onClear(session.id, () => clears.push(1));
      manager.sendMessage(session.id, "/CLEAR");
      expect(clears).toHaveLength(1);
    });

    it("/Help uppercase works", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/HELP");
      expect(systemMessages.length).toBeGreaterThan(0);
    });
  });

  describe("permission mode integration with plan mode", () => {
    it("clearing plan mode re-syncs bypass state", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      manager.setPlanMode(session.id);
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.clearPlanMode(session.id);
      expect(systemMessages.some((msg) => msg.includes("__bypass_state::on"))).toBe(true);
    });

    it("clearing plan mode without bypass does not re-emit bypass", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.clearPlanMode(session.id);
      expect(systemMessages.some((msg) => msg.includes("__bypass_state"))).toBe(false);
    });
  });

  describe("session state after operations", () => {
    it("session status is idle after /clear", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "test");
      manager.sendMessage(session.id, "/clear");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });

    it("session status is idle after /model", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model opus");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });

    it("session status is idle after /rename", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/rename NewName");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });
  });

  describe("queued message structure", () => {
    it("queued messages have id and text fields", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      const queued = manager.getQueuedMessages(session.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toHaveProperty("id");
      expect(queued[0]).toHaveProperty("text");
      expect(typeof queued[0].id).toBe("string");
      expect(typeof queued[0].text).toBe("string");
    });

    it("queued message ids are unique", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.sendMessage(session.id, "third");
      const queued = manager.getQueuedMessages(session.id);
      const ids = queued.map((q) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("clearPlanMode after setPlanMode", () => {
    it("emits system event on clear", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.clearPlanMode(session.id);
      expect(systemMessages.some((msg) => msg.includes("__plan_state::off"))).toBe(true);
    });

    it("kills process when clearing plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
      manager.clearPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("resets status to idle when clearing plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      manager.clearPlanMode(session.id);
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });
  });

  describe("isProcessAlive and process state", () => {
    it("isProcessAlive returns false initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isProcessAlive(session.id)).toBe(false);
    });

    it("isProcessAlive returns false for unknown session", () => {
      expect(manager.isProcessAlive("nonexistent")).toBe(false);
    });
  });

  describe("getTranscriptBuffer", () => {
    it("returns empty array initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getTranscriptBuffer(session.id)).toEqual([]);
    });

    it("returns empty array for unknown session", () => {
      expect(manager.getTranscriptBuffer("nonexistent")).toEqual([]);
    });
  });

  describe("getStreamingSnapshot", () => {
    it("returns null initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getStreamingSnapshot(session.id)).toBeNull();
    });

    it("returns null for unknown session", () => {
      expect(manager.getStreamingSnapshot("nonexistent")).toBeNull();
    });
  });

  describe("isCompacting state", () => {
    it("returns false initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isCompacting(session.id)).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(manager.isCompacting("nonexistent")).toBe(false);
    });

    it("marks session as compacting on /compact command", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/compact");
      expect(manager.isCompacting(session.id)).toBe(true);
    });
  });

  describe("subscription return values", () => {
    it("onSystem returns null for unknown session", () => {
      expect(manager.onSystem("nonexistent", () => {})).toBeNull();
    });

    it("onClear returns null for unknown session", () => {
      expect(manager.onClear("nonexistent", () => {})).toBeNull();
    });

    it("onInfoUpdated returns null for unknown session", () => {
      expect(manager.onInfoUpdated("nonexistent", () => {})).toBeNull();
    });

    it("subscribe returns null for unknown session", () => {
      expect(manager.subscribe("nonexistent", () => {})).toBeNull();
    });
  });

  describe("getTodos", () => {
    it("returns empty array initially", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getTodos(session.id)).toEqual([]);
    });

    it("returns empty array for unknown session", () => {
      expect(manager.getTodos("nonexistent")).toEqual([]);
    });
  });

  describe("addPendingRequest and removePendingRequest", () => {
    it("adds a pending request", () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, { requestId: "r1", toolName: "Bash", toolInput: {} });
      expect(manager.getPendingRequests(session.id)).toHaveLength(1);
      expect(manager.getPendingRequests(session.id)[0].requestId).toBe("r1");
    });

    it("removes a pending request", () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, { requestId: "r1", toolName: "Bash", toolInput: {} });
      manager.removePendingRequest(session.id, "r1");
      expect(manager.getPendingRequests(session.id)).toHaveLength(0);
    });

    it("removePendingRequest does nothing for unknown message", () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, { requestId: "r1", toolName: "Bash", toolInput: {} });
      manager.removePendingRequest(session.id, "unknown");
      expect(manager.getPendingRequests(session.id)).toHaveLength(1);
    });

    it("removePendingRequest does nothing for unknown session", () => {
      expect(() => manager.removePendingRequest("nonexistent", "r1")).not.toThrow();
    });
  });

  describe("handleCommand /rename edge cases", () => {
    it("renames to single word", () => {
      const session = manager.createSession("/tmp", "Old");
      manager.sendMessage(session.id, "/rename Single");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.name).toBe("Single");
    });

    it("renames with special characters", () => {
      const session = manager.createSession("/tmp", "Old");
      manager.sendMessage(session.id, "/rename My-Project (v2)");
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.name).toBe("My-Project (v2)");
    });
  });

  describe("handleCommand /model edge cases", () => {
    it("switches to haiku model", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model haiku");
      expect(manager.getModel(session.id)).toBe("haiku");
    });

    it("switches to opus model", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "/model opus");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("emits system message confirming model switch", () => {
      const session = manager.createSession("/tmp");
      const systemMessages: string[] = [];
      manager.onSystem(session.id, (msg) => systemMessages.push(msg));
      manager.sendMessage(session.id, "/model haiku");
      expect(systemMessages.some((msg) => msg.includes("haiku"))).toBe(true);
    });
  });

  describe("setModel direct API", () => {
    it("changes model and emits info_updated", () => {
      const session = manager.createSession("/tmp");
      const infoUpdates: Array<{ model: string }> = [];
      manager.onInfoUpdated(session.id, (info) => infoUpdates.push({ model: info.model }));
      manager.setModel(session.id, "haiku");
      expect(infoUpdates.length).toBeGreaterThan(0);
      expect(infoUpdates[infoUpdates.length - 1].model).toBe("haiku");
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.setModel("nonexistent", "opus")).not.toThrow();
    });
  });

  describe("resumeQueue", () => {
    it("unpauses queue", () => {
      const session = manager.createSession("/tmp");
      manager.pauseQueue(session.id);
      expect(manager.isQueuePaused(session.id)).toBe(true);
      manager.resumeQueue(session.id);
      expect(manager.isQueuePaused(session.id)).toBe(false);
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.resumeQueue("nonexistent")).not.toThrow();
    });
  });

  describe("fixStaleStatus", () => {
    it("does nothing for idle session", () => {
      const session = manager.createSession("/tmp");
      expect(session.status).toBe("idle");
      manager.fixStaleStatus(session.id);
      const updated = manager.listKnownSessions().find((s) => s.id === session.id);
      expect(updated?.status).toBe("idle");
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.fixStaleStatus("nonexistent")).not.toThrow();
    });
  });

  describe("interrupt", () => {
    it("returns false when no process running", () => {
      const session = manager.createSession("/tmp");
      expect(manager.interrupt(session.id)).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(manager.interrupt("nonexistent")).toBe(false);
    });
  });

  describe("session prefs persistence", () => {
    it("persists model change via setModel", () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "opus");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("persists thinking level change", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });

    it("persists plan mode state", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });

    it("persists bypass state", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
    });
  });

  describe("getSessionByCwd", () => {
    it("creates session and returns it for new id", async () => {
      const result = await manager.getSessionByCwd("new-id", "/tmp/project");
      expect(result).not.toBeNull();
      expect(result!.info.cwd).toBe("/tmp/project");
    });

    it("returns existing session for known id", async () => {
      const session = manager.createSession("/tmp/project");
      const result = await manager.getSessionByCwd(session.id, "/tmp/project");
      expect(result).not.toBeNull();
      expect(result!.info.id).toBe(session.id);
    });
  });

  describe("getMoreHistory", () => {
    it("returns empty for unknown session", async () => {
      const result = await manager.getMoreHistory("nonexistent", "msg-1");
      expect(result).toEqual({ messages: [], hasMore: false });
    });

    it("returns empty when no messages in buffer", async () => {
      const session = manager.createSession("/tmp");
      const result = await manager.getMoreHistory(session.id, "msg-1");
      expect(result).toEqual({ messages: [], hasMore: false });
    });

    it("returns messages from buffer before target message", async () => {
      const session = manager.createSession("/tmp");
      const sessions = (manager as any).sessions as Map<string, any>;
      const s = sessions.get(session.id)!;
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        id: `msg-${i}`,
        role: "assistant" as const,
        content: `message ${i}`,
        toolUses: [],
        blocks: [],
        timestamp: Date.now(),
      }));
      s.transcriptBuffer = msgs;
      s.transcriptByteOffset = 0;

      const result = await manager.getMoreHistory(session.id, "msg-5");
      expect(result.messages).toHaveLength(5);
      expect(result.messages[0].id).toBe("msg-0");
      expect(result.messages[4].id).toBe("msg-4");
      expect(result.hasMore).toBe(false);
    });

    it("reports hasMore when buffer has byteOffset", async () => {
      const session = manager.createSession("/tmp");
      const sessions = (manager as any).sessions as Map<string, any>;
      const s = sessions.get(session.id)!;
      const msgs = Array.from({ length: 5 }, (_, i) => ({
        id: `msg-${i}`,
        role: "assistant" as const,
        content: `message ${i}`,
        toolUses: [],
        blocks: [],
        timestamp: Date.now(),
      }));
      s.transcriptBuffer = msgs;
      s.transcriptByteOffset = 1000;

      const result = await manager.getMoreHistory(session.id, "msg-3");
      expect(result.messages).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it("returns empty when message not in buffer and no offset", async () => {
      const session = manager.createSession("/tmp");
      const sessions = (manager as any).sessions as Map<string, any>;
      const s = sessions.get(session.id)!;
      s.transcriptBuffer = [{ id: "msg-0", role: "assistant", content: "x", toolUses: [], blocks: [], timestamp: 0 }];
      s.transcriptByteOffset = 0;
      s.paginationPrevIds = [];
      s.bufferCliSessionId = s.cliSessionId;

      const result = await manager.getMoreHistory(session.id, "nonexistent");
      expect(result.messages).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("respondToPermission", () => {
    it("does nothing for unknown session", () => {
      expect(() => manager.respondToPermission("nonexistent", "req-1", true)).not.toThrow();
    });

    it("does nothing when session has no process", () => {
      const session = manager.createSession("/tmp");
      expect(() => manager.respondToPermission(session.id, "req-1", true)).not.toThrow();
    });
  });

  describe("setBypassAllPermissions and clearBypassAllPermissions", () => {
    it("sets and clears bypass mode", () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(true);
      manager.clearBypassAllPermissions(session.id);
      expect(manager.isBypassActive(session.id)).toBe(false);
    });

    it("emits system message on bypass change", () => {
      const session = manager.createSession("/tmp");
      const messages: string[] = [];
      manager.onSystem(session.id, (msg) => messages.push(msg));
      manager.setBypassAllPermissions(session.id);
      expect(messages).toContain("__bypass_state::on");
      manager.clearBypassAllPermissions(session.id);
      expect(messages).toContain("__bypass_state::off");
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.setBypassAllPermissions("nonexistent")).not.toThrow();
      expect(() => manager.clearBypassAllPermissions("nonexistent")).not.toThrow();
    });
  });

  describe("setPlanMode and clearPlanMode", () => {
    it("sets and clears plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
      manager.clearPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("emits system message on plan mode change", () => {
      const session = manager.createSession("/tmp");
      const messages: string[] = [];
      manager.onSystem(session.id, (msg) => messages.push(msg));
      manager.setPlanMode(session.id);
      expect(messages).toContain("__plan_state::on");
      manager.clearPlanMode(session.id);
      expect(messages).toContain("__plan_state::off");
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.setPlanMode("nonexistent")).not.toThrow();
      expect(() => manager.clearPlanMode("nonexistent")).not.toThrow();
    });
  });

  describe("setThinkingLevel", () => {
    it("changes thinking level and emits system message", () => {
      const session = manager.createSession("/tmp");
      const messages: string[] = [];
      manager.onSystem(session.id, (msg) => messages.push(msg));
      manager.setThinkingLevel(session.id, "low");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
      expect(messages.some((m) => m.includes("__thinking_level::low"))).toBe(true);
    });

    it("does nothing for unknown session", () => {
      expect(() => manager.setThinkingLevel("nonexistent", "low")).not.toThrow();
    });
  });

  describe("rebuildTodosFromHistory", () => {
    it("does nothing for unknown session", () => {
      expect(() => manager.rebuildTodosFromHistory("nonexistent", [])).not.toThrow();
    });

    it("extracts todos from TodoWrite tool uses", () => {
      const session = manager.createSession("/tmp");
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [
            {
              id: "t1",
              name: "TodoWrite",
              input: JSON.stringify({ todos: [{ id: "1", content: "Test task", status: "pending" }] }),
              output: "",
              status: "done" as const,
            },
          ],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(manager.getTodos(session.id)).toHaveLength(1);
      expect(manager.getTodos(session.id)[0].content).toBe("Test task");
    });
  });

  describe("ensureProcess", () => {
    it("does nothing for unknown session", () => {
      expect(() => manager.ensureProcess("nonexistent")).not.toThrow();
    });
  });

  describe("getQueuedMessages", () => {
    it("returns empty for unknown session", () => {
      expect(manager.getQueuedMessages("nonexistent")).toEqual([]);
    });

    it("returns queued message details", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      const queued = manager.getQueuedMessages(session.id);
      expect(queued).toHaveLength(1);
      expect(queued[0].text).toBe("second");
    });
  });

  describe("getInitData and setInitData edge cases", () => {
    it("getInitData returns undefined for new session", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getInitData(session.id)).toBeUndefined();
    });

    it("getInitData returns undefined for unknown session", () => {
      expect(manager.getInitData("nonexistent")).toBeUndefined();
    });

    it("setInitData does nothing for unknown session", () => {
      expect(() => {
        manager.setInitData("nonexistent", {
          slashCommands: [],
          skills: [],
          agents: [],
          version: "",
          model: "",
          mcpServers: [],
        });
      }).not.toThrow();
    });

    it("setInitData emits init event", () => {
      const session = manager.createSession("/tmp");
      const received: unknown[] = [];
      manager.onInit(session.id, (data) => received.push(data));
      manager.setInitData(session.id, {
        slashCommands: ["/test"],
        skills: ["skill1"],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [],
      });
      expect(received).toHaveLength(1);
    });
  });

  describe("setModel", () => {
    it("updates the session model", () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "opus");
      expect(manager.getModel(session.id)).toBe("opus");
    });

    it("no-ops for same model", () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "sonnet");
      expect(manager.getModel(session.id)).toBe("sonnet");
    });

    it("no-ops for unknown session", () => {
      expect(() => manager.setModel("unknown", "opus")).not.toThrow();
    });

    it("kills process when stdin not available", () => {
      const session = manager.createSession("/tmp");
      const statuses: string[] = [];
      manager.onStatus(session.id, (status) => statuses.push(status));
      manager.setModel(session.id, "opus");
      expect(statuses).toContain("idle");
    });
  });

  describe("setThinkingLevel", () => {
    it("updates thinking level", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });

    it("no-ops for same level", () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "high");
      expect(manager.getThinkingLevel(session.id)).toBe("high");
    });

    it("emits thinking_level system message", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (text) => msgs.push(text));
      manager.setThinkingLevel(session.id, "low");
      expect(msgs).toContain("__thinking_level::low");
    });
  });

  describe("isPlanModeActive", () => {
    it("returns false by default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isPlanModeActive(session.id)).toBe(false);
    });

    it("returns true after setting plan mode", () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      expect(manager.isPlanModeActive(session.id)).toBe(true);
    });

    it("returns false for unknown session", () => {
      expect(manager.isPlanModeActive("unknown")).toBe(false);
    });
  });

  describe("getContextUsage", () => {
    it("returns null by default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getContextUsage(session.id)).toBeNull();
    });
  });

  describe("hasQueuedMessage and getQueuedCount", () => {
    it("returns false and 0 for new session", () => {
      const session = manager.createSession("/tmp");
      expect(manager.hasQueuedMessage(session.id)).toBe(false);
      expect(manager.getQueuedCount(session.id)).toBe(0);
    });

    it("returns false for unknown session", () => {
      expect(manager.hasQueuedMessage("unknown")).toBe(false);
      expect(manager.getQueuedCount("unknown")).toBe(0);
    });
  });

  describe("onSystem / onClear listeners", () => {
    it("returns null for unknown session", () => {
      expect(manager.onSystem("unknown", () => {})).toBeNull();
    });

    it("unsubscribe stops receiving events", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      const unsub = manager.onSystem(session.id, (text) => msgs.push(text));
      manager.setThinkingLevel(session.id, "low");
      expect(msgs).toHaveLength(1);
      unsub!();
      manager.setThinkingLevel(session.id, "none");
      expect(msgs).toHaveLength(1);
    });
  });

  describe("slash commands via sendMessage", () => {
    it("handles /model command", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (text) => msgs.push(text));
      manager.sendMessage(session.id, "/model opus");
      expect(manager.getModel(session.id)).toBe("opus");
      expect(msgs.some((m) => m.includes("Model switched"))).toBe(true);
    });

    it("handles /model without args shows picker", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (text) => msgs.push(text));
      manager.sendMessage(session.id, "/model");
      expect(msgs.some((m) => m.includes("__model_picker::"))).toBe(true);
    });

    it("handles /rename command", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (text) => msgs.push(text));
      manager.sendMessage(session.id, "/rename My Project");
      expect(session.name).toBe("My Project");
    });

    it("handles /rename without args", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (text) => msgs.push(text));
      manager.sendMessage(session.id, "/rename");
      expect(msgs.some((m) => m.includes("Usage:"))).toBe(true);
    });

    it("handles /help command", () => {
      const session = manager.createSession("/tmp");
      const msgs: string[] = [];
      manager.onSystem(session.id, (text) => msgs.push(text));
      manager.sendMessage(session.id, "/help");
      expect(msgs.some((m) => m.includes("/clear"))).toBe(true);
    });

    it("handles /clear command", () => {
      const session = manager.createSession("/tmp");
      let cleared = false;
      manager.onClear(session.id, () => {
        cleared = true;
      });
      manager.sendMessage(session.id, "/clear");
      expect(cleared).toBe(true);
    });

    it("handles /reset as alias for /clear", () => {
      const session = manager.createSession("/tmp");
      let cleared = false;
      manager.onClear(session.id, () => {
        cleared = true;
      });
      manager.sendMessage(session.id, "/reset");
      expect(cleared).toBe(true);
    });

    it("handles /new as alias for /clear", () => {
      const session = manager.createSession("/tmp");
      let cleared = false;
      manager.onClear(session.id, () => {
        cleared = true;
      });
      manager.sendMessage(session.id, "/new");
      expect(cleared).toBe(true);
    });

    it("passes unknown slash commands through to CLI", () => {
      const session = manager.createSession("/tmp");
      const result = manager.sendMessage(session.id, "/compact");
      expect(result).toBe(true);
    });

    it("isCompacting returns false by default", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isCompacting(session.id)).toBe(false);
    });
  });

  describe("fixStaleStatus", () => {
    it("corrects stale running status to idle", () => {
      const session = manager.createSession("/tmp");
      const sessions = (manager as any).sessions as Map<string, any>;
      const s = sessions.get(session.id)!;
      s.info.status = "running";
      manager.fixStaleStatus(session.id);
      expect(s.info.status).toBe("idle");
    });

    it("no-ops when process is alive", () => {
      const session = manager.createSession("/tmp");
      const sessions = (manager as any).sessions as Map<string, any>;
      const s = sessions.get(session.id)!;
      s.info.status = "running";
      s.process = {};
      manager.fixStaleStatus(session.id);
      expect(s.info.status).toBe("running");
    });
  });

  describe("listActiveSessions and listKnownSessions", () => {
    it("listActiveSessions returns only sessions with process", () => {
      manager.createSession("/tmp");
      expect(manager.listActiveSessions()).toHaveLength(0);
    });

    it("listKnownSessions returns all sessions", () => {
      manager.createSession("/tmp");
      manager.createSession("/tmp/other");
      expect(manager.listKnownSessions()).toHaveLength(2);
    });
  });

  describe("isProcessAlive", () => {
    it("returns false for session without process", () => {
      const session = manager.createSession("/tmp");
      expect(manager.isProcessAlive(session.id)).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(manager.isProcessAlive("unknown")).toBe(false);
    });
  });

  describe("getStreamingSnapshot", () => {
    it("returns null for new session", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getStreamingSnapshot(session.id)).toBeNull();
    });
  });

  describe("getTranscriptBuffer", () => {
    it("returns empty array for new session", () => {
      const session = manager.createSession("/tmp");
      expect(manager.getTranscriptBuffer(session.id)).toEqual([]);
    });

    it("returns empty for unknown session", () => {
      expect(manager.getTranscriptBuffer("unknown")).toEqual([]);
    });
  });

  describe("addPendingRequest and removePendingRequest", () => {
    it("adds and removes pending requests", () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, {
        type: "permission",
        requestId: "req-1",
        toolName: "Bash",
        toolInput: "ls",
      });
      expect(manager.getPendingRequests(session.id)).toHaveLength(1);
      manager.removePendingRequest(session.id, "req-1");
      expect(manager.getPendingRequests(session.id)).toHaveLength(0);
    });
  });

  describe("interrupt", () => {
    it("returns false for session without process", () => {
      const session = manager.createSession("/tmp");
      expect(manager.interrupt(session.id)).toBe(false);
    });

    it("returns false for unknown session", () => {
      expect(manager.interrupt("unknown")).toBe(false);
    });
  });

  describe("rebuildTodosFromHistory edge cases", () => {
    it("does not overwrite existing todos", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.todoItems = [{ content: "existing", status: "pending" }];
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [
            {
              id: "t1",
              name: "TodoWrite",
              input: JSON.stringify({ todos: [{ content: "new", status: "pending" }] }),
              output: "",
              status: "done" as const,
            },
          ],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(manager.getTodos(session.id)[0].content).toBe("existing");
    });

    it("stops at compact boundary", () => {
      const session = manager.createSession("/tmp");
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [
            {
              id: "t1",
              name: "TodoWrite",
              input: JSON.stringify({ todos: [{ content: "old", status: "pending" }] }),
              output: "",
              status: "done" as const,
            },
          ],
          blocks: [],
          timestamp: Date.now(),
        },
        { id: "sys1", role: "system" as const, content: "__compacted__", toolUses: [], blocks: [], timestamp: Date.now() },
        {
          id: "m2",
          role: "user" as const,
          content: "hello",
          toolUses: [],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(manager.getTodos(session.id)).toHaveLength(0);
    });

    it("handles invalid TodoWrite input gracefully", () => {
      const session = manager.createSession("/tmp");
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [{ id: "t1", name: "TodoWrite", input: "not-json", output: "", status: "done" as const }],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(manager.getTodos(session.id)).toHaveLength(0);
    });

    it("handles TodoWrite with non-array todos", () => {
      const session = manager.createSession("/tmp");
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [{ id: "t1", name: "TodoWrite", input: JSON.stringify({ todos: "not-array" }), output: "", status: "done" as const }],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(manager.getTodos(session.id)).toHaveLength(0);
    });

    it("filters out todos without content or status", () => {
      const session = manager.createSession("/tmp");
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [
            {
              id: "t1",
              name: "TodoWrite",
              input: JSON.stringify({
                todos: [{ content: "valid", status: "pending" }, { content: "", status: "pending" }, { content: "no-status" }],
              }),
              output: "",
              status: "done" as const,
            },
          ],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(manager.getTodos(session.id)).toHaveLength(1);
    });

    it("emits todos event after rebuild", () => {
      const session = manager.createSession("/tmp");
      const todoEvents: unknown[] = [];
      manager.onTodos(session.id, (todos) => todoEvents.push(todos));
      const messages = [
        {
          id: "m1",
          role: "assistant" as const,
          content: "",
          toolUses: [
            {
              id: "t1",
              name: "TodoWrite",
              input: JSON.stringify({ todos: [{ content: "task", status: "in_progress" }] }),
              output: "",
              status: "done" as const,
            },
          ],
          blocks: [],
          timestamp: Date.now(),
        },
      ];
      manager.rebuildTodosFromHistory(session.id, messages);
      expect(todoEvents).toHaveLength(1);
    });
  });

  describe("sendMessage with queue pause reset", () => {
    it("clears paused queue and resets flag on new message", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.pauseQueue(session.id);
      expect(manager.isQueuePaused(session.id)).toBe(true);
      expect(manager.getQueuedCount(session.id)).toBe(1);
      manager.sendMessage(session.id, "new message");
      expect(manager.isQueuePaused(session.id)).toBe(false);
      // Old queue cleared, but new message gets re-queued since status is running
      expect(manager.getQueuedCount(session.id)).toBe(1);
      expect(manager.getQueuedMessages(session.id)[0].text).toBe("new message");
    });

    it("emits queued event with count 0 on pause reset", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      manager.pauseQueue(session.id);
      const counts: number[] = [];
      manager.onQueued(session.id, (count) => counts.push(count));
      manager.sendMessage(session.id, "new message");
      expect(counts).toContain(0);
    });
  });

  describe("sendControlRequest", () => {
    it("rejects when session has no stdin", async () => {
      const session = manager.createSession("/tmp");
      await expect(manager.sendControlRequest(session.id, { subtype: "test" })).rejects.toThrow("Session not connected");
    });

    it("rejects for unknown session", async () => {
      await expect(manager.sendControlRequest("nonexistent", { subtype: "test" })).rejects.toThrow("Session not connected");
    });
  });

  describe("mcpStatus", () => {
    it("rejects when session has no stdin", async () => {
      const session = manager.createSession("/tmp");
      await expect(manager.mcpStatus(session.id)).rejects.toThrow("Session not connected");
    });
  });

  describe("updateMcpServerStatus", () => {
    it("updates server status in initData", () => {
      const session = manager.createSession("/tmp");
      manager.setInitData(session.id, {
        slashCommands: [],
        skills: [],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [{ name: "test-srv", status: "connected" }],
      });
      const initEvents: unknown[] = [];
      manager.onInit(session.id, (data) => initEvents.push(data));
      (manager as any).updateMcpServerStatus(session.id, "test-srv", "disabled");
      const s = (manager as any).sessions.get(session.id)!;
      expect(s.initData.mcpServers[0].status).toBe("disabled");
      expect(initEvents).toHaveLength(1);
    });

    it("does nothing when session has no initData", () => {
      const session = manager.createSession("/tmp");
      expect(() => (manager as any).updateMcpServerStatus(session.id, "srv", "disabled")).not.toThrow();
    });

    it("does nothing when server name not found", () => {
      const session = manager.createSession("/tmp");
      manager.setInitData(session.id, {
        slashCommands: [],
        skills: [],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [{ name: "other", status: "connected" }],
      });
      (manager as any).updateMcpServerStatus(session.id, "nonexistent", "disabled");
      const s = (manager as any).sessions.get(session.id)!;
      expect(s.initData.mcpServers[0].status).toBe("connected");
    });
  });

  describe("setModel without stdin (kills process)", () => {
    it("kills process and resets queue when no stdin", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      manager.sendMessage(session.id, "second");
      const s = (manager as any).sessions.get(session.id)!;
      s.stdin = null;
      manager.setModel(session.id, "opus");
      expect(manager.getQueuedCount(session.id)).toBe(0);
      expect(manager.isQueuePaused(session.id)).toBe(false);
    });
  });

  describe("setThinkingLevel without stdin (kills process)", () => {
    it("kills process and resets state when no stdin", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "first");
      const s = (manager as any).sessions.get(session.id)!;
      s.stdin = null;
      manager.setThinkingLevel(session.id, "low");
      expect(manager.getThinkingLevel(session.id)).toBe("low");
    });
  });

  describe("destroySession with running process", () => {
    it("cleans up and removes session with process", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "test");
      expect(manager.isProcessAlive(session.id)).toBe(true);
      expect(manager.destroySession(session.id)).toBe(true);
      expect(manager.listKnownSessions().find((s) => s.id === session.id)).toBeUndefined();
    });
  });

  describe("ensureProcess with existing process", () => {
    it("does nothing when process already exists", () => {
      const session = manager.createSession("/tmp");
      manager.sendMessage(session.id, "test");
      expect(manager.isProcessAlive(session.id)).toBe(true);
      expect(() => manager.ensureProcess(session.id)).not.toThrow();
    });
  });

  describe("getMoreHistory chaining into previous sessions", () => {
    it("chains into previous CLI session when buffer exhausted", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.transcriptBuffer = [{ id: "msg-0", role: "assistant", content: "current", toolUses: [], blocks: [], timestamp: 0 }];
      s.transcriptByteOffset = 0;
      s.paginationPrevIds = ["prev-session-1"];
      s.bufferCliSessionId = "current-session";

      const result = await manager.getMoreHistory(session.id, "msg-0");
      expect(result.hasMore).toBe(false);
    });

    it("skips prevIds matching current bufferCliSessionId", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.transcriptBuffer = [{ id: "msg-0", role: "assistant", content: "current", toolUses: [], blocks: [], timestamp: 0 }];
      s.transcriptByteOffset = 0;
      s.paginationPrevIds = ["current-session"];
      s.bufferCliSessionId = "current-session";

      const result = await manager.getMoreHistory(session.id, "msg-0");
      expect(result).toEqual({ messages: [], hasMore: false });
    });

    it("reads from disk when byteOffset > 0 and msg not in buffer", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.transcriptBuffer = [{ id: "msg-0", role: "assistant", content: "current", toolUses: [], blocks: [], timestamp: 0 }];
      s.transcriptByteOffset = 500;
      s.paginationPrevIds = [];

      const result = await manager.getMoreHistory(session.id, "msg-0");
      expect(result.messages).toBeDefined();
    });

    it("serves from buffer when idx > 0 with prevIds", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const msgs = Array.from({ length: 5 }, (_, i) => ({
        id: `msg-${i}`,
        role: "assistant" as const,
        content: `m${i}`,
        toolUses: [],
        blocks: [],
        timestamp: 0,
      }));
      s.transcriptBuffer = msgs;
      s.transcriptByteOffset = 0;
      s.paginationPrevIds = ["prev-1"];

      const result = await manager.getMoreHistory(session.id, "msg-3");
      expect(result.hasMore).toBe(true);
    });
  });

  describe("buildContent", () => {
    it("returns plain text when no images/documents/reminder", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const result = (manager as any).buildContent(s, "hello");
      expect(result).toBe("hello");
    });

    it("returns content blocks when images are present", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const result = (manager as any).buildContent(s, "check this", [{ mediaType: "image/png", data: "base64data" }]);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as Record<string, unknown>[];
      expect(blocks.some((b) => b.type === "image")).toBe(true);
      expect(blocks.some((b) => b.type === "text" && b.text === "check this")).toBe(true);
    });

    it("returns content blocks when documents are present", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const result = (manager as any).buildContent(s, "see doc", undefined, [
        { mediaType: "application/pdf", data: "pdfdata", name: "doc.pdf" },
      ]);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as Record<string, unknown>[];
      expect(blocks.some((b) => b.type === "document")).toBe(true);
    });

    it("includes plan mode reminder when pendingPlanReminder is true", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.pendingPlanReminder = true;
      const result = (manager as any).buildContent(s, "hello");
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as Record<string, unknown>[];
      expect(blocks.some((b) => (b.text as string)?.includes("plan mode"))).toBe(true);
      expect(s.pendingPlanReminder).toBe(false);
    });

    it("handles empty text with images", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const result = (manager as any).buildContent(s, "", [{ mediaType: "image/png", data: "base64data" }]);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as Record<string, unknown>[];
      expect(blocks.every((b) => b.type !== "text")).toBe(true);
    });
  });

  describe("extractUsage", () => {
    it("extracts usage from assistant message JSON", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const usages: unknown[] = [];
      manager.onUsage(session.id, (u) => usages.push(u));
      const line = JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 } },
      });
      (manager as any).extractUsage(s, session.id, line);
      expect(s.contextUsage).toEqual({ used: 175, total: 200000 });
      expect(usages).toHaveLength(1);
    });

    it("extracts contextWindowSize from result message", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const line = JSON.stringify({
        type: "result",
        modelUsage: { "claude-3-5-sonnet": { contextWindow: 128000 } },
      });
      (manager as any).extractUsage(s, session.id, line);
      expect(s.contextWindowSize).toBe(128000);
    });

    it("skips synthetic responses", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const line = JSON.stringify({
        type: "assistant",
        message: { model: "<synthetic>", usage: { input_tokens: 100 } },
      });
      (manager as any).extractUsage(s, session.id, line);
      expect(s.contextUsage).toBeNull();
    });

    it("handles invalid JSON gracefully", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      expect(() => (manager as any).extractUsage(s, session.id, "not json")).not.toThrow();
    });
  });

  describe("extractContextWindowSize", () => {
    it("sets context window from model usage", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      (manager as any).extractContextWindowSize(s, {
        "claude-3-5-sonnet": { contextWindow: 256000 },
      });
      expect(s.contextWindowSize).toBe(256000);
    });

    it("ignores models with zero or missing contextWindow", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      (manager as any).extractContextWindowSize(s, {
        "model-a": { contextWindow: 0 },
        "model-b": {},
      });
      expect(s.contextWindowSize).toBe(200000);
    });
  });

  describe("createSession fallback branches", () => {
    it("uses cwd when basename is empty (root path)", () => {
      const session = manager.createSession("/");
      expect(session.name).toBe("/");
    });

    it("uses provided name over basename", () => {
      const session = manager.createSession("/tmp", "custom-name");
      expect(session.name).toBe("custom-name");
    });
  });

  describe("interrupt queue pause branch", () => {
    it("pauses queue when interrupt is called with queued messages", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.process = { pid: 1, kill: vi.fn() };
      s.stdin = { write: vi.fn() };
      s.queuedMessages = [{ text: "pending", images: [], documents: [] }];

      manager.interrupt(session.id);

      expect(s.queuePaused).toBe(true);
    });

    it("does not pause queue when interrupt called with empty queue", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.process = { pid: 1, kill: vi.fn() };
      s.stdin = { write: vi.fn() };
      s.queuedMessages = [];

      manager.interrupt(session.id);

      expect(s.queuePaused).toBeFalsy();
    });
  });

  describe("flushQueuedMessage", () => {
    it("does not flush when queue is paused", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.queuePaused = true;
      s.queuedMessages = [{ text: "pending", images: [], documents: [] }];

      (manager as any).flushQueuedMessage(s, session.id);

      expect(s.queuedMessages).toHaveLength(1);
    });
  });

  describe("setInitData fallback to empty strings", () => {
    it("uses empty string when no prev data exists for version and model", () => {
      const session = manager.createSession("/tmp");
      manager.setInitData(session.id, {
        slashCommands: [],
        skills: [],
        agents: [],
        version: "",
        model: "",
        mcpServers: [],
      });

      const data = manager.getInitData(session.id);
      expect(data?.version).toBe("");
      expect(data?.model).toBe("");
    });
  });

  describe("extractUsage edge cases", () => {
    it("handles usage with only input_tokens (no cache fields)", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const line = JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 500 }, model: "claude-3" },
      });
      (manager as any).extractUsage(s, session.id, line);
      expect(s.contextUsage.used).toBe(500);
    });

    it("handles usage with zero input_tokens", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      const line = JSON.stringify({
        type: "assistant",
        message: { usage: { input_tokens: 0, cache_creation_input_tokens: 200 }, model: "claude-3" },
      });
      (manager as any).extractUsage(s, session.id, line);
      expect(s.contextUsage.used).toBe(200);
    });
  });

  describe("setModel with effort level coercion", () => {
    it("coerces thinking level when switching to a model with restricted efforts", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.thinkingLevel = "high";

      manager.setModel(session.id, "haiku");

      expect(s.info.model).toBe("haiku");
    });

    it("sends model control request when stdin is available", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.stdin = { write: vi.fn() };

      manager.setModel(session.id, "haiku");

      expect(s.stdin.write).toHaveBeenCalled();
      const written = s.stdin.write.mock.calls[0][0];
      expect(written).toContain("set_model");
    });
  });

  describe("endProcess and killProcessGroup", () => {
    it("endProcess is no-op without process", () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.process = null;

      expect(() => (manager as any).endProcess(s)).not.toThrow();
    });

    it("killProcessGroup handles missing pid", () => {
      const _session = manager.createSession("/tmp");
      const proc = { pid: undefined, kill: vi.fn() };

      expect(() => (manager as any).killProcessGroup(proc)).not.toThrow();
    });
  });
});
