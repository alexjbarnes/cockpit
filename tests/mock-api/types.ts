// Anthropic Messages API request/response types

export interface ApiRequest {
  model: string;
  max_tokens: number;
  stream: boolean;
  messages: ApiMessage[];
  system?: string | ApiTextBlock[];
  tools?: ApiTool[];
  metadata?: Record<string, unknown>;
}

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
}

export type ApiContentBlock = ApiTextBlock | ApiToolUseBlock | ApiToolResultBlock;

export interface ApiTextBlock {
  type: "text";
  text: string;
}

export interface ApiToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ApiToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ApiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ── SSE event types ────────────────────────────────────────────────────

export interface MessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: unknown[];
    model: string;
    stop_reason: null;
    stop_sequence: null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block:
    | {
        type: "text";
        text: string;
      }
    | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      };
}

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: TextDelta | InputJsonDelta;
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
    stop_sequence: string | null;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface MessageStopEvent {
  type: "message_stop";
}

export type SSEScriptEvent = {
  event: string;
  data: Record<string, unknown>;
};

// ── Mock server control API ─────────────────────────────────────────────

export interface TurnScript {
  events: SSEScriptEvent[];
}
