import type { Server as HTTPServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "@/types";
import { extractTokenFromQuery, validateSession } from "./auth";
// loadLastUsage no longer needed - usage is returned by loadTranscript
import { debugLog, logClientMessage, logParsedEvent, logServerMessage, logStatus } from "./debug-logger";
import type { ParsedEvent } from "./event-parser";
import { findLatestPlanFile, readPlanFile } from "./plans";
import { extractTodosFromHistory, SessionManager } from "./session-manager";
import { getSessionPrefs } from "./session-prefs";

export function createWebSocketHandler(server: HTTPServer, sessionManager: SessionManager): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Server-side heartbeat: detect dead connections every 30s.
  // Without this, zombie connections persist for hours (TCP keepalive default)
  // and can cause CLI process stdout backpressure when send() buffers data
  // into a dead socket's TCP buffer.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const ext = ws as WebSocket & { isAlive?: boolean };
      if (ext.isAlive === false) {
        ws.terminate();
        continue;
      }
      ext.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url || "";
    if (!url.startsWith("/ws")) {
      return; // Let Next.js handle other upgrades (e.g. HMR)
    }

    const token = extractTokenFromQuery(url);
    if (!token || !validateSession(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const wsId = Math.random().toString(36).slice(2, 8);
    debugLog(`[ws:${wsId}] connected (clients=${wss.clients.size})`);
    const ext = ws as WebSocket & { isAlive?: boolean };
    ext.isAlive = true;
    ws.on("pong", () => {
      ext.isAlive = true;
    });
    // Track subscriptions per session so re-connects clean up old listeners
    const sessionCleanups = new Map<string, Array<() => void>>();
    // Track pending permission requests with tool name and raw input
    const pendingPermissions = new Map<
      string,
      { toolName: string; toolInput: Record<string, unknown>; permissionSuggestions?: Record<string, unknown>[] }
    >();
    // Lightweight status-only subscriptions for sidebar
    let watchCleanups: Array<() => void> = [];

    function subscribeSession(sessionId: string): void {
      const prev = sessionCleanups.get(sessionId);
      if (prev) {
        for (const fn of prev) fn();
      }
      const cleanups: Array<() => void> = [];
      sessionCleanups.set(sessionId, cleanups);

      const unsubEvent = sessionManager.subscribe(sessionId, (event: ParsedEvent) => {
        logParsedEvent(sessionId, event);
        handleParsedEvent(ws, sessionId, event, pendingPermissions, sessionManager);
      });
      if (unsubEvent) cleanups.push(unsubEvent);

      const unsubStatus = sessionManager.onStatus(sessionId, (status) => {
        logStatus(sessionId, status);
        send(ws, { type: "session:status", sessionId, status });
      });
      if (unsubStatus) cleanups.push(unsubStatus);

      const unsubError = sessionManager.onError(sessionId, (error) => {
        send(ws, { type: "session:error", sessionId, error });
      });
      if (unsubError) cleanups.push(unsubError);

      const unsubSystem = sessionManager.onSystem(sessionId, (text) => {
        send(ws, { type: "session:system", sessionId, text });
      });
      if (unsubSystem) cleanups.push(unsubSystem);

      const unsubClear = sessionManager.onClear(sessionId, () => {
        send(ws, { type: "session:clear", sessionId });
      });
      if (unsubClear) cleanups.push(unsubClear);

      const unsubInfoUpdated = sessionManager.onInfoUpdated(sessionId, (info) => {
        send(ws, { type: "session:info_updated", sessionId, info });
      });
      if (unsubInfoUpdated) cleanups.push(unsubInfoUpdated);

      const unsubUsage = sessionManager.onUsage(sessionId, (usage) => {
        send(ws, { type: "session:usage", sessionId, usage });
      });
      if (unsubUsage) cleanups.push(unsubUsage);

      const unsubTodos = sessionManager.onTodos(sessionId, (todos) => {
        send(ws, { type: "session:todos", sessionId, todos });
      });
      if (unsubTodos) cleanups.push(unsubTodos);

      const unsubInit = sessionManager.onInit(sessionId, (data) => {
        send(ws, { type: "session:init", sessionId, data });
      });
      if (unsubInit) cleanups.push(unsubInit);

      const unsubQueued = sessionManager.onQueued(sessionId, (count, sentText) => {
        send(ws, {
          type: "session:queued",
          sessionId,
          count,
          sentText: sentText ?? undefined,
          messages: sessionManager.getQueuedMessages(sessionId),
          paused: sessionManager.isQueuePaused(sessionId),
        });
      });
      if (unsubQueued) cleanups.push(unsubQueued);
    }

    ws.on("message", (data: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      logClientMessage(msg);

      switch (msg.type) {
        case "ping": {
          send(ws, { type: "pong" });
          break;
        }

        case "session:connect": {
          const sid = msg.sessionId.slice(0, 8);
          const t0 = performance.now();
          debugLog(
            `[ws:${wsId}] session:connect ${sid} (cwd=${msg.cwd || "none"}, historyView=${!!msg.historyView}, process=${sessionManager.isProcessAlive(msg.sessionId)})`,
          );

          if (msg.historyView && msg.cwd) {
            sessionManager.getCliSessionView(msg.sessionId, msg.cwd).then((result) => {
              if (!result) {
                send(ws, { type: "session:error", sessionId: msg.sessionId, error: "Session not found" });
                return;
              }
              debugLog(`[ws:${wsId}] session ${sid} history view loaded in ${(performance.now() - t0).toFixed(0)}ms`);
              send(ws, {
                type: "history",
                sessionId: msg.sessionId,
                messages: result.messages,
                status: "idle",
                hasMore: result.hasMore,
              });
              send(ws, { type: "session:connected", sessionId: msg.sessionId });
              send(ws, { type: "session:info_updated", sessionId: msg.sessionId, info: result.info });
              send(ws, { type: "session:status", sessionId: msg.sessionId, status: "idle" });
              if (result.lastUsage) {
                send(ws, { type: "session:usage", sessionId: msg.sessionId, usage: result.lastUsage });
              }
              // Surface persisted settings so the panel doesn't show defaults
              // while in history view. Prefs are keyed by cockpit id;
              // getSessionPrefs resolves CLI ids via the chain.
              const prefs = getSessionPrefs(msg.sessionId);
              if (prefs?.model && prefs.model !== "sonnet") {
                send(ws, { type: "session:system", sessionId: msg.sessionId, text: `__model::${prefs.model}` });
              }
              if (prefs?.thinkingLevel && prefs.thinkingLevel !== "high") {
                send(ws, { type: "session:system", sessionId: msg.sessionId, text: `__thinking_level::${prefs.thinkingLevel}` });
              }
              if (prefs?.bypassAllPermissions) {
                send(ws, { type: "session:system", sessionId: msg.sessionId, text: "__bypass_state::on" });
              }
              if (prefs?.planMode) {
                send(ws, { type: "session:system", sessionId: msg.sessionId, text: "__plan_state::on" });
              }
              if (prefs?.initData) {
                send(ws, { type: "session:init", sessionId: msg.sessionId, data: prefs.initData });
              }
              const historyTodos = extractTodosFromHistory(result.messages);
              if (historyTodos.length > 0) {
                send(ws, { type: "session:todos", sessionId: msg.sessionId, todos: historyTodos });
              }
            });
            break;
          }

          const sessionPromise = msg.cwd
            ? sessionManager.getSessionByCwd(msg.sessionId, msg.cwd)
            : sessionManager.getSession(msg.sessionId);
          sessionPromise.then((session) => {
            if (!session) {
              debugLog(`[ws:${wsId}] session ${sid} not found`);
              send(ws, {
                type: "session:error",
                sessionId: msg.sessionId,
                error: "Session not found",
              });
              return;
            }
            const tLoaded = performance.now();
            debugLog(
              `[ws:${wsId}] session ${sid} loaded in ${(tLoaded - t0).toFixed(0)}ms (status=${session.info.status}, messages=${session.messages.length}, process=${sessionManager.isProcessAlive(msg.sessionId)})`,
            );

            // Eagerly spawn the CLI process so initialize data (agents, models,
            // commands) is available before the user sends their first message.
            sessionManager.ensureProcess(msg.sessionId);
            const tSpawn = performance.now();
            debugLog(`[ws:${wsId}] session ${sid} ensureProcess in ${(tSpawn - tLoaded).toFixed(0)}ms`);

            // Clean up previous subscriptions for this session
            const prev = sessionCleanups.get(msg.sessionId);
            if (prev) {
              for (const fn of prev) fn();
            }
            const cleanups: Array<() => void> = [];
            sessionCleanups.set(msg.sessionId, cleanups);

            // Compute status early so it can be included in the history message.
            // This ensures the client gets status atomically with history, even
            // if the WebSocket drops before subsequent messages are delivered.
            const correctedStatus = sessionManager.isProcessAlive(msg.sessionId) ? session.info.status : "idle";
            if (correctedStatus !== session.info.status) {
              sessionManager.fixStaleStatus(msg.sessionId);
            }

            // If client already has messages, send only the delta to avoid
            // re-sending 1000+ messages on every mobile reconnect.
            // Uses the last known server message ID instead of a count, since
            // the client may have locally-generated messages with different IDs.
            const lastId = msg.lastMessageId as string | undefined;
            if (lastId) {
              const idx = session.messages.findIndex((m) => m.id === lastId);
              if (idx !== -1) {
                const delta = session.messages.slice(idx + 1);
                debugLog(
                  `[ws:${wsId}] session ${sid} sending delta (lastId=${lastId}, idx=${idx}, server=${session.messages.length}, delta=${delta.length})`,
                );
                send(ws, {
                  type: "history",
                  sessionId: msg.sessionId,
                  messages: delta,
                  delta: true,
                  status: correctedStatus,
                  hasMore: session.hasMore,
                });
              } else {
                // ID not found - client has stale state, send full history
                debugLog(`[ws:${wsId}] session ${sid} lastMessageId not found, sending full history`);
                send(ws, {
                  type: "history",
                  sessionId: msg.sessionId,
                  messages: session.messages,
                  status: correctedStatus,
                  hasMore: session.hasMore,
                });
              }
            } else {
              send(ws, {
                type: "history",
                sessionId: msg.sessionId,
                messages: session.messages,
                status: correctedStatus,
                hasMore: session.hasMore,
              });
            }

            // Send in-progress streaming message if the CLI is mid-response.
            // This restores tool calls and partial text that aren't yet in the transcript.
            // Only send when the session is actually running; an idle session has
            // no in-progress streaming, and a stale snapshot would briefly show
            // completed agents as still running until the status:idle clears it.
            const snapshot = correctedStatus === "running" ? sessionManager.getStreamingSnapshot(msg.sessionId) : null;
            if (snapshot) {
              send(ws, {
                type: "session:streaming_snapshot",
                sessionId: msg.sessionId,
                messageId: snapshot.messageId,
                content: snapshot.content,
                toolUses: snapshot.toolUses,
                blocks: snapshot.blocks,
              });
            }

            // Restore compacting indicator if compaction is in progress
            if (sessionManager.isCompacting(msg.sessionId)) {
              send(ws, {
                type: "session:system",
                sessionId: msg.sessionId,
                text: "__compact::start",
              });
            }

            send(ws, {
              type: "session:connected",
              sessionId: msg.sessionId,
            });

            send(ws, {
              type: "session:info_updated",
              sessionId: msg.sessionId,
              info: session.info,
            });

            send(ws, {
              type: "session:status",
              sessionId: msg.sessionId,
              status: correctedStatus,
            });

            if (sessionManager.isBypassActive(msg.sessionId)) {
              send(ws, {
                type: "session:system",
                sessionId: msg.sessionId,
                text: "__bypass_state::on",
              });
            }

            if (sessionManager.isPlanModeActive(msg.sessionId)) {
              send(ws, {
                type: "session:system",
                sessionId: msg.sessionId,
                text: "__plan_state::on",
              });
            }

            const model = sessionManager.getModel(msg.sessionId);
            if (model && model !== "sonnet") {
              send(ws, {
                type: "session:system",
                sessionId: msg.sessionId,
                text: `__model::${model}`,
              });
            }

            const thinkingLevel = sessionManager.getThinkingLevel(msg.sessionId);
            if (thinkingLevel !== "high") {
              send(ws, {
                type: "session:system",
                sessionId: msg.sessionId,
                text: `__thinking_level::${thinkingLevel}`,
              });
            }

            const currentUsage = sessionManager.getContextUsage(msg.sessionId);
            const usage = currentUsage || session.lastUsage;
            if (usage) {
              send(ws, {
                type: "session:usage",
                sessionId: msg.sessionId,
                usage,
              });
            }

            subscribeSession(msg.sessionId);

            // Rebuild todos from last TodoWrite in history
            const tTodos0 = performance.now();
            const fullBuffer = sessionManager.getTranscriptBuffer(msg.sessionId);
            sessionManager.rebuildTodosFromHistory(msg.sessionId, fullBuffer.length > 0 ? fullBuffer : session.messages);
            const tTodos1 = performance.now();
            debugLog(`[ws:${wsId}] session ${sid} rebuildTodos in ${(tTodos1 - tTodos0).toFixed(0)}ms`);
            const currentTodos = sessionManager.getTodos(msg.sessionId);
            if (currentTodos.length > 0) {
              send(ws, {
                type: "session:todos",
                sessionId: msg.sessionId,
                todos: currentTodos,
              });
            }

            const initData = sessionManager.getInitData(msg.sessionId);
            if (initData) {
              send(ws, {
                type: "session:init",
                sessionId: msg.sessionId,
                data: initData,
              });
            }

            send(ws, {
              type: "session:queued",
              sessionId: msg.sessionId,
              count: sessionManager.getQueuedCount(msg.sessionId),
              messages: sessionManager.getQueuedMessages(msg.sessionId),
              paused: sessionManager.isQueuePaused(msg.sessionId),
            });

            // Re-emit any pending permission/question requests that were
            // sent to a previous (now dead) WebSocket connection
            const pendingReqs = sessionManager.getPendingRequests(msg.sessionId);
            for (const req of pendingReqs) {
              if (req.type === "question") {
                send(ws, {
                  type: "question:request",
                  sessionId: msg.sessionId,
                  requestId: req.requestId,
                  questions: req.toolInput,
                });
              } else {
                const permMsg: ServerMessage & { type: "permission:request" } = {
                  type: "permission:request",
                  sessionId: msg.sessionId,
                  requestId: req.requestId,
                  toolName: req.toolName,
                  input: req.toolInput,
                };
                if (req.planFilePath) {
                  permMsg.planFilePath = req.planFilePath;
                  permMsg.planContent = req.planContent;
                }
                send(ws, permMsg);
              }
            }
            const tDone = performance.now();
            debugLog(`[ws:${wsId}] session ${sid} connect complete in ${(tDone - t0).toFixed(0)}ms`);
          });
          break;
        }

        case "history:request_more": {
          sessionManager.getMoreHistory(msg.sessionId, msg.beforeMessageId).then((result) => {
            send(ws, {
              type: "history:more",
              sessionId: msg.sessionId,
              messages: result.messages,
              hasMore: result.hasMore,
            });
          });
          break;
        }

        case "message:send": {
          send(ws, { type: "message:ack", sessionId: msg.sessionId });
          if (!sessionCleanups.has(msg.sessionId)) {
            subscribeSession(msg.sessionId);
          }
          const sent = sessionManager.sendMessage(msg.sessionId, msg.text, msg.images, msg.documents);
          if (!sent) {
            sessionManager.recoverSession(msg.sessionId).then((recovered) => {
              if (recovered) {
                subscribeSession(msg.sessionId);
                sessionManager.sendMessage(msg.sessionId, msg.text, msg.images, msg.documents);
              } else {
                send(ws, { type: "session:error", sessionId: msg.sessionId, error: "Session not found. Try refreshing the page." });
              }
            });
          }
          break;
        }

        case "message:cancel_queued": {
          const cancelledText = sessionManager.cancelQueuedMessage(msg.sessionId);
          send(ws, {
            type: "session:queued",
            sessionId: msg.sessionId,
            count: sessionManager.getQueuedCount(msg.sessionId),
            cancelledText: cancelledText ?? undefined,
            messages: sessionManager.getQueuedMessages(msg.sessionId),
            paused: sessionManager.isQueuePaused(msg.sessionId),
          });
          break;
        }

        case "message:pause_queue": {
          sessionManager.pauseQueue(msg.sessionId);
          send(ws, {
            type: "session:queued",
            sessionId: msg.sessionId,
            count: sessionManager.getQueuedCount(msg.sessionId),
            messages: sessionManager.getQueuedMessages(msg.sessionId),
            paused: true,
          });
          break;
        }

        case "message:resume_queue": {
          sessionManager.resumeQueue(msg.sessionId);
          send(ws, {
            type: "session:queued",
            sessionId: msg.sessionId,
            count: sessionManager.getQueuedCount(msg.sessionId),
            messages: sessionManager.getQueuedMessages(msg.sessionId),
            paused: false,
          });
          break;
        }

        case "message:delete_queued": {
          sessionManager.deleteQueuedMessage(msg.sessionId, msg.messageId);
          send(ws, {
            type: "session:queued",
            sessionId: msg.sessionId,
            count: sessionManager.getQueuedCount(msg.sessionId),
            messages: sessionManager.getQueuedMessages(msg.sessionId),
            paused: sessionManager.isQueuePaused(msg.sessionId),
          });
          break;
        }

        case "message:edit_queued": {
          const editText = sessionManager.editQueuedMessage(msg.sessionId, msg.messageId);
          send(ws, {
            type: "session:queued",
            sessionId: msg.sessionId,
            count: sessionManager.getQueuedCount(msg.sessionId),
            messages: sessionManager.getQueuedMessages(msg.sessionId),
            paused: sessionManager.isQueuePaused(msg.sessionId),
            editText: editText ?? undefined,
          });
          break;
        }

        case "session:interrupt": {
          sessionManager.interrupt(msg.sessionId);
          // Notify client of pause state change (interrupt auto-pauses queue)
          if (sessionManager.isQueuePaused(msg.sessionId)) {
            send(ws, {
              type: "session:queued",
              sessionId: msg.sessionId,
              count: sessionManager.getQueuedCount(msg.sessionId),
              messages: sessionManager.getQueuedMessages(msg.sessionId),
              paused: true,
            });
          }
          break;
        }

        case "permission:response": {
          const pending = pendingPermissions.get(msg.requestId);
          pendingPermissions.delete(msg.requestId);
          sessionManager.removePendingRequest(msg.sessionId, msg.requestId);

          if (msg.permissionMode === "allow_all") {
            sessionManager.setBypassAllPermissions(msg.sessionId);
          }

          let suggestions: Record<string, unknown>[] | undefined;
          if (msg.permissionMode === "allow_always" && pending?.permissionSuggestions) {
            if (
              msg.suggestionIndex !== undefined &&
              msg.suggestionIndex >= 0 &&
              msg.suggestionIndex < pending.permissionSuggestions.length
            ) {
              suggestions = [pending.permissionSuggestions[msg.suggestionIndex]];
            } else {
              suggestions = pending.permissionSuggestions;
            }
          }
          sessionManager.respondToPermission(msg.sessionId, msg.requestId, msg.allowed, pending?.toolInput, suggestions);
          break;
        }

        case "question:response": {
          const pending = pendingPermissions.get(msg.requestId);
          pendingPermissions.delete(msg.requestId);
          sessionManager.removePendingRequest(msg.sessionId, msg.requestId);
          const originalQuestions = (pending?.toolInput as Record<string, unknown>)?.questions;
          sessionManager.respondToPermission(msg.sessionId, msg.requestId, true, {
            questions: originalQuestions || [],
            answers: msg.answers,
          });
          break;
        }

        case "session:set_thinking": {
          sessionManager.setThinkingLevel(msg.sessionId, msg.level);
          break;
        }

        case "session:set_model": {
          sessionManager.setModel(msg.sessionId, msg.model);
          break;
        }

        case "permission:set_bypass": {
          if (msg.enabled) {
            sessionManager.setBypassAllPermissions(msg.sessionId);
          } else {
            sessionManager.clearBypassAllPermissions(msg.sessionId);
          }
          break;
        }

        case "session:restart": {
          sessionManager.restartSession(msg.sessionId);
          break;
        }

        case "session:set_plan_mode": {
          if (msg.enabled) {
            sessionManager.setPlanMode(msg.sessionId);
          } else {
            sessionManager.clearPlanMode(msg.sessionId);
          }
          break;
        }

        case "session:subscribe": {
          for (const fn of watchCleanups) fn();
          watchCleanups = [];

          for (const id of msg.sessionIds) {
            const unsubStatus = sessionManager.onStatus(id, (status) => {
              send(ws, { type: "session:status", sessionId: id, status });
            });
            if (unsubStatus) watchCleanups.push(unsubStatus);

            const unsubInfo = sessionManager.onInfoUpdated(id, (info) => {
              send(ws, { type: "session:info_updated", sessionId: id, info });
            });
            if (unsubInfo) watchCleanups.push(unsubInfo);
          }
          break;
        }
      }
    });

    ws.on("close", (code, _reason) => {
      const sessions = Array.from(sessionCleanups.keys()).map((s) => s.slice(0, 8));
      debugLog(`[ws:${wsId}] closed (code=${code}, sessions=[${sessions.join(",")}], clients=${wss.clients.size})`);
      for (const fns of sessionCleanups.values()) {
        for (const fn of fns) fn();
      }
      sessionCleanups.clear();
      for (const fn of watchCleanups) fn();
      watchCleanups = [];
    });
  });

  return wss;
}

function handleParsedEvent(
  ws: WebSocket,
  sessionId: string,
  event: ParsedEvent,
  pendingPermissions: Map<
    string,
    { toolName: string; toolInput: Record<string, unknown>; permissionSuggestions?: Record<string, unknown>[] }
  >,
  sessionManager: SessionManager,
): void {
  switch (event.type) {
    case "thinking":
      send(ws, {
        type: "assistant:thinking",
        sessionId,
        text: event.text || "",
        tokens: event.tokens,
        durationMs: event.durationMs,
        redacted: event.redacted,
      });
      break;

    case "text_delta":
      send(ws, {
        type: "assistant:text",
        sessionId,
        text: event.text || "",
      });
      break;

    case "tool_use_start":
      send(ws, {
        type: "assistant:tool_use",
        sessionId,
        name: event.toolName || "",
        input: event.toolInput || "",
        toolId: event.toolId || "",
        isMainThread: event.isMainThread,
      });
      break;

    case "tool_done":
      send(ws, {
        type: "assistant:tool_use",
        sessionId,
        name: event.toolName || "",
        input: event.toolInput || "",
        toolId: event.toolId || "",
        isMainThread: event.isMainThread,
      });
      break;

    case "tool_result":
      send(ws, {
        type: "assistant:tool_result",
        sessionId,
        toolId: event.toolId || "",
        output: event.toolOutput || "",
        filePath: event.filePath,
      });
      break;

    case "message_done":
      if (event.message) {
        send(ws, {
          type: "assistant:message_done",
          sessionId,
          message: event.message,
        });
      }
      break;

    case "tool_children":
      send(ws, {
        type: "assistant:tool_children",
        sessionId,
        messageId: event.messageId || "",
        toolId: event.toolId || "",
        children: event.children || [],
      });
      break;

    case "tool_progress":
      send(ws, {
        type: "assistant:tool_progress",
        sessionId,
        toolId: event.toolId || "",
        content: event.text || "",
      });
      break;

    case "rate_limit":
      if (event.rateLimitInfo) {
        send(ws, {
          type: "session:rate_limit",
          sessionId,
          status: event.rateLimitInfo.status,
          retryAfterMs: event.rateLimitInfo.retryAfterMs,
        });
      }
      break;

    case "prompt_suggestion":
      if (event.suggestions) {
        send(ws, {
          type: "session:suggestions",
          sessionId,
          suggestions: event.suggestions,
        });
      }
      break;

    case "init":
      if (event.initData) {
        sessionManager.setInitData(sessionId, event.initData);
        send(ws, {
          type: "session:init",
          sessionId,
          data: event.initData,
        });
      }
      break;

    case "task_update":
      if (event.taskInfo) {
        const isProgress = event.taskInfo.status === "progress";
        send(ws, {
          type: "session:task_update",
          sessionId,
          task: {
            taskId: event.taskInfo.taskId,
            toolUseId: event.taskInfo.toolUseId,
            status: isProgress ? "running" : (event.taskInfo.status as "running" | "completed"),
            title: isProgress ? undefined : event.taskInfo.description,
            description: event.taskInfo.description,
            activity: isProgress ? event.taskInfo.description : undefined,
            summary: event.taskInfo.summary,
          },
        });
      }
      break;

    case "permission_request": {
      // Auto-allow and pending storage are handled in session-manager
      // before this event reaches us. If we get here, it needs user input.
      const toolName = event.toolName || "";
      const requestId = event.requestId || "";

      if (requestId && event.rawToolInput) {
        pendingPermissions.set(requestId, { toolName, toolInput: event.rawToolInput, permissionSuggestions: event.permissionSuggestions });
      }

      if (toolName === "AskUserQuestion") {
        send(ws, {
          type: "question:request",
          sessionId,
          requestId,
          questions: event.toolInput || "",
        });
      } else {
        const permMsg: ServerMessage & { type: "permission:request" } = {
          type: "permission:request",
          sessionId,
          requestId,
          toolName,
          input: event.toolInput || "",
          suggestions: event.permissionSuggestions as import("@/types").PermissionSuggestion[] | undefined,
        };
        if (toolName === "ExitPlanMode") {
          const planPath = findLatestPlanFile();
          if (planPath) {
            permMsg.planFilePath = planPath;
            permMsg.planContent = readPlanFile(planPath);
          }
        }
        send(ws, permMsg);
      }
      break;
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    logServerMessage(msg);
    ws.send(JSON.stringify(msg));
  }
}
