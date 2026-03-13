"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ChatMessage, ServerMessage, ToolUse, ContentBlock } from "@/types";
import { useWebSocket } from "./use-websocket";

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: string;
}

interface UseSessionReturn {
  messages: ChatMessage[];
  isResponding: boolean;
  pendingPermissions: PendingPermission[];
  modelPicker: string | null;
  sendMessage: (text: string) => void;
  interrupt: () => void;
  respondToPermission: (requestId: string, allowed: boolean) => void;
  selectModel: (model: string) => void;
}

export function useSession(sessionId: string, cwd?: string): UseSessionReturn {
  const { send, subscribe, connected } = useWebSocket();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [modelPicker, setModelPicker] = useState<string | null>(null);

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
          setMessages(msg.messages);
          streamingRef.current = null;
          break;
        }

        case "assistant:text": {
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

        case "session:status": {
          setIsResponding(msg.status === "running");
          if (msg.status === "idle") {
            streamingRef.current = null;
            agentStackRef.current = [];
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
          break;
        }

        case "session:system": {
          const pickerPrefix = "__model_picker::";
          if (msg.text.startsWith(pickerPrefix)) {
            setModelPicker(msg.text.slice(pickerPrefix.length));
            break;
          }
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

        case "permission:request": {
          setPendingPermissions((prev) => [
            ...prev,
            { requestId: msg.requestId, toolName: msg.toolName, input: msg.input },
          ]);
          break;
        }
      }
    });

    return unsub;
  }, [sessionId, send, subscribe]);

  const sendMessage = useCallback(
    (text: string) => {
      const userMsg: ChatMessage = {
        id: "user-" + Date.now(),
        role: "user",
        content: text,
        toolUses: [],
        blocks: [],
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      send({ type: "message:send", sessionId, text });
    },
    [send, sessionId]
  );

  const interrupt = useCallback(() => {
    send({ type: "session:interrupt", sessionId });
  }, [send, sessionId]);

  const respondToPermission = useCallback(
    (requestId: string, allowed: boolean) => {
      send({ type: "permission:response", sessionId, requestId, allowed });
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [send, sessionId]
  );

  const selectModel = useCallback(
    (model: string) => {
      setModelPicker(null);
      send({ type: "message:send", sessionId, text: `/model ${model}` });
    },
    [send, sessionId]
  );

  return { messages, isResponding, pendingPermissions, modelPicker, sendMessage, interrupt, respondToPermission, selectModel };
}
