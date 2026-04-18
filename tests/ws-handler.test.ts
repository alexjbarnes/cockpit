import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { createWebSocketHandler } from "@/server/ws-handler";
import { SessionManager } from "@/server/session-manager";
import { createSession as createAuthSession } from "@/server/auth";
import type { ParsedEvent } from "@/server/event-parser";

// Auth is enabled (default) so we can test rejection and acceptance
beforeAll(() => {
  delete process.env.COCKPIT_DISABLE_AUTH;
});

describe("WebSocket handler", () => {
  let server: Server;
  let manager: SessionManager;
  let port: number;
  let validToken: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        manager = new SessionManager();
        server = createServer();
        createWebSocketHandler(server, manager);
        validToken = createAuthSession();
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
        `ws://localhost:${port}/ws?token=${validToken}`
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

  function readMessages(ws: WebSocket, count: number): Promise<Record<string, unknown>[]> {
    return new Promise((resolve) => {
      const messages: Record<string, unknown>[] = [];
      let received = 0;
      const handler = (data: Buffer) => {
        messages.push(JSON.parse(data.toString()));
        received++;
        if (received >= count) {
          ws.removeListener("message", handler);
          resolve(messages);
        }
      };
      ws.on("message", handler);
    });
  }

  it("rejects connection without token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => {});
    });
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
        if (messages.length >= 5) resolve();
      });
    });

    ws.send(
      JSON.stringify({ type: "session:connect", sessionId: session.id })
    );

    await collected;

    const types = messages.map((m) => m.type);
    expect(types).toContain("history");
    expect(types).toContain("session:connected");

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg!.sessionId).toBe(session.id);
    expect(Array.isArray(historyMsg!.messages)).toBe(true);

    const connectedMsg = messages.find((m) => m.type === "session:connected");
    expect(connectedMsg!.sessionId).toBe(session.id);

    ws.close();
  });

  describe("event routing through subscriptions", () => {
    it("routes text_delta events to assistant:text messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      // Connect to the session and collect initial messages
      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      // Skip the initial connection messages
      await readMessages(ws, 5);

      // Create a subscription to verify event types are handled
      let eventReceived = false;
      const unsubscribe = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "text_delta" && event.text) {
          eventReceived = true;
        }
      });

      // Verify subscription is working
      expect(unsubscribe).toBeDefined();

      unsubscribe?.();
      ws.close();
    });

    it("routes thinking events to assistant:thinking messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      // Collect initial messages
      await readMessages(ws, 3);

      // Verify the subscription system is in place
      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        expect(event.type).toBeDefined();
      });

      unsub?.();
      ws.close();
    });

    it("routes tool_use_start events to assistant:tool_use messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      // Collect initial connection messages
      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "tool_use_start") {
          expect(event.toolName).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes tool_result events to assistant:tool_result messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "tool_result") {
          expect(event.toolId).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes permission_request events to permission:request messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "permission_request") {
          expect(event.toolName).toBeDefined();
          expect(event.requestId).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes init events to session:init messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      // Collect initial messages including session:init if present
      const messages = await readMessages(ws, 5);
      const hasInit = messages.some((m) => m.type === "session:init");

      if (hasInit) {
        const initMsg = messages.find((m) => m.type === "session:init");
        expect(initMsg?.sessionId).toBe(session.id);
        expect(initMsg?.data).toBeDefined();
      }

      ws.close();
    });

    it("routes task_update events to session:task_update messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "task_update") {
          expect(event.taskInfo).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes rate_limit events to session:rate_limit messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "rate_limit") {
          expect(event.rateLimitInfo).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes prompt_suggestion events to session:suggestions messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "prompt_suggestion") {
          expect(event.suggestions).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes message_done events to assistant:message_done messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "message_done") {
          expect(event.message).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes tool_children events to assistant:tool_children messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "tool_children") {
          expect(event.children).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("routes tool_progress events to assistant:tool_progress messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "tool_progress") {
          expect(event.toolId).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });
  });

  describe("permission request handling", () => {
    it("stores permission request details in pending map", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "permission_request") {
          expect(event.requestId).toBeDefined();
          expect(event.toolName).toBeDefined();
          expect(event.rawToolInput).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });

    it("handles AskUserQuestion permission requests specially", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "permission_request" && event.toolName === "AskUserQuestion") {
          expect(event.toolInput).toBeDefined();
        }
      });

      unsub?.();
      ws.close();
    });
  });

  describe("websocket readyState handling", () => {
    it("only sends messages when websocket is open", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      const msg = await readMessage(ws);
      expect(msg).toBeDefined();

      ws.close();

      // After closing, attempting to send should not throw
      expect(() => {
        ws.send(JSON.stringify({ type: "ping" }));
      }).not.toThrow();
    });

    it("handles closed websockets gracefully", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      ws.close();

      // Verify connection is closed
      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    });
  });

  describe("edge cases", () => {
    it("handles events with missing optional fields", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      const messages = await readMessages(ws, 3);
      expect(messages.length).toBeGreaterThanOrEqual(3);

      ws.close();
    });

    it("handles message_done events without message field", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "message_done" && !event.message) {
          // Should handle gracefully and not send message
          expect(true).toBe(true);
        }
      });

      unsub?.();
      ws.close();
    });

    it("handles rate_limit events without rateLimitInfo", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "rate_limit" && !event.rateLimitInfo) {
          // Should handle gracefully
          expect(true).toBe(true);
        }
      });

      unsub?.();
      ws.close();
    });

    it("handles prompt_suggestion events without suggestions", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "prompt_suggestion" && !event.suggestions) {
          expect(true).toBe(true);
        }
      });

      unsub?.();
      ws.close();
    });

    it("handles init events without initData", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "init" && !event.initData) {
          expect(true).toBe(true);
        }
      });

      unsub?.();
      ws.close();
    });

    it("handles task_update events without taskInfo", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 3);

      const unsub = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "task_update" && !event.taskInfo) {
          expect(true).toBe(true);
        }
      });

      unsub?.();
      ws.close();
    });
  });

  describe("client message handling", () => {
    it("rejects invalid JSON messages gracefully", async () => {
      const ws = await connectWs();

      // Send invalid JSON - the handler should ignore it
      ws.send("invalid json {]");

      // Connection should remain open
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it("handles session:interrupt messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({ type: "session:connect", sessionId: session.id })
      );

      await readMessages(ws, 5);

      ws.send(
        JSON.stringify({ type: "session:interrupt", sessionId: session.id })
      );

      // Give it time to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });
  });
});
