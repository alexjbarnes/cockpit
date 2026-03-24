"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage, ServerMessage, ToolUse, ContentBlock, PermissionMode, ThinkingLevel, ContextUsage, BackgroundTask, TodoItem, ImageAttachment, DocumentAttachment, TextFileAttachment, InitData } from "@/types";
import { useWebSocket } from "./use-websocket";

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: string;
  suggestions?: import("@/types").PermissionSuggestion[];
}

export interface PendingQuestion {
  requestId: string;
  questions: string;
  answered?: boolean;
}

export interface BtwState {
  question: string;
  answer: string | null;
  loading: boolean;
  error: string | null;
}

interface UseSessionReturn {
  messages: ChatMessage[];
  historyLoaded: boolean;
  isResponding: boolean;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  modelPicker: string | null;
  currentModel: string;
  bypassActive: boolean;
  thinkingLevel: ThinkingLevel;
  contextUsage: ContextUsage | null;
  rateLimitStatus: string | null;
  apiError: string | null;
  suggestions: string[];
  sessionName: string | null;
  initData: InitData | null;
  hasQueuedMessage: boolean;
  queuedMessages: Array<{ id: string; text: string }>;
  queuePaused: boolean;
  backgroundTasks: BackgroundTask[];
  todos: TodoItem[];
  btw: BtwState | null;
  sendMessage: (text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], textFiles?: TextFileAttachment[]) => void;
  interrupt: () => void;
  respondToPermission: (requestId: string, allowed: boolean, permissionMode?: PermissionMode, suggestionIndex?: number) => void;
  respondToQuestion: (requestId: string, answers: Record<string, string>) => void;
  selectModel: (model: string) => void;
  setModel: (model: string) => void;
  setBypassAll: (enabled: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  cancelQueuedMessage: () => void;
  deleteQueuedMessage: (id: string) => void;
  editQueuedMessage: (id: string) => void;
  resumeQueue: () => void;
  restoredText: string | null;
  clearRestoredText: () => void;
  dismissBtw: () => void;
  retry: () => void;
}

export function useSession(sessionId: string, cwd?: string): UseSessionReturn {
  const { send, subscribe, connected } = useWebSocket();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[]>([]);
  const [modelPicker, setModelPicker] = useState<string | null>(null);
  const [currentModel, setCurrentModel] = useState("sonnet");
  const [bypassActive, setBypassActive] = useState(false);
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>("high");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [rateLimitStatus, setRateLimitStatus] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [initData, setInitData] = useState<InitData | null>(null);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [btw, setBtw] = useState<BtwState | null>(null);

  const [hasQueuedMessage, setHasQueuedMessage] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<Array<{ id: string; text: string }>>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [restoredText, setRestoredText] = useState<string | null>(null);
  const isRespondingRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const currentModelRef = useRef(currentModel);

  // Track the in-progress assistant message being streamed
  const streamingRef = useRef<{
    content: string;
    toolUses: ToolUse[];
    blocks: ContentBlock[];
  } | null>(null);

  // Track nested agent tool calls
  const agentStackRef = useRef<ToolUse[]>([]);

  // Track the last server-assigned message ID for delta history on reconnect.
  // Using IDs instead of counts avoids drift when locally-generated messages
  // (optimistic user messages, queued injections) have different IDs than
  // what the server stores.
  const lastServerMsgIdRef = useRef<string | null>(null);

  // Queue of messages sent while the session was responding.
  // Each is injected into the UI when the server confirms delivery
  // via session:queued sentText. Using an array (not a single ref)
  // so rapid-fire messages don't overwrite each other.
  const queuedTextsRef = useRef<Array<{ text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[]; textFiles?: TextFileAttachment[] }>>([]);
  const loadedSessionRef = useRef<string | null>(null);

  // Reset when switching sessions
  if (loadedSessionRef.current !== null && loadedSessionRef.current !== sessionId) {
    lastServerMsgIdRef.current = null;
    queuedTextsRef.current = [];
    loadedSessionRef.current = null;
  }

  // Keep refs in sync for use inside callbacks
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { currentModelRef.current = currentModel; }, [currentModel]);

  // Send session:connect whenever WS (re)connects
  useEffect(() => {
    if (connected) {
      // Clear stale client-side state before server re-sends current state
      setPendingPermissions([]);
      setPendingQuestions([]);
      const isReconnect = loadedSessionRef.current === sessionId;
      send({
        type: "session:connect",
        sessionId,
        cwd: cwd || undefined,
        lastMessageId: isReconnect ? lastServerMsgIdRef.current : undefined,
      });
    }
  }, [connected, sessionId, cwd, send]);

  useEffect(() => {
    const unsub = subscribe((msg: ServerMessage) => {
      if ("sessionId" in msg && msg.sessionId !== sessionId) return;

      switch (msg.type) {
        case "history": {
          // Update last known server message ID from the history payload
          const serverMsgs = msg.messages as ChatMessage[];
          if (serverMsgs.length > 0) {
            lastServerMsgIdRef.current = serverMsgs[serverMsgs.length - 1].id;
          }

          if (msg.delta) {
            // Delta: reconnect happened. Reset streaming state so the
            // streaming_snapshot that follows starts fresh and doesn't
            // duplicate content already present in the delta messages.
            streamingRef.current = null;
            agentStackRef.current = [];
            setMessages((prev) => {
              const filtered = prev.filter((m) => m.id !== "streaming");
              if (serverMsgs.length === 0) {
                if (filtered.length === prev.length) return prev;
                return filtered;
              }
              const existingIds = new Set(filtered.map((m) => m.id));
              const newMsgs = serverMsgs.filter((m) => !existingIds.has(m.id));
              if (newMsgs.length === 0 && filtered.length === prev.length) return prev;
              return [...filtered, ...newMsgs];
            });
          } else {
            // Full history: replace everything
            const seen = new Set<string>();
            const deduped = serverMsgs.filter((m) => {
              if (seen.has(m.id)) return false;
              seen.add(m.id);
              return true;
            });
            setMessages(deduped);
            streamingRef.current = null;
            agentStackRef.current = [];
          }

          // Status is bundled with history so it arrives atomically,
          // even if the WS drops before the separate status message.
          if (msg.status) {
            const nowRunning = msg.status === "running";
            setIsResponding(nowRunning);
            isRespondingRef.current = nowRunning;
            if (msg.status === "idle") {
              streamingRef.current = null;
              agentStackRef.current = [];
              setMessages((prev) => prev.filter((m) => m.id !== "streaming"));
              setPendingQuestions([]);
              setRateLimitStatus(null);
            }
          }

          setHistoryLoaded(true);
          loadedSessionRef.current = sessionId;
          break;
        }

        case "session:streaming_snapshot": {
          // Restore in-progress message that wasn't in the transcript yet
          streamingRef.current = {
            content: msg.content,
            toolUses: msg.toolUses,
            blocks: msg.blocks,
          };

          // Rebuild the agent stack from running Agent tool uses in the
          // snapshot. Without this, sub-agent events after reconnect leak
          // into the main thread because agentStackRef is empty.
          agentStackRef.current = msg.toolUses.filter(
            (t: ToolUse) => t.name === "Agent" && t.status === "running"
          );

          const streamMsg: ChatMessage = {
            id: "streaming",
            role: "assistant",
            content: msg.content,
            toolUses: msg.toolUses,
            blocks: msg.blocks,
            timestamp: Date.now(),
          };
          setMessages((prev) => {
            // Remove both the old streaming placeholder and any history
            // message with the same ID as the snapshot. The transcript
            // may contain a stale version of this message (from an
            // intermediate emission) while the snapshot has the latest
            // in-progress state including new tool calls.
            const filtered = prev.filter(
              (m) => m.id !== "streaming" && m.id !== msg.messageId
            );
            return [...filtered, streamMsg];
          });
          break;
        }

        case "assistant:thinking": {
          if (agentStackRef.current.length > 0) break;
          setMessages((prev) => prev.filter((m) => m.id !== "compact-progress"));
          if (!streamingRef.current) {
            streamingRef.current = { content: "", toolUses: [], blocks: [] };
          }
          const tBlocks = streamingRef.current.blocks;
          const lastTBlock = tBlocks[tBlocks.length - 1];
          if (lastTBlock && lastTBlock.type === "thinking") {
            lastTBlock.text += msg.text;
          } else {
            tBlocks.push({ type: "thinking", text: msg.text });
          }

          const tStreaming = streamingRef.current;
          setMessages((prev) => {
            const streamMsg: ChatMessage = {
              id: "streaming",
              role: "assistant",
              content: tStreaming.content,
              toolUses: tStreaming.toolUses,
              blocks: [...tStreaming.blocks],
              timestamp: Date.now(),
            };
            const last = prev[prev.length - 1];
            if (last?.id === "streaming") {
              return [...prev.slice(0, -1), streamMsg];
            }
            return [...prev, streamMsg];
          });
          break;
        }

        case "assistant:text": {
          if (agentStackRef.current.length > 0) break;
          setMessages((prev) => prev.filter((m) => m.id !== "compact-progress"));
          if (!streamingRef.current) {
            streamingRef.current = { content: "", toolUses: [], blocks: [] };
          }
          streamingRef.current.content += msg.text;

          // Append to last text block or create new one
          const blocks = streamingRef.current.blocks;
          const lastBlock = blocks[blocks.length - 1];
          if (lastBlock && lastBlock.type === "text") {
            lastBlock.text += msg.text;
          } else {
            blocks.push({ type: "text", text: msg.text });
          }

          const streaming = streamingRef.current;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const streamMsg: ChatMessage = {
              id: "streaming",
              role: "assistant",
              content: streaming.content,
              toolUses: streaming.toolUses,
              blocks: [...streaming.blocks],
              timestamp: Date.now(),
            };
            if (last?.id === "streaming") {
              return [...prev.slice(0, -1), streamMsg];
            }
            return [...prev, streamMsg];
          });
          break;
        }

        case "assistant:tool_use": {
          setMessages((prev) => prev.filter((m) => m.id !== "compact-progress"));
          if (!streamingRef.current) {
            streamingRef.current = { content: "", toolUses: [], blocks: [] };
          }
          const existing = streamingRef.current.toolUses.find(
            (t) => t.id === msg.toolId && t.status === "running"
          );
          if (existing) {
            existing.input = msg.input;
            existing.status = "done";
          } else {
            const tool: ToolUse = {
              id: msg.toolId || msg.name + "-" + Date.now(),
              name: msg.name,
              input: msg.input || "",
              output: "",
              status: msg.input ? "done" : "running",
            };

            const isAgent = tool.name === "Agent";
            const stack = agentStackRef.current;
            const isMainThread = msg.isMainThread !== false;

            // Tools from the main thread are top-level, even when
            // agents are running in parallel. Only sub-agent tools
            // (isMainThread=false) become children.
            if (stack.length > 0 && !isMainThread) {
              const parent = stack[stack.length - 1];
              if (!parent.children) parent.children = [];
              parent.children.push(tool);
            } else {
              streamingRef.current.toolUses.push(tool);
              streamingRef.current.blocks.push({ type: "tool_use", toolUse: tool });
            }

            if (isAgent) {
              stack.push(tool);
            }
          }

          const streaming = streamingRef.current;
          setMessages((prev) => {
            const streamMsg: ChatMessage = {
              id: "streaming",
              role: "assistant",
              content: streaming.content,
              toolUses: [...streaming.toolUses],
              blocks: [...streaming.blocks],
              timestamp: Date.now(),
            };
            const last = prev[prev.length - 1];
            if (last?.id === "streaming") {
              return [...prev.slice(0, -1), streamMsg];
            }
            return [...prev, streamMsg];
          });
          break;
        }

        case "assistant:tool_result": {
          if (!streamingRef.current) break;

          const stack = agentStackRef.current;
          // Find the agent anywhere in the stack, not just the top.
          // Parallel agents complete in arbitrary order.
          const agentIdx = stack.findIndex((a) => a.id === msg.toolId);
          if (agentIdx !== -1) {
            stack[agentIdx].output = msg.output;
            if (msg.filePath) stack[agentIdx].filePath = msg.filePath;
            stack[agentIdx].status = "done";
            stack.splice(agentIdx, 1);
          } else if (stack.length > 0) {
            // Search all agents' children, not just the top agent
            for (const agent of stack) {
              const child = agent.children?.find((t) => t.id === msg.toolId);
              if (child) {
                child.output = msg.output;
                if (msg.filePath) child.filePath = msg.filePath;
                child.status = "done";
                break;
              }
            }
          } else {
            const tool = streamingRef.current.toolUses.find(
              (t) => t.id === msg.toolId
            );
            if (tool) {
              tool.output = msg.output;
              if (msg.filePath) tool.filePath = msg.filePath;
              tool.status = "done";
            }
          }

          const streaming = streamingRef.current;
          setMessages((prev) => {
            const streamMsg: ChatMessage = {
              id: "streaming",
              role: "assistant",
              content: streaming.content,
              toolUses: [...streaming.toolUses],
              blocks: [...streaming.blocks],
              timestamp: Date.now(),
            };
            const last = prev[prev.length - 1];
            if (last?.id === "streaming") {
              return [...prev.slice(0, -1), streamMsg];
            }
            return [...prev, streamMsg];
          });
          break;
        }

        case "assistant:message_done": {
          const streamedToolUses = streamingRef.current?.toolUses || [];
          const streamedBlocks = streamingRef.current?.blocks || [];
          streamingRef.current = null;
          agentStackRef.current = [];
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== "streaming");
            if (filtered.some((m) => m.id === msg.message.id)) return filtered;
            const finalMessage = { ...msg.message };
            if (finalMessage.toolUses.length === 0 && streamedToolUses.length > 0) {
              finalMessage.toolUses = streamedToolUses;
            }
            if ((!finalMessage.blocks || finalMessage.blocks.length === 0) && streamedBlocks.length > 0) {
              finalMessage.blocks = streamedBlocks;
            }
            lastServerMsgIdRef.current = finalMessage.id;
            return [...filtered, finalMessage];
          });
          break;
        }

        case "assistant:tool_progress": {
          if (!streamingRef.current) break;

          const stack = agentStackRef.current;
          // Search all agents and their children for progress updates
          const progressAgent = stack.find((a) => a.id === msg.toolId);
          if (progressAgent) {
            progressAgent.output += msg.content;
          } else if (stack.length > 0) {
            let progressFound = false;
            for (const a of stack) {
              const child = a.children?.find((t) => t.id === msg.toolId);
              if (child) {
                child.output += msg.content;
                progressFound = true;
                break;
              }
            }
            if (!progressFound) {
              const tool = streamingRef.current.toolUses.find(
                (t) => t.id === msg.toolId
              );
              if (tool) tool.output += msg.content;
            }
          } else {
            const tool = streamingRef.current.toolUses.find(
              (t) => t.id === msg.toolId
            );
            if (tool) tool.output += msg.content;
          }

          const streaming = streamingRef.current;
          setMessages((prev) => {
            const streamMsg: ChatMessage = {
              id: "streaming",
              role: "assistant",
              content: streaming.content,
              toolUses: [...streaming.toolUses],
              blocks: [...streaming.blocks],
              timestamp: Date.now(),
            };
            const last = prev[prev.length - 1];
            if (last?.id === "streaming") {
              return [...prev.slice(0, -1), streamMsg];
            }
            return [...prev, streamMsg];
          });
          break;
        }

        case "session:rate_limit": {
          if (msg.status === "rate_limited") {
            setRateLimitStatus(msg.status);
          } else {
            setRateLimitStatus(null);
          }
          break;
        }

        case "session:suggestions": {
          setSuggestions(msg.suggestions);
          break;
        }

        case "session:init": {
          setInitData(msg.data);
          break;
        }

        case "session:todos": {
          setTodos(msg.todos);
          break;
        }

        case "session:task_update": {
          setBackgroundTasks((prev) => {
            const existing = prev.find((t) => t.taskId === msg.task.taskId);
            if (existing) {
              return prev.map((t) =>
                t.taskId === msg.task.taskId
                  ? {
                      ...t,
                      status: msg.task.status,
                      description: msg.task.description || t.description,
                      activity: msg.task.activity || t.activity,
                      summary: msg.task.summary || t.summary,
                    }
                  : t
              );
            }
            return [...prev, msg.task];
          });
          if (msg.task.status === "completed") {
            setTimeout(() => {
              setBackgroundTasks((prev) => prev.filter((t) => t.taskId !== msg.task.taskId));
            }, 5000);
          }
          break;
        }

        case "assistant:tool_children": {
          setMessages((prev) => prev.map((m) => {
            if (m.id !== msg.messageId) return m;
            const updatedToolUses = m.toolUses.map((t) =>
              t.id === msg.toolId ? { ...t, children: msg.children } : t
            );
            const updatedBlocks = m.blocks.map((b) =>
              b.type === "tool_use" && b.toolUse.id === msg.toolId
                ? { ...b, toolUse: { ...b.toolUse, children: msg.children } }
                : b
            );
            return { ...m, toolUses: updatedToolUses, blocks: updatedBlocks };
          }));
          break;
        }

        case "session:status": {
          const nowRunning = msg.status === "running";
          setIsResponding(nowRunning);
          isRespondingRef.current = nowRunning;
          if (nowRunning) setApiError(null);
          if (msg.status === "idle") {
            streamingRef.current = null;
            agentStackRef.current = [];
            // Remove stale streaming message that may have survived a WS drop
            setMessages((prev) => prev.filter((m) => m.id !== "streaming"));
            setPendingQuestions([]);
            setRateLimitStatus(null);
            // Clear any background tasks still running - the process has exited
            setBackgroundTasks((prev) => {
              const stale = prev.filter((t) => t.status === "running");
              if (stale.length === 0) return prev;
              return prev.filter((t) => t.status !== "running");
            });
            // Queued messages are injected when the server confirms
            // delivery via session:queued sentText, not here.
          }
          break;
        }

        case "session:error": {
          console.error("Session error:", msg.error);
          streamingRef.current = null;
          agentStackRef.current = [];
          const err = (msg.error as string) || "Unknown error";
          // Extract the human-readable message from JSON if present
          const match = err.match(/"message"\s*:\s*"([^"]+)"/);
          setApiError(match ? match[1] : err.slice(0, 200));
          break;
        }

        case "session:queued": {
          setHasQueuedMessage(msg.count > 0);
          if (msg.messages) setQueuedMessages(msg.messages);
          if (msg.paused !== undefined) setQueuePaused(msg.paused);
          if (msg.cancelledText) {
            setRestoredText(msg.cancelledText);
            const q = queuedTextsRef.current;
            const idx = q.findIndex((m) => m.text === msg.cancelledText);
            if (idx !== -1) q.splice(idx, 1);
          }
          if (msg.editText) {
            setRestoredText(msg.editText);
          }
          // Server confirms it sent a queued message to Claude.
          // Inject the user message bubble now (after the assistant
          // response, before the next response starts streaming).
          if (msg.sentText) {
            const q = queuedTextsRef.current;
            const idx = q.findIndex((m) => m.text === msg.sentText);
            const matched = idx !== -1 ? q.splice(idx, 1)[0] : null;
            const userMsg: ChatMessage = {
              id: "user-queued-" + Date.now(),
              role: "user",
              content: msg.sentText,
              toolUses: [],
              blocks: [],
              timestamp: Date.now(),
              images: matched?.images,
              documents: matched?.documents,
              textFiles: matched?.textFiles,
            };
            setMessages((prev) => [...prev, userMsg]);
          }
          break;
        }

        case "session:clear": {
          setMessages([]);
          lastServerMsgIdRef.current = null;
          streamingRef.current = null;
          agentStackRef.current = [];
          setBypassActive(false);
          setBackgroundTasks([]);
          setTodos([]);
          setHasQueuedMessage(false);
          setQueuedMessages([]);
          setQueuePaused(false);
          setPendingPermissions([]);
          setPendingQuestions([]);
          break;
        }

        case "session:system": {
          const pickerPrefix = "__model_picker::";
          if (msg.text.startsWith(pickerPrefix)) {
            const model = msg.text.slice(pickerPrefix.length);
            setModelPicker(model);
            setCurrentModel(model);
            break;
          }
          const modelPrefix = "__model::";
          if (msg.text.startsWith(modelPrefix)) {
            setCurrentModel(msg.text.slice(modelPrefix.length));
            break;
          }
          const bypassPrefix = "__bypass_state::";
          if (msg.text.startsWith(bypassPrefix)) {
            setBypassActive(msg.text.slice(bypassPrefix.length) === "on");
            break;
          }
          const thinkingPrefix = "__thinking_level::";
          if (msg.text.startsWith(thinkingPrefix)) {
            const level = msg.text.slice(thinkingPrefix.length) as ThinkingLevel;
            setThinkingLevelState(level);
            const sysMsg: ChatMessage = {
              id: "thinking-" + Date.now(),
              role: "system",
              content: `Thinking: ${level}`,
              toolUses: [],
              blocks: [],
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, sysMsg]);
            break;
          }
          if (msg.text === "__compact_boundary__") {
            setMessages((prev) => {
              const doneId = "compact-done-" + Date.now();
              const hasProgress = prev.some((m) => m.id === "compact-progress");
              if (hasProgress) {
                return prev.map((m) =>
                  m.id === "compact-progress"
                    ? { ...m, id: doneId, content: "__compacted__" }
                    : m
                );
              }
              return [...prev, {
                id: doneId,
                role: "system" as const,
                content: "__compacted__",
                toolUses: [],
                blocks: [],
                timestamp: Date.now(),
              }];
            });
            break;
          }
          const compactPrefix = "__compact::";
          if (msg.text.startsWith(compactPrefix)) {
            const state = msg.text.slice(compactPrefix.length);
            if (state === "start") {
              setMessages((prev) => {
                if (prev.some((m) => m.id === "compact-progress")) return prev;
                return [...prev, {
                  id: "compact-progress",
                  role: "system" as const,
                  content: "__compacting__",
                  toolUses: [],
                  blocks: [],
                  timestamp: Date.now(),
                }];
              });
            } else if (state === "done") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === "compact-progress"
                    ? { ...m, id: "compact-done-" + Date.now(), content: "__compacted__" }
                    : m
                )
              );
            }
            break;
          }
          // Filter out internal system messages (debug-only events forwarded from event-parser)
          if (msg.text.startsWith("__system::")) break;
          const sysMsg: ChatMessage = {
            id: "system-" + Date.now(),
            role: "system",
            content: msg.text,
            toolUses: [],
            blocks: [],
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, sysMsg]);
          break;
        }

        case "session:info_updated": {
          setSessionName(msg.info.name);
          if (msg.info.model) {
            setCurrentModel(msg.info.model);
          }
          break;
        }

        case "session:usage": {
          setContextUsage(msg.usage);
          break;
        }

        case "permission:request": {
          setPendingPermissions((prev) => [
            ...prev,
            { requestId: msg.requestId, toolName: msg.toolName, input: msg.input, suggestions: msg.suggestions },
          ]);
          break;
        }

        case "question:request": {
          setPendingQuestions((prev) => [
            ...prev,
            { requestId: msg.requestId, questions: msg.questions },
          ]);
          break;
        }

      }
    });

    return unsub;
  }, [sessionId, send, subscribe]);

  // HTTP fallback: when session is "running" but WebSocket keeps dropping,
  // poll the REST endpoint to detect if the CLI actually finished.
  // This covers the case where the "idle" status event was sent to a dead WS.
  const lastEventRef = useRef(0);

  const checkSessionViaHttp = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/sessions/${sessionId}?${params}`);
      if (!res.ok) {
        console.warn(`[fallback] HTTP check failed (${res.status})`);
        return;
      }
      const data = await res.json();

      if (data.session.status === "idle") {
        console.log("[fallback] session is idle, recovering");
        const seen = new Set<string>();
        const deduped = (data.messages as ChatMessage[]).filter((m: ChatMessage) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        setMessages(deduped);
        if (deduped.length > 0) {
          lastServerMsgIdRef.current = deduped[deduped.length - 1].id;
        }
        setIsResponding(false);
        isRespondingRef.current = false;
        streamingRef.current = null;
        agentStackRef.current = [];
      }
    } catch {
      // Network error - will retry on next interval
    }
  }, [sessionId, cwd]);

  useEffect(() => {
    if (!isResponding) {
      lastEventRef.current = 0;
      return;
    }

    // Track when we last received a streaming event
    lastEventRef.current = Date.now();
    const handler = (msg: ServerMessage) => {
      if ("sessionId" in msg && msg.sessionId === sessionId) {
        if (msg.type === "assistant:text" || msg.type === "assistant:thinking" ||
            msg.type === "assistant:tool_use" || msg.type === "assistant:tool_result" ||
            msg.type === "session:status") {
          lastEventRef.current = Date.now();
        }
      }
    };
    const unsub = subscribe(handler);

    const poll = setInterval(async () => {
      // Only poll if no events received in the last 10 seconds
      if (Date.now() - lastEventRef.current < 10000) return;
      console.log("[fallback] no events for 10s, checking session via HTTP");
      await checkSessionViaHttp();
    }, 5000);

    // Also check when page becomes visible while we think we're responding
    const onVisible = () => {
      if (document.visibilityState === "visible" && isRespondingRef.current) {
        console.log("[fallback] page visible while responding, checking session");
        checkSessionViaHttp();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      unsub();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isResponding, sessionId, cwd, subscribe, checkSessionViaHttp]);

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], textFiles?: TextFileAttachment[]) => {
      // Inline text file contents into the API text but keep structured data on the message for rendering
      let apiText = text;
      if (textFiles?.length) {
        const fileParts = textFiles.map((f) => `<file path="${f.name}">\n${f.content}\n</file>`);
        apiText = fileParts.join("\n\n") + (text ? "\n\n" + text : "");
      }

      const isBtw = isRespondingRef.current && /^\/btw\s/i.test(text.trim());

      // /btw: side question via separate API call, shown in overlay
      if (isBtw) {
        const btwText = text.trim().replace(/^\/btw\s+/i, "");
        if (!btwText) return;
        setBtw({ question: btwText, answer: null, loading: true, error: null });

        const context = messagesRef.current
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

        fetch("/api/btw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: btwText, context, model: currentModelRef.current, cwd }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data.error) {
              setBtw((prev) => prev ? { ...prev, loading: false, error: data.error } : null);
            } else {
              setBtw((prev) => prev ? { ...prev, loading: false, answer: data.answer } : null);
            }
          })
          .catch((err) => {
            setBtw((prev) => prev ? { ...prev, loading: false, error: err.message } : null);
          });
        return;
      }

      // Queue message server-side when responding
      if (isRespondingRef.current) {
        queuedTextsRef.current.push({ text, images, documents, textFiles });
        send({
          type: "message:send",
          sessionId,
          text: apiText,
          images: images?.length ? images : undefined,
          documents: documents?.length ? documents : undefined,
        });
        return;
      }

      // If queue was paused and user sends a new message, clear local state.
      // The server discards the paused queue when it receives the new message.
      if (queuePaused) {
        queuedTextsRef.current = [];
        setQueuedMessages([]);
        setQueuePaused(false);
        setHasQueuedMessage(false);
      }

      const userMsg: ChatMessage = {
        id: "user-" + Date.now(),
        role: "user",
        content: text,
        toolUses: [],
        blocks: [],
        timestamp: Date.now(),
        images: images?.length ? images : undefined,
        documents: documents?.length ? documents : undefined,
        textFiles: textFiles?.length ? textFiles : undefined,
      };
      setMessages((prev) => [...prev, userMsg]);
      setSuggestions([]);
      send({
        type: "message:send",
        sessionId,
        text: apiText,
        images: images?.length ? images : undefined,
        documents: documents?.length ? documents : undefined,
      });
    },
    [send, sessionId, queuePaused]
  );

  const interrupt = useCallback(() => {
    send({ type: "session:interrupt", sessionId });
  }, [send, sessionId]);

  const respondToPermission = useCallback(
    (requestId: string, allowed: boolean, permissionMode?: PermissionMode, suggestionIndex?: number) => {
      send({ type: "permission:response", sessionId, requestId, allowed, permissionMode, suggestionIndex });
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [send, sessionId]
  );

  const respondToQuestion = useCallback(
    (requestId: string, answers: Record<string, string>) => {
      send({ type: "question:response", sessionId, requestId, answers });
      setPendingQuestions((prev) =>
        prev.map((q) => q.requestId === requestId ? { ...q, answered: true } : q)
      );
    },
    [send, sessionId]
  );

  const selectModel = useCallback(
    (model: string) => {
      setModelPicker(null);
      setCurrentModel(model);
      send({ type: "message:send", sessionId, text: `/model ${model}` });
    },
    [send, sessionId]
  );

  const setModel = useCallback(
    (model: string) => {
      setCurrentModel(model);
      send({ type: "session:set_model", sessionId, model });
    },
    [send, sessionId]
  );

  const setBypassAll = useCallback(
    (enabled: boolean) => {
      setBypassActive(enabled);
      send({ type: "permission:set_bypass", sessionId, enabled });
    },
    [send, sessionId]
  );

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevelState(level);
      send({ type: "session:set_thinking", sessionId, level });
    },
    [send, sessionId]
  );

  const cancelQueuedMessage = useCallback(() => {
    send({ type: "message:cancel_queued", sessionId });
  }, [send, sessionId]);

  const deleteQueuedMessage = useCallback((id: string) => {
    send({ type: "message:delete_queued", sessionId, messageId: id });
  }, [send, sessionId]);

  const editQueuedMessage = useCallback((id: string) => {
    send({ type: "message:edit_queued", sessionId, messageId: id });
  }, [send, sessionId]);

  const resumeQueue = useCallback(() => {
    send({ type: "message:resume_queue", sessionId });
  }, [send, sessionId]);

  const clearRestoredText = useCallback(() => {
    setRestoredText(null);
  }, []);

  const dismissBtw = useCallback(() => {
    const current = btw;
    if (current?.answer) {
      const ts = Date.now();
      setMessages((prev) => [
        ...prev,
        { id: `btw-q-${ts}`, role: "user" as const, content: `[side question] ${current.question}`, toolUses: [], blocks: [], timestamp: ts },
        { id: `btw-a-${ts}`, role: "assistant" as const, content: current.answer!, toolUses: [], blocks: [], timestamp: ts + 1 },
      ]);
    }
    setBtw(null);
  }, [btw]);

  const retry = useCallback(() => {
    setApiError(null);
    send({ type: "message:send", sessionId, text: "Continue from where you left off." });
  }, [send, sessionId]);

  return { messages, historyLoaded, isResponding, pendingPermissions, pendingQuestions, modelPicker, currentModel, bypassActive, thinkingLevel, contextUsage, rateLimitStatus, apiError, suggestions, sessionName, initData, hasQueuedMessage, queuedMessages, queuePaused, backgroundTasks, todos, btw, sendMessage, interrupt, respondToPermission, respondToQuestion, selectModel, setModel, setBypassAll, setThinkingLevel, cancelQueuedMessage, deleteQueuedMessage, editQueuedMessage, resumeQueue, restoredText, clearRestoredText, dismissBtw, retry };
}
