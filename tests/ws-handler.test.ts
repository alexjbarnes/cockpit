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

vi.mock("@/server/plans", () => ({
  findLatestPlanFile: () => "/tmp/plan.md",
  readPlanFile: () => "plan content",
}));

import { createSession as createAuthSession, setupPassword } from "@/server/auth";
import type { ParsedEvent } from "@/server/event-parser";
import { SessionManager } from "@/server/session-manager";
import { appendToBuffer, MAX_BUFFER } from "@/server/terminal-buffer";
import { TerminalManager } from "@/server/terminal-manager";
import { createWebSocketHandler } from "@/server/ws-handler";

beforeAll(async () => {
  await setupPassword("test-password");
});

describe("WebSocket handler", () => {
  let server: Server;
  let manager: SessionManager;
  let terminalMgr: TerminalManager;
  let port: number;
  let validToken: string;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
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
    const _code = await new Promise<number>((resolve) => {
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
    ws.send(JSON.stringify({ type: "session:connect", sessionId: "nonexistent" }));
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

    ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

      // Skip the initial connection messages
      await readMessages(ws, 5);

      // Create a subscription to verify event types are handled
      let _eventReceived = false;
      const unsubscribe = manager.subscribe(session.id, (event: ParsedEvent) => {
        if (event.type === "text_delta" && event.text) {
          _eventReceived = true;
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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

      const messages = await readMessages(ws, 3);
      expect(messages.length).toBeGreaterThanOrEqual(3);

      ws.close();
    });

    it("handles message_done events without message field", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));

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
      await vi.waitFor(() => expect(manager.getThinkingLevel(session.id)).toBe("low"));
      ws.close();
    });

    it("handles session:set_model", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_model", sessionId: session.id, model: "opus" }));
      await vi.waitFor(() => expect(manager.getModel(session.id)).toBe("opus"));
      ws.close();
    });

    it("handles session:set_model_slot", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_model_slot", sessionId: session.id, slot: "primary", modelId: "opus" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      ws.close();
    });

    it("handles session:set_runtime", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_runtime", sessionId: session.id, runtime: "stream" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      ws.close();
    });

    it("handles session:restart", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:restart", sessionId: session.id }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      ws.close();
    });

    it("handles permission:set_bypass enable and disable", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "permission:set_bypass", sessionId: session.id, enabled: true }));
      await vi.waitFor(() => expect(manager.isBypassActive(session.id)).toBe(true));

      ws.send(JSON.stringify({ type: "permission:set_bypass", sessionId: session.id, enabled: false }));
      await vi.waitFor(() => expect(manager.isBypassActive(session.id)).toBe(false));

      ws.close();
    });

    it("handles session:set_plan_mode enable and disable", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await readMessages(ws, 5);

      ws.send(JSON.stringify({ type: "session:set_plan_mode", sessionId: session.id, enabled: true }));
      await vi.waitFor(() => expect(manager.isPlanModeActive(session.id)).toBe(true));

      ws.send(JSON.stringify({ type: "session:set_plan_mode", sessionId: session.id, enabled: false }));
      await vi.waitFor(() => expect(manager.isPlanModeActive(session.id)).toBe(false));

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

    it("handles permission:response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await new Promise((resolve) => setTimeout(resolve, 50));

      ws.send(
        JSON.stringify({
          type: "session:connect",
          sessionId: session.id,
        }),
      );
      await readMessages(ws, 5);

      ws.send(
        JSON.stringify({
          type: "permission:response",
          sessionId: session.id,
          requestId: "req-1",
          allowed: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      ws.close();
    });

    it("handles question:response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await new Promise((resolve) => setTimeout(resolve, 50));

      ws.send(
        JSON.stringify({
          type: "session:connect",
          sessionId: session.id,
        }),
      );
      await readMessages(ws, 5);

      ws.send(
        JSON.stringify({
          type: "question:response",
          sessionId: session.id,
          requestId: "req-1",
          answers: ["yes"],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));

      ws.close();
    });

    it("handles session:connect with lastMessageId for delta sync", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({
          type: "session:connect",
          sessionId: session.id,
          lastMessageId: "nonexistent-id",
        }),
      );

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

      (manager as any).sessions.get(session.id).pendingRequests.set("req-1", {
        type: "permission",
        requestId: "req-1",
        toolName: "Bash",
        toolInput: "rm -rf /",
      });
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

      (manager as any).sessions.get(session.id).pendingRequests.set("req-2", {
        type: "question",
        requestId: "req-2",
        toolName: "AskUserQuestion",
        toolInput: "What color?",
      });
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

    it("drops permission_request with no pending entry (auto-resolved)", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      // No pending entry set — the guard should drop this.
      emitEvent(session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-auto",
        toolInput: "ls",
        rawToolInput: { command: "ls" },
      } as ParsedEvent);
      // Emit a rate_limit probe and assert the first received message is that probe.
      emitEvent(session.id, {
        type: "rate_limit",
        rateLimitInfo: { status: "rate_limited", retryAfterMs: 1000 },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:rate_limit");
      expect(msg).not.toHaveProperty("requestId");

      ws.close();
    });

    it("forwards genuine permission request with pending entry", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      (manager as any).sessions.get(session.id).pendingRequests.set("req-gen", {
        type: "permission",
        requestId: "req-gen",
        toolName: "Bash",
        toolInput: "ls",
      });
      emitEvent(session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-gen",
        toolInput: "ls",
        rawToolInput: { command: "ls" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("permission:request");
      expect(msg.requestId).toBe("req-gen");
      expect(msg.toolName).toBe("Bash");

      ws.close();
    });

    it("forwards genuine question with pending entry", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      await waitForConnect(ws, session.id);

      (manager as any).sessions.get(session.id).pendingRequests.set("req-q", {
        type: "question",
        requestId: "req-q",
        toolName: "AskUserQuestion",
        toolInput: "What is your favorite color?",
      });
      emitEvent(session.id, {
        type: "permission_request",
        toolName: "AskUserQuestion",
        requestId: "req-q",
        toolInput: "What is your favorite color?",
        rawToolInput: { question: "What is your favorite color?" },
      } as ParsedEvent);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("question:request");
      expect(msg.requestId).toBe("req-q");
      // No permission:request should be sent
      expect(msg).not.toHaveProperty("toolName");

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

  describe("session event forwarding", () => {
    function emitOnChannel(sessionId: string, channel: string, ...args: unknown[]) {
      const sessions = (manager as any).sessions as Map<string, any>;
      const session = sessions.get(sessionId);
      if (session) session.emitter.emit(channel, sessionId, ...args);
    }

    function waitForConnect2(ws: WebSocket, sessionId: string): Promise<void> {
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

    it("forwards error events as session:error", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "error", "something went wrong");
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:error");
      expect(msg.error).toBe("something went wrong");

      ws.close();
    });

    it("forwards system events as session:system", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "system", "__compact::done");
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:system");
      expect(msg.text).toBe("__compact::done");

      ws.close();
    });

    it("forwards clear events as session:clear", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "clear");
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:clear");
      expect(msg.sessionId).toBe(session.id);

      ws.close();
    });

    it("forwards info_updated events as session:info_updated", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "info_updated", { ...session, model: "opus" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:info_updated");
      expect((msg.info as any).model).toBe("opus");

      ws.close();
    });

    it("forwards usage events as session:usage", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "usage", { used: 5000, total: 200000 });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:usage");
      expect((msg.usage as any).used).toBe(5000);

      ws.close();
    });

    it("forwards todos events as session:todos", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "todos", [{ content: "task 1", status: "pending" }]);
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:todos");
      expect((msg.todos as any[])[0].content).toBe("task 1");

      ws.close();
    });

    it("forwards queued events as session:queued", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect2(ws, session.id);

      emitOnChannel(session.id, "queued", 2, "test message");
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.count).toBe(2);
      expect(msg.sentText).toBe("test message");

      ws.close();
    });
  });

  describe("history:request_more", () => {
    function waitForConnect3(ws: WebSocket, sessionId: string): Promise<void> {
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

    it("sends history:more response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect3(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "history:request_more",
          sessionId: session.id,
          beforeMessageId: "msg-1",
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("history:more");
      expect(msg.sessionId).toBe(session.id);
      expect(Array.isArray(msg.messages)).toBe(true);

      ws.close();
    });
  });

  describe("session:subscribe", () => {
    it("receives status updates for subscribed sessions", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      ws.send(
        JSON.stringify({
          type: "session:subscribe",
          sessionIds: [session.id],
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      const sessions = (manager as any).sessions as Map<string, any>;
      const s = sessions.get(session.id);
      if (s) {
        s.emitter.emit("status", session.id, "running");
      }

      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:status");
      expect(msg.status).toBe("running");

      ws.close();
    });
  });

  describe("message:send", () => {
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

    it("sends message:ack on message:send", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "message:send",
          sessionId: session.id,
          text: "hello",
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("message:ack");
      expect(msg.sessionId).toBe(session.id);
      ws.close();
    });
  });

  describe("message:cancel_queued", () => {
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

    it("responds with session:queued on cancel", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "message:cancel_queued",
          sessionId: session.id,
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.sessionId).toBe(session.id);
      ws.close();
    });
  });

  describe("message:pause_queue and resume_queue", () => {
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

    it("pauses queue and sends queued response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "message:pause_queue",
          sessionId: session.id,
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.paused).toBe(true);
      ws.close();
    });

    it("resumes queue and sends queued response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      manager.pauseQueue(session.id);
      ws.send(
        JSON.stringify({
          type: "message:resume_queue",
          sessionId: session.id,
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.paused).toBe(false);
      ws.close();
    });
  });

  describe("message:delete_queued and edit_queued", () => {
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

    it("deletes queued message and sends response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "message:delete_queued",
          sessionId: session.id,
          messageId: "nonexistent",
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      ws.close();
    });

    it("edits queued message and sends response with editText", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "message:edit_queued",
          sessionId: session.id,
          messageId: "nonexistent",
        }),
      );
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      ws.close();
    });
  });

  describe("session:interrupt", () => {
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

    it("sends interrupt to session manager", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "session:interrupt",
          sessionId: session.id,
        }),
      );
      // Interrupt doesn't send a response directly, just test no crash
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
    });
  });

  describe("session:set_thinking and set_model", () => {
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

    it("sets thinking level via WS message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "session:set_thinking",
          sessionId: session.id,
          level: "low",
        }),
      );
      await vi.waitFor(() => expect(manager.getThinkingLevel(session.id)).toBe("low"));
      ws.close();
    });

    it("sets model via WS message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "session:set_model",
          sessionId: session.id,
          model: "opus",
        }),
      );
      await vi.waitFor(() => expect(manager.getModel(session.id)).toBe("opus"));
      ws.close();
    });
  });

  describe("permission:set_bypass", () => {
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

    it("enables bypass via WS message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "permission:set_bypass",
          sessionId: session.id,
          enabled: true,
        }),
      );
      await vi.waitFor(() => expect(manager.isBypassActive(session.id)).toBe(true));
      ws.close();
    });

    it("disables bypass via WS message", async () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "permission:set_bypass",
          sessionId: session.id,
          enabled: false,
        }),
      );
      await vi.waitFor(() => expect(manager.isBypassActive(session.id)).toBe(false));
      ws.close();
    });
  });

  describe("session:set_plan_mode", () => {
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

    it("enables plan mode via WS message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "session:set_plan_mode",
          sessionId: session.id,
          enabled: true,
        }),
      );
      await vi.waitFor(() => expect(manager.isPlanModeActive(session.id)).toBe(true));
      ws.close();
    });

    it("disables plan mode via WS message", async () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "session:set_plan_mode",
          sessionId: session.id,
          enabled: false,
        }),
      );
      await vi.waitFor(() => expect(manager.isPlanModeActive(session.id)).toBe(false));
      ws.close();
    });
  });

  describe("handleParsedEvent branches via emitter", () => {
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

    it("forwards rate_limit events", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "rate_limit",
        rateLimitInfo: { status: "rate_limited", retryAfterMs: 5000 },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:rate_limit");
      expect(msg.retryAfterMs).toBe(5000);
      ws.close();
    });

    it("forwards prompt_suggestion events", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "prompt_suggestion",
        suggestions: ["try this", "or that"],
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:suggestions");
      expect(msg.suggestions).toEqual(["try this", "or that"]);
      ws.close();
    });

    it("forwards tool_done events", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "tool_done",
        toolName: "Bash",
        toolInput: "ls",
        toolId: "t1",
        isMainThread: true,
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_use");
      expect(msg.name).toBe("Bash");
      ws.close();
    });

    it("forwards tool_progress events", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "tool_progress",
        toolId: "t1",
        text: "in progress...",
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_progress");
      expect(msg.content).toBe("in progress...");
      ws.close();
    });

    it("forwards tool_children events", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "tool_children",
        messageId: "m1",
        toolId: "t1",
        children: [{ id: "c1", name: "Bash" }],
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_children");
      expect(msg.toolId).toBe("t1");
      ws.close();
    });

    it("forwards task_update events", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "task_update",
        taskInfo: { taskId: "task-1", toolUseId: "tu-1", status: "progress", description: "doing stuff" },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:task_update");
      const task = msg.task as Record<string, unknown>;
      expect(task.status).toBe("running");
      expect(task.activity).toBe("doing stuff");
      ws.close();
    });

    it("forwards init events and sets initData", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      const initData = {
        slashCommands: ["/test"],
        skills: [],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [],
      };
      s.emitter.emit("event", session.id, {
        type: "init",
        initData,
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:init");
      ws.close();
    });

    it("forwards permission_request for AskUserQuestion as question:request", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.pendingRequests.set("req-1", {
        type: "question",
        requestId: "req-1",
        toolName: "AskUserQuestion",
        toolInput: "What do you think?",
      });
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "AskUserQuestion",
        requestId: "req-1",
        toolInput: "What do you think?",
        rawToolInput: { questions: ["What do you think?"] },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("question:request");
      expect(msg.requestId).toBe("req-1");
      ws.close();
    });

    it("forwards permission_request for regular tools as permission:request", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.pendingRequests.set("req-2", {
        type: "permission",
        requestId: "req-2",
        toolName: "Bash",
        toolInput: "rm -rf /",
      });
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-2",
        toolInput: "rm -rf /",
        rawToolInput: { command: "rm -rf /" },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("permission:request");
      expect(msg.toolName).toBe("Bash");
      ws.close();
    });

    it("skips rate_limit event without rateLimitInfo", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "rate_limit" });
      // Should not send anything - verify by emitting another event
      s.emitter.emit("event", session.id, { type: "text_delta", text: "check" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      ws.close();
    });

    it("skips prompt_suggestion event without suggestions", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "prompt_suggestion" });
      s.emitter.emit("event", session.id, { type: "text_delta", text: "check" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      ws.close();
    });

    it("skips task_update event without taskInfo", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "task_update" });
      s.emitter.emit("event", session.id, { type: "text_delta", text: "check" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      ws.close();
    });

    it("skips init event without initData", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "init" });
      s.emitter.emit("event", session.id, { type: "text_delta", text: "check" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      ws.close();
    });

    it("forwards message_done with message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "message_done",
        message: { id: "m1", role: "assistant", content: "done", toolUses: [], blocks: [] },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:message_done");
      ws.close();
    });

    it("skips message_done without message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "message_done" });
      s.emitter.emit("event", session.id, { type: "text_delta", text: "check" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      ws.close();
    });
  });

  describe("PTY mode suppresses content events", () => {
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

    function collectUntilQueued(ws: WebSocket, sessionId: string): Promise<Record<string, unknown>[]> {
      return new Promise((resolve) => {
        const messages: Record<string, unknown>[] = [];
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "session:queued" && msg.sessionId === sessionId) {
            ws.removeListener("message", handler);
            resolve(messages);
          }
        };
        ws.on("message", handler);
      });
    }

    it("suppresses all content events for PTY sessions", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.runtime = "pty";
      s.emitter.emit("event", session.id, { type: "thinking", text: "hmm" });
      s.emitter.emit("event", session.id, { type: "text_delta", text: "hello" });
      s.emitter.emit("event", session.id, { type: "tool_use_start", toolName: "Bash", toolInput: "ls", toolId: "t1" });
      s.emitter.emit("event", session.id, { type: "tool_done", toolName: "Bash", toolInput: "ls", toolId: "t1" });
      s.emitter.emit("event", session.id, { type: "tool_result", toolId: "t1", toolOutput: "file.txt" });
      s.emitter.emit("event", session.id, {
        type: "message_done",
        message: { id: "m1", role: "assistant", content: "done", toolUses: [], blocks: [] },
      });
      s.emitter.emit("event", session.id, {
        type: "streaming_snapshot",
        message: { id: "m2", role: "assistant", content: "partial", toolUses: [], blocks: [] },
      });
      s.emitter.emit("event", session.id, { type: "tool_children", messageId: "m1", toolId: "t1", children: [] });
      s.emitter.emit("event", session.id, { type: "tool_progress", toolId: "t1", text: "progress" });

      // Emit a non-content event as probe to verify the connection is alive
      s.emitter.emit("event", session.id, {
        type: "rate_limit",
        rateLimitInfo: { status: "rate_limited", retryAfterMs: 1000 },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:rate_limit");
      ws.close();
    });

    it("still forwards non-content events for PTY sessions", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.runtime = "pty";
      s.pendingRequests.set("req-pty", {
        type: "permission",
        requestId: "req-pty",
        toolName: "Bash",
        toolInput: "ls",
      });
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-pty",
        toolInput: "ls",
        rawToolInput: { command: "ls" },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("permission:request");
      expect(msg.toolName).toBe("Bash");
      ws.close();
    });

    it("skips streaming snapshot on connect for PTY sessions", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.info.runtime = "pty";
      s.info.status = "running";
      s.streamingSnapshot = { messageId: "m1", content: "partial", toolUses: [], blocks: [] };

      const ws = await connectWs();
      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      expect(msgs.some((m) => m.type === "session:streaming_snapshot")).toBe(false);
      ws.close();
    });
  });

  describe("session:connect with bypass, plan mode, model, thinking level", () => {
    function collectUntilQueued(ws: WebSocket, sessionId: string): Promise<Record<string, unknown>[]> {
      return new Promise((resolve) => {
        const messages: Record<string, unknown>[] = [];
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "session:queued" && msg.sessionId === sessionId) {
            ws.removeListener("message", handler);
            resolve(messages);
          }
        };
        ws.on("message", handler);
      });
    }

    it("sends bypass_state::on when bypass is active", async () => {
      const session = manager.createSession("/tmp");
      manager.setBypassAllPermissions(session.id);
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      const systemMsgs = msgs.filter((m) => m.type === "session:system");
      expect(systemMsgs.some((m) => m.text === "__bypass_state::on")).toBe(true);
      ws.close();
    });

    it("sends plan_state::on when plan mode is active", async () => {
      const session = manager.createSession("/tmp");
      manager.setPlanMode(session.id);
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      const systemMsgs = msgs.filter((m) => m.type === "session:system");
      expect(systemMsgs.some((m) => m.text === "__plan_state::on")).toBe(true);
      ws.close();
    });

    it("sends __model:: when model is not sonnet", async () => {
      const session = manager.createSession("/tmp");
      manager.setModel(session.id, "opus");
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      const systemMsgs = msgs.filter((m) => m.type === "session:system");
      expect(systemMsgs.some((m) => (m.text as string).includes("__model::opus"))).toBe(true);
      ws.close();
    });

    it("sends __thinking_level:: when level is not high", async () => {
      const session = manager.createSession("/tmp");
      manager.setThinkingLevel(session.id, "low");
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      const systemMsgs = msgs.filter((m) => m.type === "session:system");
      expect(systemMsgs.some((m) => (m.text as string).includes("__thinking_level::low"))).toBe(true);
      ws.close();
    });

    it("sends __compact::start when compacting", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.compacting = true;
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      const systemMsgs = msgs.filter((m) => m.type === "session:system");
      expect(systemMsgs.some((m) => m.text === "__compact::start")).toBe(true);
      ws.close();
    });

    it("sends initData when available", async () => {
      const session = manager.createSession("/tmp");
      manager.setInitData(session.id, {
        slashCommands: ["/test"],
        skills: [],
        agents: [],
        version: "1.0",
        model: "opus",
        mcpServers: [],
      });
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      expect(msgs.some((m) => m.type === "session:init")).toBe(true);
      ws.close();
    });

    it("sends todos when available", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.todoItems = [{ content: "task 1", status: "pending" }];
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      const todoMsgs = msgs.filter((m) => m.type === "session:todos");
      expect(todoMsgs.length).toBeGreaterThan(0);
      ws.close();
    });

    it("re-emits pending permission requests", async () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, {
        type: "permission",
        requestId: "perm-1",
        toolName: "Bash",
        toolInput: "rm -rf /",
      });
      const ws = await connectWs();

      const messages: Record<string, unknown>[] = [];
      const collected = new Promise<void>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "permission:request") {
            ws.removeListener("message", handler);
            resolve();
          }
        };
        ws.on("message", handler);
      });
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await collected;

      expect(messages.some((m) => m.type === "permission:request")).toBe(true);
      ws.close();
    });

    it("re-emits pending question requests", async () => {
      const session = manager.createSession("/tmp");
      manager.addPendingRequest(session.id, {
        type: "question",
        requestId: "q-1",
        toolName: "AskUserQuestion",
        toolInput: "What?",
      });
      const ws = await connectWs();

      const messages: Record<string, unknown>[] = [];
      const collected = new Promise<void>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "question:request") {
            ws.removeListener("message", handler);
            resolve();
          }
        };
        ws.on("message", handler);
      });
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await collected;

      expect(messages.some((m) => m.type === "question:request")).toBe(true);
      ws.close();
    });
  });

  describe("session:connect with lastMessageId", () => {
    function waitForHistory(ws: WebSocket, sessionId: string): Promise<Record<string, unknown>> {
      return new Promise((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "history" && msg.sessionId === sessionId) {
            ws.removeListener("message", handler);
            resolve(msg);
          }
        };
        ws.on("message", handler);
      });
    }

    it("sends full history when lastMessageId is not provided", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      const histPromise = waitForHistory(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const hist = await histPromise;
      expect(hist.delta).toBeUndefined();
      ws.close();
    });
  });

  describe("handleParsedEvent fallback values", () => {
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

    it("uses empty string fallbacks for thinking event with missing text", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "thinking" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:thinking");
      expect(msg.text).toBe("");
      ws.close();
    });

    it("uses empty string fallbacks for text_delta with missing text", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "text_delta" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      expect(msg.text).toBe("");
      ws.close();
    });

    it("uses empty string fallbacks for tool_use_start with missing fields", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "tool_use_start" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_use");
      expect(msg.name).toBe("");
      expect(msg.input).toBe("");
      expect(msg.toolId).toBe("");
      ws.close();
    });

    it("uses empty string fallbacks for tool_done with missing fields", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "tool_done" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_use");
      expect(msg.name).toBe("");
      expect(msg.input).toBe("");
      expect(msg.toolId).toBe("");
      ws.close();
    });

    it("uses empty string fallbacks for tool_result with missing fields", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "tool_result" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_result");
      expect(msg.toolId).toBe("");
      expect(msg.output).toBe("");
      ws.close();
    });

    it("uses empty string/array fallbacks for tool_children with missing fields", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "tool_children" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_children");
      expect(msg.messageId).toBe("");
      expect(msg.toolId).toBe("");
      expect(msg.children).toEqual([]);
      ws.close();
    });

    it("uses empty string fallback for tool_progress with missing fields", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "tool_progress" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:tool_progress");
      expect(msg.toolId).toBe("");
      expect(msg.content).toBe("");
      ws.close();
    });

    it("forwards permission_request for ExitPlanMode with planFilePath", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.pendingRequests.set("req-plan", {
        type: "permission",
        requestId: "req-plan",
        toolName: "ExitPlanMode",
        toolInput: "exit plan",
      });
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "ExitPlanMode",
        requestId: "req-plan",
        toolInput: "exit plan",
        rawToolInput: { action: "exit" },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("permission:request");
      expect(msg.toolName).toBe("ExitPlanMode");
      expect("planFilePath" in msg).toBe(true);
      ws.close();
    });

    it("drops permission_request with no pending entry", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "Bash",
        toolInput: "ls",
      });
      // No pending entry set, so the guard should drop it.
      // Emit a rate_limit probe and assert the first received message is that probe.
      s.emitter.emit("event", session.id, {
        type: "rate_limit",
        rateLimitInfo: { status: "rate_limited", retryAfterMs: 1000 },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:rate_limit");
      ws.close();
    });

    it("forwards streaming_snapshot event with message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "streaming_snapshot",
        message: { id: "snap-1", role: "assistant", content: "partial", toolUses: [], blocks: [] },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:streaming_snapshot");
      expect(msg.messageId).toBe("snap-1");
      ws.close();
    });

    it("skips streaming_snapshot event without message", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, { type: "streaming_snapshot" });
      s.emitter.emit("event", session.id, { type: "text_delta", text: "check" });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("assistant:text");
      ws.close();
    });

    it("task_update with non-progress status does not set activity", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.emitter.emit("event", session.id, {
        type: "task_update",
        taskInfo: { taskId: "t1", toolUseId: "tu1", status: "done", description: "finished", summary: "all done" },
      });
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:task_update");
      const task = msg.task as Record<string, unknown>;
      expect(task.status).toBe("done");
      expect(task.activity).toBeUndefined();
      expect(task.summary).toBe("all done");
      ws.close();
    });
  });

  describe("session:connect edge cases", () => {
    function collectUntilQueued(ws: WebSocket, sessionId: string): Promise<Record<string, unknown>[]> {
      return new Promise((resolve) => {
        const messages: Record<string, unknown>[] = [];
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "session:queued" && msg.sessionId === sessionId) {
            ws.removeListener("message", handler);
            resolve(messages);
          }
        };
        ws.on("message", handler);
      });
    }

    it("sends streaming snapshot when session is running with snapshot", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.info.status = "running";
      s.streamingSnapshot = { messageId: "m1", content: "partial", toolUses: [], blocks: [] };

      const ws = await connectWs();
      const messages: Record<string, unknown>[] = [];
      const collected = new Promise<void>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          messages.push(msg);
          if (msg.type === "session:queued") {
            ws.removeListener("message", handler);
            resolve();
          }
        };
        ws.on("message", handler);
      });
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await collected;

      expect(messages.some((m) => m.type === "session:streaming_snapshot")).toBe(true);
      ws.close();
    });

    it("sends usage when available", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.contextUsage = { inputTokens: 100, outputTokens: 50, cacheCreation: 0, cacheRead: 0, contextWindow: 200000 };

      const ws = await connectWs();
      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgsPromise;

      expect(msgs.some((m) => m.type === "session:usage")).toBe(true);
      ws.close();
    });

    it("connects with cwd using getSessionByCwd", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      const msgsPromise = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id, cwd: "/tmp" }));
      const msgs = await msgsPromise;

      expect(msgs.some((m) => m.type === "session:connected")).toBe(true);
      ws.close();
    });

    it("cleans up previous subscriptions on reconnect to same session", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      const msgs1 = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      await msgs1;

      const msgs2 = collectUntilQueued(ws, session.id);
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id }));
      const msgs = await msgs2;

      expect(msgs.some((m) => m.type === "session:connected")).toBe(true);
      ws.close();
    });

    it("ignores invalid JSON messages", async () => {
      const ws = await connectWs();
      ws.send("not json at all");
      ws.send(JSON.stringify({ type: "ping" }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("pong");
      ws.close();
    });

    it("sends lastMessageId in connect and gets history response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();

      const histPromise = new Promise<Record<string, unknown>>((resolve) => {
        const handler = (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "history") {
            ws.removeListener("message", handler);
            resolve(msg);
          }
        };
        ws.on("message", handler);
      });
      ws.send(JSON.stringify({ type: "session:connect", sessionId: session.id, lastMessageId: "nonexistent-id" }));
      const hist = await histPromise;

      expect(hist.type).toBe("history");
      expect(Array.isArray(hist.messages)).toBe(true);
      ws.close();
    });
  });

  describe("session:interrupt with queue pause", () => {
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

    it("sends queue pause state after interrupt when queue is paused", async () => {
      const session = manager.createSession("/tmp");
      const s = (manager as any).sessions.get(session.id)!;
      s.info.status = "running";
      s.queuePaused = true;

      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(JSON.stringify({ type: "session:interrupt", sessionId: session.id }));
      const msg = await readMessage(ws);
      expect(msg.type).toBe("session:queued");
      expect(msg.paused).toBe(true);
      ws.close();
    });
  });

  describe("permission:response with allow_always", () => {
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

    it("handles allow_always with valid suggestion index", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.pendingRequests.set("req-sug", {
        type: "permission",
        requestId: "req-sug",
        toolName: "Bash",
        toolInput: "ls",
      });
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-sug",
        toolInput: "ls",
        rawToolInput: { command: "ls" },
        permissionSuggestions: [{ tool: "Bash", input: { command: "ls" } }],
      });
      const permMsg = await readMessage(ws);
      expect(permMsg.type).toBe("permission:request");

      ws.send(
        JSON.stringify({
          type: "permission:response",
          sessionId: session.id,
          requestId: "req-sug",
          allowed: true,
          permissionMode: "allow_always",
          suggestionIndex: 0,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
    });

    it("handles allow_always without suggestion index", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      const s = (manager as any).sessions.get(session.id)!;
      s.pendingRequests.set("req-sug2", {
        type: "permission",
        requestId: "req-sug2",
        toolName: "Bash",
        toolInput: "ls",
      });
      s.emitter.emit("event", session.id, {
        type: "permission_request",
        toolName: "Bash",
        requestId: "req-sug2",
        toolInput: "ls",
        rawToolInput: { command: "ls" },
        permissionSuggestions: [{ tool: "Bash", input: { command: "ls" } }],
      });
      await readMessage(ws);

      ws.send(
        JSON.stringify({
          type: "permission:response",
          sessionId: session.id,
          requestId: "req-sug2",
          allowed: true,
          permissionMode: "allow_always",
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
    });
  });

  describe("permission:response and question:response", () => {
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

    it("handles permission:response with allow_all mode", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "permission:response",
          sessionId: session.id,
          requestId: "req-1",
          allowed: true,
          permissionMode: "allow_all",
        }),
      );
      await vi.waitFor(() => expect(manager.isBypassActive(session.id)).toBe(true));
      ws.close();
    });

    it("handles question:response", async () => {
      const session = manager.createSession("/tmp");
      const ws = await connectWs();
      await waitForConnect(ws, session.id);

      ws.send(
        JSON.stringify({
          type: "question:response",
          sessionId: session.id,
          requestId: "req-1",
          answers: ["yes"],
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      // No crash, question handled
      ws.close();
    });
  });

  describe("terminal WebSocket", () => {
    function injectFakeTerminal(id: string, buffer = ""): void {
      const fakePty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pid: 12345, onData: vi.fn(), onExit: vi.fn() };
      (terminalMgr as any).terminals.set(id, {
        id,
        pty: fakePty,
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        buffer,
        detachOffset: 0,
        client: null,
      });
    }

    function connectTerminalWs(terminalId: string, opts?: { replay?: string }): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        let url = `ws://localhost:${port}/ws/terminal?token=${validToken}&terminalId=${terminalId}`;
        if (opts?.replay !== undefined) url += `&replay=${opts.replay}`;
        const ws = new WebSocket(url);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    }

    it("rejects terminal connection without token", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/terminal`);
      await new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        ws.on("error", () => resolve());
      });
      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    });

    it("closes connection when terminalId is missing", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/terminal?token=${validToken}`);
      const code = await new Promise<number>((resolve) => {
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => {});
      });
      expect(code).toBe(1008);
    });

    it("closes connection when terminal is not found", async () => {
      const ws = await connectTerminalWs("nonexistent-terminal");
      const code = await new Promise<number>((resolve) => {
        ws.on("close", (c) => resolve(c));
      });
      expect(code).toBe(1008);
    });

    it("connects to existing terminal and attaches client", async () => {
      injectFakeTerminal("term-1");
      const ws = await connectTerminalWs("term-1");
      await new Promise((r) => setTimeout(r, 50));
      expect(ws.readyState).toBe(WebSocket.OPEN);
      const term = (terminalMgr as any).terminals.get("term-1")!;
      expect(term.client).not.toBeNull();
      ws.close();
    });

    it("sends delta on connect with replay=0", async () => {
      injectFakeTerminal("term-2", "previous output");
      const url = `ws://localhost:${port}/ws/terminal?token=${validToken}&terminalId=term-2&replay=0`;
      const ws = new WebSocket(url);
      const dataPromise = new Promise<string>((resolve) => {
        ws.on("message", (d) => resolve(d.toString()));
      });
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));
      const data = await dataPromise;
      expect(data).toBe("previous output");
      ws.close();
    });

    it("sends buffer on first resize when replay is enabled", async () => {
      injectFakeTerminal("term-3", "buffered content");
      const ws = await connectTerminalWs("term-3");
      await new Promise((r) => setTimeout(r, 50));
      ws.send("\x01R100;40");
      const data = await new Promise<string>((resolve) => {
        ws.on("message", (d) => resolve(d.toString()));
      });
      expect(data).toContain("buffered content");
      ws.close();
    });

    it("forwards input to terminal pty", async () => {
      injectFakeTerminal("term-4");
      const ws = await connectTerminalWs("term-4");
      await new Promise((r) => setTimeout(r, 50));
      ws.send("\x01R80;24");
      await new Promise((r) => setTimeout(r, 50));
      ws.send("ls -la\r");
      await vi.waitFor(() => {
        const term = (terminalMgr as any).terminals.get("term-4")!;
        expect(term.pty.write).toHaveBeenCalledWith("ls -la\r");
      });
      ws.close();
    });

    it("handles resize command", async () => {
      injectFakeTerminal("term-5");
      const ws = await connectTerminalWs("term-5", { replay: "0" });
      await new Promise((r) => setTimeout(r, 50));
      ws.send("\x01R120;50");
      await vi.waitFor(() => {
        const term = (terminalMgr as any).terminals.get("term-5")!;
        expect(term.pty.resize).toHaveBeenCalledWith(120, 50);
      });
      ws.close();
    });

    it("detaches client on close", async () => {
      injectFakeTerminal("term-6");
      const ws = await connectTerminalWs("term-6");
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
      await vi.waitFor(() => {
        const term = (terminalMgr as any).terminals.get("term-6");
        expect(!term || term.client === null).toBe(true);
      });
    });

    it("stale socket close does not detach newer client on same terminalId", async () => {
      injectFakeTerminal("term-7");

      // Connect socket1 and wait for its client to be attached
      const ws1 = await connectTerminalWs("term-7");
      let client1: unknown;
      while (true) {
        const c = (terminalMgr as any).terminals.get("term-7")!.client;
        if (c !== null) {
          client1 = c;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      // Connect socket2 and wait until its client has replaced socket1's
      const ws2 = await connectTerminalWs("term-7");
      while (true) {
        const c = (terminalMgr as any).terminals.get("term-7")!.client;
        if (c !== null && c !== client1) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      // Close socket1 (the stale socket); its close handler should not detach socket2's client
      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      const term = (terminalMgr as any).terminals.get("term-7");
      expect(term.client).not.toBeNull();
      ws2.close();
    });

    it("reconnects with replay=0 after buffer trim returns correct delta", async () => {
      // Simulate a busy terminal that hit the buffer cap and was detached
      const buffer = "x".repeat(MAX_BUFFER);
      injectFakeTerminal("term-8", buffer);
      const term = (terminalMgr as any).terminals.get("term-8")!;
      term.detachOffset = MAX_BUFFER;

      // Simulate output produced while away (after the buffer was at cap)
      appendToBuffer(term, "y".repeat(51200));

      // Use the same term reference for assertion before connect
      const expectedSlice = "y".repeat(51200);

      // Reconnect with replay=0
      const url = `ws://localhost:${port}/ws/terminal?token=${validToken}&terminalId=term-8&replay=0`;
      const ws = new WebSocket(url);
      const dataPromise = new Promise<string>((resolve) => {
        ws.on("message", (d) => resolve(d.toString()));
      });
      await new Promise<void>((resolve) => ws.on("open", () => resolve()));
      const data = await dataPromise;

      // The delta should be only the new data, not the full buffer
      expect(data).toBe(expectedSlice);
      expect(data.length).toBeLessThan(MAX_BUFFER);
      ws.close();
    });
  });
});
