// A client that connects mid-flight must be told what background work is
// running. The transcript records an async agent's tool use as done the moment
// it launches, so a reloaded page had nothing to go on: it judged a running
// agent finished until the next Stop or subagent hook happened to arrive with a
// real list. That was the agent card's spinner disappearing on refresh and
// coming back ~10 seconds later.
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
import type { BackgroundTask } from "@/types";

beforeAll(async () => {
  await setupPassword("test-password");
});

describe("background tasks on connect", () => {
  let server: Server;
  let manager: SessionManager;
  let port: number;
  let validToken: string;
  let sandbox: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        sandbox = mkdtempSync(join(tmpdir(), "task-replay-"));
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

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${validToken}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function collect(ws: WebSocket): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    return messages;
  }

  const running: BackgroundTask = {
    taskId: "a1",
    toolUseId: "a1",
    status: "running",
    title: "general-purpose",
    description: "investigating",
  };

  function recordTasks(sessionId: string, tasks: BackgroundTask[]): void {
    const s = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId);
    (manager as unknown as { rememberBackgroundTasks(session: unknown, event: unknown): void }).rememberBackgroundTasks(s, {
      type: "task_sync",
      tasks,
    });
  }

  async function syncsIn(messages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    await vi.waitFor(
      () => {
        expect(messages.some((m) => m.type === "history")).toBe(true);
      },
      { timeout: 5000, interval: 20 },
    );
    return messages.filter((m) => m.type === "session:task_sync");
  }

  it("hands a connecting client the running task list", async () => {
    const session = manager.createSession(sandbox);
    recordTasks(session.id, [running]);

    const ws = await connectWs();
    const messages = collect(ws);
    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id, cwd: sandbox }));

    const syncs = await syncsIn(messages);
    expect(syncs, "without this the page waits for the next Stop hook").toHaveLength(1);
    expect(syncs[0].tasks).toEqual([running]);
    ws.close();
  });

  it("says nothing when no background work is running", async () => {
    const session = manager.createSession(sandbox);

    const ws = await connectWs();
    const messages = collect(ws);
    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id, cwd: sandbox }));

    expect(await syncsIn(messages)).toHaveLength(0);
    ws.close();
  });

  it("replays the list to a second client without disturbing the first", async () => {
    const session = manager.createSession(sandbox);
    recordTasks(session.id, [running]);

    const first = await connectWs();
    const firstMessages = collect(first);
    first.send(JSON.stringify({ type: "session:connect", sessionId: session.id, cwd: sandbox }));
    expect(await syncsIn(firstMessages)).toHaveLength(1);

    const second = await connectWs();
    const secondMessages = collect(second);
    second.send(JSON.stringify({ type: "session:connect", sessionId: session.id, cwd: sandbox }));
    expect(await syncsIn(secondMessages), "a reload is just another connect").toHaveLength(1);

    first.close();
    second.close();
  });
});
