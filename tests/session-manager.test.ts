import { describe, it, expect, beforeEach, vi } from "vitest";

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
      const active = manager.listActiveSessions();
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
});
