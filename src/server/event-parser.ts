import type { ChatMessage, ToolUse } from "@/types";
import { v4 as uuidv4 } from "uuid";

export interface ParsedEvent {
  type: "text_delta" | "thinking" | "tool_use_start" | "tool_done" | "tool_result" | "message_done" | "permission_request" | "system_message" | "tool_children" | "tool_progress" | "rate_limit" | "prompt_suggestion" | "task_update";
  text?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  toolOutput?: string;
  filePath?: string;
  message?: ChatMessage;
  messageId?: string;
  children?: ToolUse[];
  requestId?: string;
  rawToolInput?: Record<string, unknown>;
  rateLimitInfo?: { status: string; retryAfterMs?: number };
  suggestions?: string[];
  taskInfo?: {
    taskId: string;
    toolUseId: string;
    status: "running" | "progress" | "completed";
    description: string;
    summary?: string;
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

interface StreamMessage {
  id?: string;
  content?: ContentBlock[];
  role?: string;
}

interface ToolResult {
  type: string;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

export class EventParser {
  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const type = event.type as string;

    if (type === "assistant") {
      return this.parseAssistantEvent(event);
    }

    if (type === "user") {
      return this.parseUserEvent(event);
    }

    if (type === "result") {
      return this.parseResultEvent(event);
    }

    if (type === "control_request") {
      return this.parseControlRequest(event);
    }

    if (type === "tool_progress") {
      const toolId = event.tool_use_id as string | undefined;
      const content = event.content as string | undefined;
      if (toolId && content) {
        return [{ type: "tool_progress", toolId, text: content }];
      }
      return [];
    }

    if (type === "rate_limit_event") {
      const info = event.rate_limit_info as { status?: string; retry_after_ms?: number } | undefined;
      if (info) {
        return [{ type: "rate_limit", rateLimitInfo: { status: info.status || "unknown", retryAfterMs: info.retry_after_ms } }];
      }
      return [];
    }

    if (type === "prompt_suggestion") {
      const suggestions = (event.suggestions || event.prompt_suggestions) as string[] | undefined;
      if (suggestions?.length) {
        return [{ type: "prompt_suggestion", suggestions }];
      }
      return [];
    }

    if (type === "auth_status") {
      return [{ type: "system_message", text: `__auth::${event.status || "unknown"}` }];
    }

    // tool_use_summary: dropped because tool_result already provides output
    // stream_event: dropped because we use full assistant events
    if (type === "tool_use_summary" || type === "stream_event") {
      return [];
    }

    if (type === "system") {
      const subtype = event.subtype as string | undefined;
      if (subtype === "compact_boundary") {
        return [{ type: "system_message", text: "__compact_boundary__" }];
      }
      if (subtype === "status" && event.status === "compacting") {
        return [{ type: "system_message", text: "__compact::start" }];
      }

      // Refined hook subtypes
      if (subtype === "hook_started") {
        const hookName = (event.hook_name || event.name || "unknown") as string;
        return [{ type: "system_message", text: `__hook::started::${hookName}` }];
      }
      if (subtype === "hook_progress") {
        const content = (event.content || "") as string;
        return [{ type: "system_message", text: `__hook::progress::${content}` }];
      }
      if (subtype === "hook_response") {
        return [{ type: "system_message", text: "__hook::done" }];
      }

      // Structured task events
      if (subtype === "task_started") {
        return [{ type: "task_update", taskInfo: {
          taskId: (event.task_id || "") as string,
          toolUseId: (event.tool_use_id || "") as string,
          status: "running",
          description: (event.description || "") as string,
        } }];
      }
      if (subtype === "task_progress") {
        return [{ type: "task_update", taskInfo: {
          taskId: (event.task_id || "") as string,
          toolUseId: (event.tool_use_id || "") as string,
          status: "progress",
          description: (event.description || "") as string,
        } }];
      }
      if (subtype === "task_notification") {
        return [{ type: "task_update", taskInfo: {
          taskId: (event.task_id || "") as string,
          toolUseId: (event.tool_use_id || "") as string,
          status: "completed",
          description: (event.description || "") as string,
          summary: (event.summary || "") as string,
        } }];
      }

      // Forward all other system events so the debug log captures them
      if (subtype) {
        return [{ type: "system_message", text: `__system::${subtype}` }];
      }
    }

    return [];
  }

  private parseAssistantEvent(event: Record<string, unknown>): ParsedEvent[] {
    const msg = event.message as StreamMessage | undefined;
    if (!msg?.content) return [];

    const events: ParsedEvent[] = [];

    for (const block of msg.content) {
      if (block.type === "thinking" && block.thinking) {
        events.push({ type: "thinking", text: block.thinking });
      } else if (block.type === "text" && block.text) {
        events.push({ type: "text_delta", text: block.text });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_use_start",
          toolName: block.name || "unknown",
          toolId: block.id,
          toolInput: block.input ? JSON.stringify(block.input) : "",
        });
      }
    }

    return events;
  }

  private parseUserEvent(event: Record<string, unknown>): ParsedEvent[] {
    const msg = event.message as StreamMessage | undefined;
    if (!msg?.content || !Array.isArray(msg.content)) return [];

    const events: ParsedEvent[] = [];

    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const output = this.extractToolResultOutput(block);
        const filePath = this.extractFilePath(block);

        events.push({
          type: "tool_result",
          toolId: block.tool_use_id,
          toolOutput: output,
          filePath,
        });
      }
    }

    return events;
  }

  private extractToolResultOutput(block: ContentBlock): string {
    if (typeof block.content === "string") {
      return block.content;
    }

    if (Array.isArray(block.content)) {
      const parts: string[] = [];
      for (const item of block.content) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item.type === "text" && item.text) {
          parts.push(item.text);
        }
      }
      return parts.join("\n");
    }

    return "";
  }

  private extractFilePath(block: ContentBlock): string | undefined {
    if (!Array.isArray(block.content)) return undefined;

    for (const item of block.content) {
      if (typeof item !== "string") {
        const input = item.input as Record<string, unknown> | undefined;
        if (input) {
          if (typeof input.file_path === "string") return input.file_path;
          if (typeof input.filePath === "string") return input.filePath;
          if (typeof input.path === "string") return input.path;
        }
      }
    }

    return undefined;
  }

  private parseControlRequest(event: Record<string, unknown>): ParsedEvent[] {
    const request = event.request as {
      subtype?: string;
      tool_name?: string;
      input?: Record<string, unknown>;
    } | undefined;

    if (request?.subtype === "can_use_tool") {
      return [{
        type: "permission_request",
        requestId: event.request_id as string,
        toolName: request.tool_name || "unknown",
        toolInput: request.input ? JSON.stringify(request.input) : "",
        rawToolInput: request.input,
      }];
    }

    return [];
  }

  private parseResultEvent(event: Record<string, unknown>): ParsedEvent[] {
    const result = event.result as string | undefined;
    const uuid = event.uuid as string | undefined;

    const message: ChatMessage = {
      id: uuid || uuidv4(),
      role: "assistant",
      content: result || "",
      toolUses: [],
      blocks: [],
      timestamp: Date.now(),
    };

    return [{ type: "message_done", message }];
  }
}
