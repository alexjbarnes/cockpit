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

describe("fs_changed cwd value", () => {
  let server: Server;
  let manager: SessionManager;
  let terminalMgr: TerminalManager;
  let port: number;
  let validToken: string;
  let sandbox: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        sandbox = mkdtempSync(join(tmpdir(), "fsw-cwd-test-"));
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

  it("event cwd exactly matches the cwd passed to createSession", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await wait(500);

    bag.messages = [];
    writeFileSync(join(sandbox, "test.txt"), "data");
    await wait(1000);

    const fsChanged = bag.messages.find((m) => m.type === "session:fs_changed");
    expect(fsChanged).toBeDefined();
    expect(fsChanged!.cwd).toBe(sandbox);
    expect(fsChanged!.cwd).toBe(session.cwd);

    ws.close();
  });

  it("client filtering by cwd would miss events if paths differ by trailing slash", async () => {
    const cwdWithSlash = sandbox + "/";
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await wait(500);

    bag.messages = [];
    writeFileSync(join(sandbox, "test.txt"), "data");
    await wait(1000);

    const fsChanged = bag.messages.find((m) => m.type === "session:fs_changed");
    expect(fsChanged).toBeDefined();

    // This demonstrates the bug: strict equality fails when URL has trailing slash
    expect(fsChanged!.cwd).not.toBe(cwdWithSlash);
    // But the event DID fire -- a handler without cwd filtering would receive it
    expect(fsChanged!.cwd).toBe(sandbox);

    ws.close();
  });

  it("getSessionByCwd may store a different cwd than the URL param", async () => {
    // Session created with one cwd, but getSession called with a cwd from URL
    const urlCwd = sandbox;
    const session = manager.createSession(sandbox);

    // getSessionCwd returns the stored cwd
    expect(manager.getSessionCwd(session.id)).toBe(sandbox);

    // If the URL param came through encodeURIComponent/decodeURIComponent it's identical
    // But if it came from a different source (e.g. the session list API), it could differ
    expect(manager.getSessionCwd(session.id)).toBe(urlCwd);

    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await wait(500);

    bag.messages = [];
    writeFileSync(join(sandbox, "file.txt"), "content");
    await wait(1000);

    // The event fires regardless of what cwd the client thinks it has
    const fsChanged = bag.messages.filter((m) => m.type === "session:fs_changed");
    expect(fsChanged.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});
