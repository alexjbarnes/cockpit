// A page that connects mid-turn must be told how long the turn has run. It has
// no bubble of its own to time from, and on a long turn the user's message is
// outside what it is sent: reading the start from the messages restarted the
// turn counter from now every time a session was left and reopened.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const emitter = new EventEmitter();
    const stdin = new (require("node:stream").PassThrough)();
    return Object.assign(emitter, { pid: 99999, stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  }),
}));

vi.mock("@/server/plans", () => ({ findLatestPlanFile: () => null, readPlanFile: () => null }));

import { createSession as createAuthSession, setupPassword } from "@/server/auth";
import { SessionManager } from "@/server/session-manager";
import { TerminalManager } from "@/server/terminal-manager";
import { createWebSocketHandler } from "@/server/ws-handler";

beforeAll(async () => {
  await setupPassword("test-password");
});

describe("turn timing on connect", () => {
  let server: Server;
  let manager: SessionManager;
  let port: number;
  let validToken: string;
  let sandbox: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        sandbox = mkdtempSync(join(tmpdir(), "turn-timing-"));
        manager = new SessionManager({ defaultRuntime: "stream" });
        server = createServer();
        createWebSocketHandler(server, manager, new TerminalManager());
        validToken = createAuthSession();
        server.listen(0, () => {
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterEach(() => {
    server.close();
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function historyOnConnect(sessionId: string): Promise<Record<string, unknown>> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${port}/ws?token=${validToken}`);
      socket.on("open", () => resolve(socket));
      socket.on("error", reject);
    });
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ type: "session:connect", sessionId, cwd: sandbox }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === "history")).toBe(true), { timeout: 5000, interval: 20 });
    ws.close();
    return messages.find((m) => m.type === "history")!;
  }

  it("tells a page connecting mid-turn how long the turn has run", async () => {
    const session = manager.createSession(sandbox);
    manager.sendMessage(session.id, "a long task");
    // Stand in for a turn that has been running for ten minutes.
    (manager as unknown as { sessions: Map<string, { turnStartedAt?: number }> }).sessions.get(session.id)!.turnStartedAt =
      Date.now() - 600_000;

    const history = await historyOnConnect(session.id);

    expect(history.status).toBe("running");
    expect(history.turnElapsedMs).toBeGreaterThanOrEqual(600_000);
    expect(history.turnElapsedMs).toBeLessThan(605_000);
  });

  it("says nothing about turn timing when no turn is running", async () => {
    const session = manager.createSession(sandbox);

    const history = await historyOnConnect(session.id);

    expect(history.status).toBe("idle");
    expect(history).not.toHaveProperty("turnElapsedMs");
  });
});
