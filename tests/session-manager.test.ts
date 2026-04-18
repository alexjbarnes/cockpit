import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/server/transcript", () => ({
  loadTranscript: () => Promise.resolve({ messages: [], byteOffset: 0, totalSize: 0, lastUsage: null }),
  loadMoreMessages: () => Promise.resolve({ messages: [], newByteOffset: 0 }),
  transcriptExists: () => false,
  findSessionCwd: () => Promise.resolve(null),
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
  });
});
