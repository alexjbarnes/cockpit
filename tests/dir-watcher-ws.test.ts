import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("watch:dirs WebSocket integration", () => {
  let server: Server;
  let manager: SessionManager;
  let terminalMgr: TerminalManager;
  let port: number;
  let validToken: string;
  let sandbox: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        sandbox = mkdtempSync(join(tmpdir(), "dirw-ws-test-"));
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

  const SETTLE_MS = 1500;

  function fsChangedIn(bag: { messages: Record<string, unknown>[] }) {
    return bag.messages.filter((m) => m.type === "session:fs_changed");
  }

  /** Barrier: the server handles socket messages in order, so a pong proves
   *  everything sent before the ping has already been processed, including
   *  the watch registration. */
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

  /** Touch until the watch reports, proving it is live. */
  async function armIn(bag: { messages: Record<string, unknown>[] }, dir: string, file: string) {
    await armWatcher(
      () => writeFileSync(join(dir, file), `x ${Date.now()}`),
      () => fsChangedIn(bag).length > 0,
    );
  }

  async function watch(ws: WebSocket, bag: { messages: Record<string, unknown>[] }, dirs: string[]) {
    ws.send(JSON.stringify({ type: "watch:dirs", cwd: sandbox, dirs }));
    await syncWithServer(ws, bag);
  }

  it("sends session:fs_changed for a change in the session folder", async () => {
    const ws = await connectWs();
    const bag = collectMessages(ws);
    await watch(ws, bag, [""]);

    bag.messages = [];
    await armIn(bag, sandbox, "trigger.txt");

    expect(fsChangedIn(bag)[0].cwd).toBe(sandbox);
    ws.close();
  });

  it("sends for an expanded folder", async () => {
    const sub = join(sandbox, "src");
    mkdirSync(sub);
    const ws = await connectWs();
    const bag = collectMessages(ws);
    await watch(ws, bag, ["", "src"]);

    bag.messages = [];
    await armIn(bag, sub, "app.ts");

    expect(fsChangedIn(bag)[0].cwd).toBe(sandbox);
    ws.close();
  });

  it("does not send for a folder that is not watched", async () => {
    const sub = join(sandbox, "src");
    mkdirSync(sub);
    const ws = await connectWs();
    const bag = collectMessages(ws);
    await watch(ws, bag, [""]);

    // Positive control: the root watch is live.
    bag.messages = [];
    await armIn(bag, sandbox, "arm.txt");
    expect(fsChangedIn(bag).length).toBeGreaterThan(0);

    bag.messages = [];
    writeFileSync(join(sub, "app.ts"), "unwatched");
    await wait(SETTLE_MS);

    expect(fsChangedIn(bag)).toEqual([]);
    ws.close();
  });

  it("replaces the watched set when the page expands or collapses folders", async () => {
    const first = join(sandbox, "first");
    const second = join(sandbox, "second");
    mkdirSync(first);
    mkdirSync(second);

    const ws = await connectWs();
    const bag = collectMessages(ws);
    await watch(ws, bag, ["first"]);
    bag.messages = [];
    await armIn(bag, first, "a.txt");

    await watch(ws, bag, ["second"]);
    bag.messages = [];
    await armIn(bag, second, "b.txt");

    // The first folder must no longer report.
    bag.messages = [];
    writeFileSync(join(first, "after-switch.txt"), "stale");
    await wait(SETTLE_MS);

    expect(fsChangedIn(bag)).toEqual([]);
    ws.close();
  });

  it("clears every watch when the list is empty", async () => {
    const ws = await connectWs();
    const bag = collectMessages(ws);
    await watch(ws, bag, [""]);
    bag.messages = [];
    await armIn(bag, sandbox, "before-clear.txt");

    await watch(ws, bag, []);
    bag.messages = [];
    writeFileSync(join(sandbox, "after-clear.txt"), "no one listening");
    await wait(SETTLE_MS);

    expect(fsChangedIn(bag)).toEqual([]);
    ws.close();
  });

  it("ignores folders outside the session directory", async () => {
    const outside = mkdtempSync(join(tmpdir(), "dirw-ws-outside-"));
    try {
      const ws = await connectWs();
      const bag = collectMessages(ws);
      await watch(ws, bag, ["", outside]);

      bag.messages = [];
      await armIn(bag, sandbox, "inside.txt");
      expect(fsChangedIn(bag).length).toBeGreaterThan(0);

      bag.messages = [];
      writeFileSync(join(outside, "secret.txt"), "outside");
      await wait(SETTLE_MS);

      expect(fsChangedIn(bag)).toEqual([]);
      ws.close();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops sending events after WS disconnect", async () => {
    const ws = await connectWs();
    const bag = collectMessages(ws);
    await watch(ws, bag, [""]);
    bag.messages = [];
    await armIn(bag, sandbox, "before-close.txt");

    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });

    bag.messages = [];
    writeFileSync(join(sandbox, "after-close.txt"), "no one listening");
    await wait(SETTLE_MS);

    expect(fsChangedIn(bag)).toEqual([]);
  });
});
