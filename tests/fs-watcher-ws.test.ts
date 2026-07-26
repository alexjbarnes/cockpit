import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { armWatcher } from "./support/fs-watch";

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
        manager = new SessionManager({ defaultRuntime: "stream" });
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

  // fs-watcher debounces at 500ms, so nothing can arrive sooner than that and
  // a loaded machine pushes it out further. Waiting a flat interval and then
  // asserting made these tests fail on slowness rather than on behaviour.
  const SETTLE_MS = 1500;

  function fsChangedIn(bag: { messages: Record<string, unknown>[] }) {
    return bag.messages.filter((m) => m.type === "session:fs_changed");
  }

  /** Barrier: the server handles socket messages in order, so a pong proves
   *  everything sent before the ping has already been processed — including
   *  the watcher registration, which happens synchronously in that handler.
   *  Replaces sleeping and hoping the subscribe landed. */
  async function syncWithServer(ws: WebSocket, bag: { messages: Record<string, unknown>[] }) {
    const seen = bag.messages.length;
    ws.send(JSON.stringify({ type: "ping" }));
    await vi.waitFor(
      () => {
        expect(bag.messages.slice(seen).some((m) => m.type === "pong")).toBe(true);
      },
      { timeout: 5000, interval: 20 },
    );
  }

  /** Touch until the watcher reports, proving the recursive watch is live —
   *  see tests/support/fs-watch.ts for why a single write is not enough. */
  async function armFor(bag: { messages: Record<string, unknown>[] }, file: string) {
    await armWatcher(
      () => writeFileSync(join(sandbox, file), `x ${Date.now()}`),
      () => fsChangedIn(bag).length > 0,
    );
  }

  /** Wait for the watcher to report, however long the machine takes. */
  async function waitForFsChanged(bag: { messages: Record<string, unknown>[] }) {
    await vi.waitFor(
      () => {
        expect(fsChangedIn(bag).length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 15000, interval: 25 },
    );
  }

  it("sends session:fs_changed when a file changes in a connected session cwd", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await syncWithServer(ws, bag);

    bag.messages = [];
    await armFor(bag, "trigger.txt");

    expect(fsChangedIn(bag)[0].cwd).toBe(sandbox);

    ws.close();
  });

  it("sends session:fs_changed via session:subscribe for sidebar watchers", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:subscribe", sessionIds: [session.id] }));
    await syncWithServer(ws, bag);

    bag.messages = [];
    await armFor(bag, "sidebar-trigger.txt");

    expect(fsChangedIn(bag)[0].cwd).toBe(sandbox);

    ws.close();
  });

  it("stops sending events after WS disconnect", async () => {
    const session = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    await syncWithServer(ws, bag);

    // Prove the watcher was live before the close, so a later silence means
    // the disconnect stopped it rather than it never having started.
    bag.messages = [];
    await armFor(bag, "before-close.txt");

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });

    bag.messages = [];
    writeFileSync(join(sandbox, "after-close.txt"), "no one listening");
    await wait(SETTLE_MS);

    expect(fsChangedIn(bag)).toEqual([]);
  });

  it("drops the previous cwd watcher when the client switches session", async () => {
    const first = mkdtempSync(join(tmpdir(), "fsw-ws-first-"));
    try {
      const ws = await connectWs();
      const bag = collectMessages(ws);

      ws.send(JSON.stringify({ type: "watch:cwd", cwd: first }));
      await syncWithServer(ws, bag);
      await armWatcher(
        () => writeFileSync(join(first, "a.txt"), `x ${Date.now()}`),
        () => fsChangedIn(bag).length > 0,
      );

      // Switching session points the socket at a different directory.
      ws.send(JSON.stringify({ type: "watch:cwd", cwd: sandbox }));
      await syncWithServer(ws, bag);
      await armFor(bag, "b.txt");

      // The old directory must no longer report: a socket that has visited
      // several sessions should not keep firing for all of them.
      bag.messages = [];
      writeFileSync(join(first, "after-switch.txt"), "stale");
      await wait(SETTLE_MS);

      expect(fsChangedIn(bag)).toEqual([]);
      ws.close();
    } finally {
      rmSync(first, { recursive: true, force: true });
    }
  });

  it("deduplicates watchers for sessions sharing the same cwd", async () => {
    const s1 = manager.createSession(sandbox);
    const s2 = manager.createSession(sandbox);
    const ws = await connectWs();
    const bag = collectMessages(ws);

    ws.send(JSON.stringify({ type: "session:subscribe", sessionIds: [s1.id, s2.id] }));
    await syncWithServer(ws, bag);

    bag.messages = [];
    await armFor(bag, "arm.txt");

    // Now the watch is proven live, a single write decides the question. Wait
    // past the debounce so a second watcher on the same cwd — the duplicate
    // this guards against — has every chance to report before the count.
    bag.messages = [];
    writeFileSync(join(sandbox, "dedup.txt"), "once");
    await waitForFsChanged(bag);
    await wait(SETTLE_MS);

    expect(fsChangedIn(bag).length).toBe(1);

    ws.close();
  });
});
