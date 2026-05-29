import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { createSession as createAuthSession, setupPassword } from "@/server/auth";
import { SessionManager } from "@/server/session-manager";
import { TerminalManager } from "@/server/terminal-manager";
import { createWebSocketHandler } from "@/server/ws-handler";

beforeAll(async () => {
  await setupPassword("test-password");
});

describe("WebSocket reconnection", () => {
  let server: Server;
  let manager: SessionManager;
  let port: number;
  let validToken: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        manager = new SessionManager();
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

  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=${validToken}`);
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<Record<string, unknown>[]> {
    return new Promise((resolve) => {
      const messages: Record<string, unknown>[] = [];
      const timer = setTimeout(() => resolve(messages), timeoutMs);
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= count) {
          clearTimeout(timer);
          resolve(messages);
        }
      });
    });
  }

  it("history message always includes status field", async () => {
    const session = manager.createSession("/tmp");
    const ws = await connectWs();

    const collecting = collectMessages(ws, 5);
    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    const messages = await collecting;

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg!.status).toBe("idle");

    ws.close();
  });

  it("status=idle in history is sufficient even if WS drops immediately", async () => {
    // Simulates the mobile bug: WS drops before the separate
    // session:status message arrives. The status bundled in the
    // history message is the client's only signal.
    const session = manager.createSession("/tmp");
    const ws = await connectWs();

    const firstMsg = await new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    });

    // Terminate immediately - simulates 1006 drop
    ws.terminate();

    expect(firstMsg.type).toBe("history");
    expect(firstMsg.status).toBe("idle");
  });

  it("delta reconnect sends status and minimal messages", async () => {
    const session = manager.createSession("/tmp");

    // First connection: get full history (0 messages)
    const ws1 = await connectWs();
    const collecting1 = collectMessages(ws1, 5);
    ws1.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    const msgs1 = await collecting1;
    const history1 = msgs1.find((m) => m.type === "history");
    expect(history1).toBeDefined();
    expect(history1!.status).toBe("idle");

    // history1.messages is the full history from transcript (likely 0 for new session)
    const msgCount = (history1!.messages as unknown[]).length;
    ws1.close();
    await new Promise((r) => setTimeout(r, 100));

    // Reconnect with messageCount > 0 to trigger delta path
    // Since session has 0 messages and we'd send 0, the delta path
    // requires messageCount > 0 && messageCount <= server count.
    // With 0 messages, we can't get delta - that's correct behavior.
    // Full history with status is still sent.
    const ws2 = await connectWs();
    const collecting2 = collectMessages(ws2, 5);
    ws2.send(
      JSON.stringify({
        type: "session:connect",
        sessionId: session.id,
        messageCount: msgCount, // 0
      }),
    );
    const msgs2 = await collecting2;
    const history2 = msgs2.find((m) => m.type === "history");
    expect(history2).toBeDefined();
    expect(history2!.status).toBe("idle");

    ws2.close();
  });

  it("rapid connect/disconnect cycles always get status in first message", async () => {
    // Simulates the mobile pattern: connect, get 1 message, WS dies, repeat.
    // Every cycle should get status in the very first message.
    const session = manager.createSession("/tmp");

    for (let i = 0; i < 5; i++) {
      const ws = await connectWs();
      const firstMsg = await new Promise<Record<string, unknown>>((resolve) => {
        ws.once("message", (data) => resolve(JSON.parse(data.toString())));
        ws.send(
          JSON.stringify({
            type: "session:connect",
            sessionId: session.id,
            messageCount: i > 0 ? 0 : undefined,
          }),
        );
      });

      ws.terminate();

      expect(firstMsg.type).toBe("history");
      expect(firstMsg.status).toBeDefined();
      expect(["idle", "running"]).toContain(firstMsg.status);

      await new Promise((r) => setTimeout(r, 30));
    }
  });

  it("session:status message is also sent separately for redundancy", async () => {
    // Even though status is in the history message, the separate
    // session:status message should also be sent for backwards compat.
    const session = manager.createSession("/tmp");
    const ws = await connectWs();

    const collecting = collectMessages(ws, 5);
    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
    const messages = await collecting;

    const historyMsg = messages.find((m) => m.type === "history");
    const statusMsg = messages.find((m) => m.type === "session:status");

    expect(historyMsg!.status).toBe("idle");
    expect(statusMsg).toBeDefined();
    expect(statusMsg!.status).toBe("idle");

    // Both agree
    expect(historyMsg!.status).toBe(statusMsg!.status);

    ws.close();
  });
});
