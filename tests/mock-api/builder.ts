// Builder helpers for constructing SSE response scripts

import type { SSEScriptEvent } from "./types";

let seq = 0;
function msgId(): string {
  return `mock_msg_${++seq}`;
}

function toolId(): string {
  return `mock_toolu_${++seq}`;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

export interface ResponseOptions {
  /** Model echoed back in message_start. Defaults to claude-sonnet-4-6. Tests can override per turn. */
  model?: string;
}

export function textResponse(text: string, stopReason: "end_turn" | "tool_use" = "end_turn", opts: ResponseOptions = {}): SSEScriptEvent[] {
  const events: SSEScriptEvent[] = [];
  const mid = msgId();

  events.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: mid,
        type: "message",
        role: "assistant",
        content: [],
        model: opts.model ?? DEFAULT_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  });

  events.push({
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });

  events.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });

  events.push({
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  });

  const tokens = Math.ceil(text.length / 4);

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 100, output_tokens: tokens },
    },
  });

  events.push({
    event: "message_stop",
    data: { type: "message_stop" },
  });

  return events;
}

export function toolUseResponse(toolName: string, input: Record<string, unknown>, opts: ResponseOptions = {}): SSEScriptEvent[] {
  const events: SSEScriptEvent[] = [];
  const mid = msgId();
  const tid = toolId();
  const inputJson = JSON.stringify(input);

  events.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: mid,
        type: "message",
        role: "assistant",
        content: [],
        model: opts.model ?? DEFAULT_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  });

  // Optional: short text block before the tool call
  events.push({
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  events.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll help with that." } },
  });
  events.push({
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  });

  // Tool use block
  events.push({
    event: "content_block_start",
    data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: tid, name: toolName, input: {} } },
  });
  events.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson } },
  });
  events.push({
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 1 },
  });

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 150, output_tokens: 40 },
    },
  });

  events.push({
    event: "message_stop",
    data: { type: "message_stop" },
  });

  return events;
}

export function messageStop(usage?: { input_tokens: number; output_tokens: number }): SSEScriptEvent[] {
  const events: SSEScriptEvent[] = [];

  if (usage) {
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
      },
    });
  }

  events.push({
    event: "message_stop",
    data: { type: "message_stop" },
  });

  return events;
}

export function errorResponse(status: number, message: string): SSEScriptEvent[] {
  // Non-streaming error response (server returns JSON error, not SSE)
  return [
    {
      event: "__error__",
      data: { status, body: { error: { type: "api_error", message } } },
    },
  ];
}

export function resetSeq(): void {
  seq = 0;
}
