import { v4 as uuidv4 } from "uuid";
import type { ChatMessage } from "@/types";
import type { ParsedEvent } from "./event-parser";
import type { HookEventName } from "./hook-router";

/**
 * Convert a single hook payload from claude into ParsedEvent objects that
 * the existing stream-processor / session emitter pipeline can consume.
 *
 * Pure function: no state, no side effects. The session manager owns
 * status tracking, permission request bookkeeping, and emission.
 *
 * Returns an empty array for events that don't map to a ParsedEvent
 * (e.g. UserPromptSubmit, which only affects status).
 */
export function translateHookEvent(eventName: HookEventName, payload: Record<string, unknown>): ParsedEvent[] {
  switch (eventName) {
    case "PreToolUse":
      return translatePreToolUse(payload);
    case "PostToolUse":
      return translatePostToolUse(payload);
    case "Stop":
      return translateStop(payload);
    case "PermissionRequest":
      return translatePermissionRequest(payload);
    case "Notification":
      return translateNotification(payload);
    case "UserPromptSubmit":
      return [{ type: "system_message", text: "__user_prompt_submit" }];
  }
}

/** PermissionRequest payloads don't carry a request ID; cockpit synthesises one. */
export function newPermissionRequestId(): string {
  return uuidv4();
}

function translatePreToolUse(payload: Record<string, unknown>): ParsedEvent[] {
  const toolName = stringOr(payload.tool_name, "unknown");
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const toolId = stringOr(payload.tool_use_id, "");
  const events: ParsedEvent[] = [
    {
      type: "tool_use_start",
      toolName,
      toolId: toolId || undefined,
      toolInput: toolInput ? JSON.stringify(toolInput) : "",
    },
  ];
  if (toolName === "EnterPlanMode") {
    events.push({ type: "system_message", text: "__permission_mode::plan" });
  }
  return events;
}

function translatePostToolUse(payload: Record<string, unknown>): ParsedEvent[] {
  const toolName = stringOr(payload.tool_name, "unknown");
  const toolId = stringOr(payload.tool_use_id, "");
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;
  const response = payload.tool_response;
  const output = extractToolOutput(response);
  const filePath = extractFilePath(toolInput);
  const events: ParsedEvent[] = [
    {
      type: "tool_result",
      toolId: toolId || undefined,
      toolOutput: output,
      filePath,
    },
  ];
  if (toolName === "ExitPlanMode") {
    events.push({ type: "system_message", text: "__permission_mode::standard" });
  }
  return events;
}

function translateStop(payload: Record<string, unknown>): ParsedEvent[] {
  const text = stringOr(payload.last_assistant_message, "");
  const message: ChatMessage = {
    id: uuidv4(),
    role: "assistant",
    content: text,
    toolUses: [],
    blocks: [],
    timestamp: Date.now(),
  };
  return [{ type: "message_done", message }];
}

function translatePermissionRequest(payload: Record<string, unknown>): ParsedEvent[] {
  const toolName = stringOr(payload.tool_name, "unknown");
  const toolInput = payload.tool_input as Record<string, unknown> | undefined;

  return [
    {
      type: "permission_request",
      requestId: newPermissionRequestId(),
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : "",
      rawToolInput: toolInput,
    },
  ];
}

function translateNotification(payload: Record<string, unknown>): ParsedEvent[] {
  const message = stringOr(payload.message, "");
  if (!message) return [];
  return [{ type: "system_message", text: `__notification::${message}` }];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function extractToolOutput(response: unknown): string {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (typeof response === "object") {
    const obj = response as Record<string, unknown>;
    if (typeof obj.stdout === "string") {
      let out = obj.stdout;
      if (typeof obj.stderr === "string" && obj.stderr.length > 0) out += `\n${obj.stderr}`;
      return out;
    }
    if (typeof obj.content === "string") return obj.content;
    return JSON.stringify(response);
  }
  return String(response);
}

function extractFilePath(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) return undefined;
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.filePath === "string") return toolInput.filePath;
  if (typeof toolInput.path === "string") return toolInput.path;
  return undefined;
}
