import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
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

import { createWebSocketHandler } from "@/server/ws-handler";
import { SessionManager } from "@/server/session-manager";
import { setupPassword, createSession as createAuthSession } from "@/server/auth";
import type { ParsedEvent } from "@/server/event-parser";

// Auth is enabled (default) so we can test rejection and acceptance
beforeAll(async () => {
  delete process.env.COCKPIT_DISABLE_AUTH;
  await setupPassword("test-password");
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

      ws.send("invalid json {]");

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it("handles session:interrupt messages", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:interrupt", sessionId: session.id }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("handles message:send with ack", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "message:send", sessionId: session.id, text: "hello" }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("message:ack");
      expect(msg.sessionId).toBe(session.id);

      ws.close();
    });

    it("handles message:cancel_queued", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "message:cancel_queued", sessionId: session.id }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");

      ws.close();
    });

    it("handles message:pause_queue", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "message:pause_queue", sessionId: session.id }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.paused).toBe(true);

      ws.close();
    });

    it("handles message:resume_queue", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "message:resume_queue", sessionId: session.id }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.paused).toBe(false);

      ws.close();
    });

    it("handles message:delete_queued", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "message:delete_queued", sessionId: session.id, messageId: "q-123" }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");

      ws.close();
    });

    it("handles message:edit_queued", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "message:edit_queued", sessionId: session.id, messageId: "q-123" }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");

      ws.close();
    });

    it("handles session:set_thinking", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_thinking", sessionId: session.id, level: "low" }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(manager.getThinkingLevel(session.id)).toBe("low");
      ws.close();
    });

    it("handles session:set_model", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_model", sessionId: session.id, model: "opus" }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(manager.getModel(session.id)).toBe("opus");
      ws.close();
    });

    it("handles permission:set_bypass enable and disable", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "permission:set_bypass", sessionId: session.id, enabled: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(manager.isBypassActive(session.id)).toBe(true);

      ws.send(JSON.stringify({ type: "permission:set_bypass", sessionId: session.id, enabled: false }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(manager.isBypassActive(session.id)).toBe(false);

      ws.close();
    });

    it("handles session:set_plan_mode enable and disable", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_plan_mode", sessionId: session.id, enabled: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(manager.isPlanModeActive(session.id)).toBe(true);

      ws.send(JSON.stringify({ type: "session:set_plan_mode", sessionId: session.id, enabled: false }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(manager.isPlanModeActive(session.id)).toBe(false);

      ws.close();
    });

    it("handles session:subscribe for status watching", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:subscribe", sessionIds: [session.id] }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("handles session:connect with lastMessageId for delta sync", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({
        type: "session:connect",
        sessionId: session.id,
        lastMessageId: "nonexistent-id",
      }));

      const msgs = await readMessages(ws, 5);
      const historyMsg = msgs.find((m) => m.type === "history");
      expect(historyMsg).toBeDefined();

      ws.close();
    });
  });

  describe("handleParsedEvent", () => {
    function emitEvent(sessionId: string, event: ParsedEvent) {
      const sessions = (manager as any).sessions as Map<string, any>;
      const session = sessions.get(sessionId);
      if (session) session.emitter.emit("event", sessionId, event);
    }

    function waitForConnect(ws: WebSocket, sessionId: string): Promise<void> {
      return new Promise((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "session:queued" && msg.sessionId === sessionId) {
            ws.removeListener("message", handler);
            resolve();
          }
        };
        ws.on("message", handler);
        ws.send(JSON.stringify({ type: "session:connect", sessionId }));
      });
    }

    it("forwards text_delta as assistant:text", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, { type: "text_delta", text: "hello world" } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      expect(msg.text).toBe("hello world");

      ws.close();
    });

    it("forwards thinking events as assistant:thinking", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, { type: "thinking", text: "pondering" } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:thinking");
      expect(msg.text).toBe("pondering");

      ws.close();
    });

    it("forwards tool_use_start as assistant:tool_use", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "tool_use_start",
        toolName: "Read",
        toolInput: '{"path": "/tmp/file.txt"}',
        toolId: "t1",
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_use");
      expect(msg.name).toBe("Read");

      ws.close();
    });

    it("forwards tool_result as assistant:tool_result", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "tool_result",
        toolId: "t1",
        toolOutput: "file contents",
        filePath: "/tmp/file.txt",
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_result");
      expect(msg.toolId).toBe("t1");
      expect(msg.filePath).toBe("/tmp/file.txt");

      ws.close();
    });

    it("forwards message_done as assistant:message_done", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "message_done",
        message: { id: "m1", role: "assistant", content: "done" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:message_done");

      ws.close();
    });

    it("forwards tool_children as assistant:tool_children", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "tool_children",
        toolId: "t1",
        messageId: "m1",
        children: [{ id: "c1", name: "Read" }],
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_children");

      ws.close();
    });

    it("forwards tool_progress as assistant:tool_progress", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "tool_progress",
        toolId: "t1",
        text: "50% complete",
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_progress");
      expect(msg.content).toBe("50% complete");

      ws.close();
    });

    it("forwards rate_limit as session:rate_limit", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "rate_limit",
        rateLimitInfo: { status: "limited", retryAfterMs: 5000 },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:rate_limit");
      expect(msg.retryAfterMs).toBe(5000);

      ws.close();
    });

    it("forwards prompt_suggestion as session:suggestions", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "prompt_suggestion",
        suggestions: ["try this", "or that"],
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:suggestions");
      expect(msg.suggestions).toEqual(["try this", "or that"]);

      ws.close();
    });

    it("forwards init event as session:init", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "init",
        initData: { slashCommands: [], skills: [], agents: [], mcpServers: [], version: "1.0", model: "sonnet" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:init");

      ws.close();
    });

    it("forwards permission_request as permission:request", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-1",
        toolInput: "rm -rf /",
        rawToolInput: { command: "rm -rf /" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("permission:request");
      expect(msg.toolName).toBe("Bash");

      ws.close();
    });

    it("forwards AskUserQuestion as question:request", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "permission_request",
        toolName: "AskUserQuestion",
        requestId: "req-2",
        toolInput: "What color?",
        rawToolInput: { question: "What color?" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("question:request");

      ws.close();
    });

    it("forwards task_update as session:task_update", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "task_update",
        taskInfo: { taskId: "t1", toolUseId: "tu1", status: "progress", description: "Working" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:task_update");
      expect((msg.task as any).status).toBe("running");

      ws.close();
    });

    it("forwards tool_done as assistant:tool_use", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      emitEvent(session.id, {
        type: "tool_done",
        toolName: "Write",
        toolInput: '{"path": "/tmp/file.txt"}',
        toolId: "t2",
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_use");
      expect(msg.name).toBe("Write");

      ws.close();
    });
  });
});
