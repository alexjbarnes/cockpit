import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

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

vi.mock("@/server/plans", () => ({
  findLatestPlanFile: () => null,
  readPlanFile: () => null,
}));

import { createSession as createAuthSession, setupPassword } from "@/server/auth";
import { SessionManager } from "@/server/session-manager";
import { TerminalManager } from "@/server/terminal-manager";
import { createWebSocketHandler } from "@/server/ws-handler";

beforeAll(async () => {
  await setupPassword("test-password");
});

describe("fs-watcher WebSocket integration", () => {
  let server: Server;
  let manager: SessionManager;
  let terminalMgr: TerminalManager;
  let port: number;
  let validToken: string;
  let sandbox: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        sandbox = mkdtempSync(join(tmpdir(), "fsw-ws-test-"));
        manager = new SessionManager();
        terminalMgr = new TerminalManager();
        server = createServer();
        createWebSocketHandler(server, manager, terminalMgr);
        validToken = createAuthSession();
        server.listen(0, () => {
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(sandbox, { recursive: true, force: true });
  });

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${validToken}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function collectMessages(ws: WebSocket): { messages: Record<string, unknown>[] } {
    const bag = { messages: [] as Record<string, unknown>[] };
    ws.on("message", (data) => {
      bag.messages.push(JSON.parse(data.toString()));
    });
    return bag;
  }

  function wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  it("sends session:fs_changed when a file changes in a connected session cwd", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await wait(500);

    bag.messages = [];
    writeFileSync(join(sandbox, "trigger.txt"), "change");
    await wait(1000);

    const fsChanged = bag.messages.filter((m) => m.type === "session:fs_changed");
    expect(fsChanged.length).toBeGreaterThanOrEqual(1);
    expect(fsChanged[0].cwd).toBe(sandbox);

    ws.close();
  });

  it("sends session:fs_changed via session:subscribe for sidebar watchers", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:subscribe", sessionIds: [session.id] }));
    await wait(500);

    bag.messages = [];
    writeFileSync(join(sandbox, "sidebar-trigger.txt"), "change");
    await wait(1000);

    const fsChanged = bag.messages.filter((m) => m.type === "session:fs_changed");
    expect(fsChanged.length).toBeGreaterThanOrEqual(1);
    expect(fsChanged[0].cwd).toBe(sandbox);

    ws.close();
  });

  it("stops sending events after WS disconnect", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await wait(500);

    ws.close();
    await wait(300);

    writeFileSync(join(sandbox, "after-close.txt"), "no one listening");
    await wait(1000);

    const fsChanged = bag.messages.filter((m) => m.type === "session:fs_changed");
    expect(fsChanged.length).toBe(0);
  });

  it("deduplicates watchers for sessions sharing the same cwd", async () => {
    const s1 = manager.createSession(sandbox);
    const s2 = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:subscribe", sessionIds: [s1.id, s2.id] }));
    await wait(500);

    bag.messages = [];
    writeFileSync(join(sandbox, "dedup.txt"), "once");
    await wait(1000);

    const fsChanged = bag.messages.filter((m) => m.type === "session:fs_changed");
    expect(fsChanged.length).toBe(1);

    ws.close();
  });
});
