"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage, ServerMessage, ToolUse, ContentBlock, PermissionMode, ThinkingLevel, ContextUsage, BackgroundTask, TodoItem, ImageAttachment, DocumentAttachment, TextFileAttachment, InitData } from "@/types";
import { useWebSocket } from "./use-websocket";

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: string;
}

export interface PendingQuestion {
  requestId: string;
  questions: string;
  answered?: boolean;
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
  suggestions: string[];
  sessionName: string | null;
  initData: InitData | null;
  hasQueuedMessage: boolean;
  backgroundTasks: BackgroundTask[];
  todos: TodoItem[];
  sendMessage: (text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], textFiles?: TextFileAttachment[]) => void;
  interrupt: () => void;
  respondToPermission: (requestId: string, allowed: boolean, permissionMode?: PermissionMode) => void;
  respondToQuestion: (requestId: string, answers: Record<string, string>) => void;
  selectModel: (model: string) => void;
  setModel: (model: string) => void;
  setBypassAll: (enabled: boolean) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  cancelQueuedMessage: () => string | null;
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
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [initData, setInitData] = useState<InitData | null>(null);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [todos, setTodos] = useState<TodoItem[]>([]);

  // Queued message to send when Claude finishes responding
  const queuedRef = useRef<{ text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] } | null>(null);
  const [hasQueuedMessage, setHasQueuedMessage] = useState(false);
  const isRespondingRef = useRef(false);

  // Track the in-progress assistant message being streamed
  const streamingRef = useRef<{
    content: string;
    toolUses: ToolUse[];
    blocks: ContentBlock[];
  } | null>(null);

  // Track nested agent tool calls
  const agentStackRef = useRef<ToolUse[]>([]);


  // Re-send session:connect whenever WS (re)connects
  useEffect(() => {
    if (connected) {
      // Clear stale client-side state before server re-sends current state
      setPendingPermissions([]);
      setPendingQuestions([]);
      send({ type: "session:connect", sessionId, cwd: cwd || undefined });
    }
  }, [connected, sessionId, cwd, send]);

  useEffect(() => {
    // Queue session:connect for initial connection (before WS is open)
    send({ type: "session:connect", sessionId, cwd: cwd || undefined });

    const unsub = subscribe((msg: ServerMessage) => {
      if ("sessionId" in msg && msg.sessionId !== sessionId) return;

      switch (msg.type) {
        case "history": {
          const seen = new Set<string>();
          const deduped = msg.messages.filter((m: ChatMessage) => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          });
          setMessages(deduped);
          setHistoryLoaded(true);
          streamingRef.current = null;
          break;
        }

        case "assistant:thinking": {
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

            if (stack.length > 0) {
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
          const topAgent = stack[stack.length - 1];

          if (topAgent && topAgent.id === msg.toolId) {
            topAgent.output = msg.output;
            if (msg.filePath) topAgent.filePath = msg.filePath;
            topAgent.status = "done";
            stack.pop();
          } else if (stack.length > 0) {
            const parent = stack[stack.length - 1];
            const child = parent.children?.find((t) => t.id === msg.toolId);
            if (child) {
              child.output = msg.output;
              if (msg.filePath) child.filePath = msg.filePath;
              child.status = "done";
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
            return [...filtered, finalMessage];
          });
          break;
        }

        case "assistant:tool_progress": {
          if (!streamingRef.current) break;

          const stack = agentStackRef.current;
          const topAgent = stack[stack.length - 1];

          if (topAgent && topAgent.id === msg.toolId) {
            topAgent.output += msg.content;
          } else if (stack.length > 0) {
            const parent = stack[stack.length - 1];
            const child = parent.children?.find((t) => t.id === msg.toolId);
            if (child) child.output += msg.content;
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
          if (msg.status === "idle") {
            streamingRef.current = null;
            agentStackRef.current = [];
            setPendingQuestions([]);
            setRateLimitStatus(null);

            // Flush queued message
            const queued = queuedRef.current;
            if (queued) {
              queuedRef.current = null;
              setHasQueuedMessage(false);
              const userMsg: ChatMessage = {
                id: "user-" + Date.now(),
                role: "user",
                content: queued.text,
                toolUses: [],
                blocks: [],
                timestamp: Date.now(),
                images: queued.images,
                documents: queued.documents,
              };
              setMessages((prev) => [...prev, userMsg]);
              setSuggestions([]);
              send({
                type: "message:send",
                sessionId,
                text: queued.text,
                images: queued.images,
                documents: queued.documents,
              });
            }
          }
          break;
        }

        case "session:error": {
          console.error("Session error:", msg.error);
          streamingRef.current = null;
          agentStackRef.current = [];
          break;
        }

        case "session:clear": {
          setMessages([]);
          streamingRef.current = null;
          agentStackRef.current = [];
          setBypassActive(false);
          setBackgroundTasks([]);
          setTodos([]);
          queuedRef.current = null;
          setHasQueuedMessage(false);
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
            { requestId: msg.requestId, toolName: msg.toolName, input: msg.input },
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

  const sendMessage = useCallback(
    (text: string, images?: ImageAttachment[], documents?: DocumentAttachment[], textFiles?: TextFileAttachment[]) => {
      // Inline text file contents into the API text but keep structured data on the message for rendering
      let apiText = text;
      if (textFiles?.length) {
        const fileParts = textFiles.map((f) => `<file path="${f.name}">\n${f.content}\n</file>`);
        apiText = fileParts.join("\n\n") + (text ? "\n\n" + text : "");
      }

      const isBtw = isRespondingRef.current && /^\/btw\s/i.test(text.trim());

      // /btw: strip prefix, send immediately mid-stream
      if (isBtw) {
        const btwText = text.trim().replace(/^\/btw\s+/i, "");
        if (!btwText) return;
        const userMsg: ChatMessage = {
          id: "user-" + Date.now(),
          role: "user",
          content: btwText,
          toolUses: [],
          blocks: [],
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);
        send({ type: "message:send", sessionId, text: btwText });
        return;
      }

      // Queue non-btw messages while responding
      if (isRespondingRef.current) {
        queuedRef.current = {
          text: apiText,
          images: images?.length ? images : undefined,
          documents: documents?.length ? documents : undefined,
        };
        setHasQueuedMessage(true);
        return;
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
    [send, sessionId]
  );

  const interrupt = useCallback(() => {
    send({ type: "session:interrupt", sessionId });
  }, [send, sessionId]);

  const respondToPermission = useCallback(
    (requestId: string, allowed: boolean, permissionMode?: PermissionMode) => {
      send({ type: "permission:response", sessionId, requestId, allowed, permissionMode });
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

  const cancelQueuedMessage = useCallback((): string | null => {
    const text = queuedRef.current?.text ?? null;
    queuedRef.current = null;
    setHasQueuedMessage(false);
    return text;
  }, []);

  return { messages, historyLoaded, isResponding, pendingPermissions, pendingQuestions, modelPicker, currentModel, bypassActive, thinkingLevel, contextUsage, rateLimitStatus, suggestions, sessionName, initData, hasQueuedMessage, backgroundTasks, todos, sendMessage, interrupt, respondToPermission, respondToQuestion, selectModel, setModel, setBypassAll, setThinkingLevel, cancelQueuedMessage };
}
