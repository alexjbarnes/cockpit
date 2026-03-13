import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createWebSocketHandler } from "@/server/ws-handler";
import { SessionManager } from "@/server/session-manager";

beforeAll(() => {
  process.env.APERTURE_TOKEN = "ws-test-token";
});

describe("WebSocket handler", () => {
  let server: Server;
  let manager: SessionManager;
  let port: number;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        manager = new SessionManager();
        server = createServer();
        createWebSocketHandler(server, manager);
        server.listen(0, () => {
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      })
  );

  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:${port}/ws?token=ws-test-token`
      );
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  function readMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once("message", (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  it("rejects connection without token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {});
    });
    // Connection should be closed/rejected
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it("rejects connection with bad token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=wrong`);
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.on("error", () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it("accepts connection with valid token", async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("responds to ping with pong", async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ type: "ping" }));
    const msg = await readMessage(ws);
    expect(msg.type).toBe("pong");
    ws.close();
  });

  it("sends error for unknown session on connect", async () => {
    const ws = await connectWs();
    ws.send(
      JSON.stringify({ type: "session:connect", sessionId: "nonexistent" })
    );
    const msg = await readMessage(ws);
    expect(msg.type).toBe("session:error");
    expect(msg.error).toContain("not found");
    ws.close();
  });

  it("sends history and connected on session:connect", async () => {
    const session = manager.createSession("/tmp");
    const ws = await connectWs();

    const messages: Record<string, unknown>[] = [];
    const collected = new Promise<void>((resolve) => {
      ws.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= 3) resolve();
      });
    });

    ws.send(
      JSON.stringify({ type: "session:connect", sessionId: session.id })
    );

    await collected;

    const types = messages.map((m) => m.type);
    expect(types).toContain("history");
    expect(types).toContain("session:connected");
    expect(types).toContain("session:status");

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg!.sessionId).toBe(session.id);
    expect(Array.isArray(historyMsg!.messages)).toBe(true);

    const statusMsg = messages.find((m) => m.type === "session:status");
    expect(statusMsg!.status).toBe("idle");

    ws.close();
  });
});
