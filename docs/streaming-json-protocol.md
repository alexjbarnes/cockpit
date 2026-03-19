# Claude Code Streaming JSON Protocol

> Reference for `--output-format stream-json` events emitted by the CLI.

## Output Format Options

- `text` (default): Plain text output
- `json`: Single JSON object at end with result, session_id, metadata
- `stream-json`: Newline-delimited JSON, one event per line with a `type` field

## Event Types

### `system/init` - Session initialization

First event emitted. Contains session metadata.

```typescript
{
  type: "system";
  subtype: "init";
  uuid: string;
  session_id: string;
  model: string;
  cwd: string;
  claude_code_version: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  slash_commands: string[];
  agents?: string[];
  skills: string[];
  plugins: { name: string; path: string }[];
  apiKeySource: "user" | "project" | "org" | "temporary" | "oauth";
  output_style: string;
  fast_mode_state: string;
}
```

Note: No `contextWindow` field here. Model name does not include `[1m]` suffix.

### `assistant` - Complete assistant response

```typescript
{
  type: "assistant";
  uuid: string;
  session_id: string;
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
  parent_tool_use_id: string | null;
  error?: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown";
}
```

### `user` - User input / tool results

```typescript
{
  type: "user";
  uuid?: string;
  session_id: string;
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  isReplay?: boolean;  // true when replaying resumed sessions
}
```

### `result` - Final event when agent finishes

```typescript
{
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries";
  uuid: string;
  session_id: string;
  is_error: boolean;
  num_turns: number;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;
  result?: string;           // success only
  errors?: string[];         // error only
  stop_reason: string | null;
  usage: NonNullableUsage;
  modelUsage: { [modelName: string]: ModelUsage };
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;
  fast_mode_state: string;
}
```

### `ModelUsage` - Per-model usage in result events

This is the ONLY place context window size appears in the protocol.

```typescript
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;      // Context window size in tokens
  maxOutputTokens: number;
};
```

**Known issue**: As of CLI v2.1.76, `contextWindow` reports `200000` even when
the model is running with 1M context (e.g. `opus[1m]`). The CLI header shows
"1M context" but `modelUsage.contextWindow` still says 200000.

### `stream_event` - Partial streaming events

Only emitted with `--include-partial-messages` flag.

```typescript
{
  type: "stream_event";
  event: RawMessageStreamEvent;  // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}
```

### `system/compact_boundary` - Auto-compaction marker

```typescript
{
  type: "system";
  subtype: "compact_boundary";
  uuid: string;
  session_id: string;
  compact_metadata: {
    trigger: "manual" | "auto";
    pre_tokens: number;
  };
}
```

### `system/status` - Status changes

```typescript
{
  type: "system";
  subtype: "status";
  status: "compacting" | null;
  permissionMode?: PermissionMode;
  uuid: string;
  session_id: string;
}
```

### `system/api_retry` - API retry on failure

```typescript
{
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "max_output_tokens" | "unknown";
  uuid: string;
  session_id: string;
}
```

### `rate_limit_event` - Rate limit status

```typescript
{
  type: "rate_limit_event";
  rate_limit_info: {
    status: "allowed" | "allowed_warning" | "rejected";
    resetsAt?: number;
    utilization?: number;
  };
  uuid: string;
  session_id: string;
}
```

### `tool_progress` - Tool execution progress

```typescript
{
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
  uuid: string;
  session_id: string;
}
```

### `tool_use_summary` - Tool use summary

```typescript
{
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}
```

### `auth_status` - Authentication status

```typescript
{
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}
```

### `control_request` - Permission prompt

```typescript
{
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id?: string;
    permission_suggestions?: PermissionSuggestion[];
    blocked_path?: string;
    decision_reason?: string;
    agent_id?: string;
    description?: string;
  };
}
```

The `permission_suggestions` array contains pre-built rules that can be passed back as `updatedPermissions` in the control response to persist "always allow" for the tool. See the Permission handling section in [claude-cli-reference.md](./claude-cli-reference.md) for the full response schema.

### `control_response` - Permission response (stdin to CLI)

```typescript
// Success
{
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: PermissionResponse;
  };
}

// Error
{
  type: "control_response";
  response: {
    subtype: "error";
    request_id: string;
    error: string;
    pending_permission_requests?: SDKControlRequest[];
  };
}

// Allow
type PermissionResponse = {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
  toolUseID?: string;
}

// Deny
type PermissionResponse = {
  behavior: "deny";
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
}
```

### `control_cancel_request` - Cancel pending permission (CLI to server)

```typescript
{
  type: "control_cancel_request";
  request_id: string;
}
```

### `keep_alive` - Keepalive (bidirectional)

```typescript
{ type: "keep_alive" }
```

Silently consumed by the SDK. Present on the wire but filtered out before reaching consumers.

### `update_environment_variables` - Set env vars (stdin to CLI)

```typescript
{
  type: "update_environment_variables";
  variables: Record<string, string>;
}
```

### Hook events

```typescript
// Hook started
{ type: "system"; subtype: "hook_started"; hook_id: string; hook_name: string; hook_event: string; }

// Hook progress
{ type: "system"; subtype: "hook_progress"; hook_id: string; hook_name: string; hook_event: string; stdout: string; stderr: string; output: string; }

// Hook response
{ type: "system"; subtype: "hook_response"; hook_id: string; hook_name: string; hook_event: string; output: string; stdout: string; stderr: string; exit_code?: number; outcome: "success" | "error" | "cancelled"; }
```

### Task events

```typescript
// Task started
{ type: "system"; subtype: "task_started"; task_id: string; tool_use_id?: string; description: string; task_type?: "local_bash" | "local_agent" | "remote_agent"; }

// Task progress
{ type: "system"; subtype: "task_progress"; task_id: string; tool_use_id?: string; description: string; usage: { total_tokens: number; tool_uses: number; duration_ms: number }; last_tool_name?: string; }

// Task notification
{ type: "system"; subtype: "task_notification"; task_id: string; tool_use_id?: string; status: "completed" | "failed" | "stopped"; output_file: string; summary: string; usage?: { total_tokens: number; tool_uses: number; duration_ms: number }; }
```

### `prompt_suggestion` - Suggested prompts

```typescript
{
  type: "prompt_suggestion";
  suggestion: string;
  uuid: string;
  session_id: string;
}
```

### `system/files_persisted` - File persistence

```typescript
{
  type: "system";
  subtype: "files_persisted";
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
}
```

## CLI Flags Reference

| Flag | Description |
|------|-------------|
| `--model` | Set model: alias or full name |
| `--output-format` | `text`, `json`, `stream-json` |
| `--include-partial-messages` | Include `stream_event` partial events (requires `-p` + `stream-json`) |
| `--input-format` | `text`, `stream-json` |
| `--print` / `-p` | Non-interactive print mode |
| `--continue` / `-c` | Continue most recent conversation |
| `--resume` / `-r` | Resume session by ID or name |
| `--effort` | `low`, `medium`, `high`, `max` |
| `--max-turns` | Limit agentic turns (print mode) |
| `--max-budget-usd` | Max dollar spend (print mode) |
| `--fallback-model` | Fallback when default overloaded (print mode) |
| `--session-id` | Use specific UUID |
| `--name` / `-n` | Session display name |
| `--dangerously-skip-permissions` | Skip permission prompts |
| `--permission-mode` | Permission mode to start in |
| `--system-prompt` | Replace system prompt |
| `--append-system-prompt` | Append to system prompt |
| `--verbose` | Verbose logging |
| `--debug` | Debug mode |
| `--worktree` / `-w` | Isolated git worktree |

## Context Window and Auto-Compaction

There is no CLI flag to set context window size directly. It is determined by the model selected and whether `[1m]` is appended.

Relevant environment variables:
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` - Override the auto-compact percentage threshold
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` - Auto-compact window setting

## SDK Initialization Response

The `initializationResult` provides model info but NOT context window:

```typescript
type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ("low" | "medium" | "high" | "max")[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
};
```
