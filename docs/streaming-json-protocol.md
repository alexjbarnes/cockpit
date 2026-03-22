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

### `control_request` - Permission prompt (CLI to server)

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

### `control_request` subtypes (server to CLI via stdin)

The server can send `control_request` messages to the CLI on stdin. All share this envelope:

```typescript
{
  type: "control_request";
  request_id: string;
  request: { subtype: string; ... };
}
```

The CLI responds with a `control_response` on stdout for subtypes that return data.

| Subtype | Direction | Description |
|---------|-----------|-------------|
| `interrupt` | server to CLI | Abort the current turn. Process stays alive. |
| `end_session` | server to CLI | End the session gracefully. |
| `set_permission_mode` | server to CLI | Change permission mode mid-session. |
| `set_model` | server to CLI | Change the model mid-session. |
| `set_max_thinking_tokens` | server to CLI | Set max thinking tokens. |
| `initialize` | server to CLI | Initialize an SDK session (hooks, MCP, schema). |
| `mcp_status` | server to CLI | Query MCP server connection status. |
| `mcp_message` | server to CLI | Send JSON-RPC to an MCP server. |
| `mcp_set_servers` | server to CLI | Replace dynamically managed MCP servers. |
| `mcp_reconnect` | server to CLI | Reconnect a disconnected MCP server. |
| `mcp_toggle` | server to CLI | Enable/disable an MCP server. |
| `rewind_files` | server to CLI | Rewind file changes since a message. |
| `cancel_async_message` | server to CLI | Cancel a pending async user message. |
| `stop_task` | server to CLI | Stop a running background task. |
| `apply_flag_settings` | server to CLI | Merge settings into flag settings layer. |
| `get_settings` | server to CLI | Get effective merged settings. |
| `hook_callback` | server to CLI | Deliver a hook callback. |
| `elicitation` | server to CLI | Handle MCP elicitation (user input request). |
| `can_use_tool` | CLI to server | Permission prompt (see above). |

#### `interrupt`

Aborts the current turn without killing the process. The CLI emits a `result` event with `subtype: "error_during_execution"` and stays alive for the next message. Partial streamed content should be discarded.

```typescript
{ subtype: "interrupt" }
```

No response body. The interrupted turn ends with a `result` event.

**Cockpit status:** Used. Replaced SIGINT which killed the process.

#### `end_session`

Graceful shutdown. The CLI aborts any in-flight API call, cleans up state, sends a success response, then exits. Not part of the Zod schema union -- handled specially in the main message loop alongside `interrupt` and `initialize`.

```typescript
{ subtype: "end_session", reason?: string }
```

Response is a bare ack. Process exits after sending it (observed exit code 126).

**Cockpit status:** Not used. Cockpit sends SIGTERM to the process group via `killProcessGroup()`. Could use `end_session` for graceful shutdown.

#### `set_permission_mode`

```typescript
{ subtype: "set_permission_mode", mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" }
```

**Cockpit status:** Used.

#### `set_model`

Changes the model mid-session without restarting the process. The next turn uses the new model. Verified empirically: switching from opus to haiku shows the new model in the `assistant` event's `message.model` field.

```typescript
{ subtype: "set_model", model?: string }
```

Response is a bare ack.

**Cockpit status:** Used.

#### `set_max_thinking_tokens`

```typescript
{ subtype: "set_max_thinking_tokens", max_thinking_tokens: number | null }
```

**Cockpit status:** Not used. Cockpit uses `apply_flag_settings` with `effort` instead.

#### `apply_flag_settings`

Merge settings into the flag settings layer at runtime. Can set `effort`, env vars, and other config. Verified empirically with `{ effort: "high" }`.

```typescript
{ subtype: "apply_flag_settings", settings: Record<string, unknown> }
```

Response is a bare ack.

**Cockpit status:** Used for effort/thinking level changes.

#### `get_settings`

Returns effective merged settings, per-source breakdown, and applied runtime values. Can be sent at any time during a session (process does not need to be idle).

```typescript
{ subtype: "get_settings" }
```

Response:
```typescript
{
  effective: Record<string, unknown>,  // merged settings
  sources: {
    source: "userSettings" | "projectSettings" | "localSettings" | "flagSettings" | "policySettings",
    settings: Record<string, unknown>
  }[],
  applied?: {
    model: string,        // e.g. "claude-opus-4-6[1m]"
    effort: "low" | "medium" | "high" | "max" | null
  }
}
```

The `applied` field shows the runtime-resolved values that will actually be sent to the API.

**Cockpit status:** Not used. Could power a settings inspector in the UI.

#### `initialize`

SDK initialization. Must be sent before the first user message. Calling it twice returns an error: `"Already initialized"`. Returns rich metadata about available models, commands, agents, and account info.

```typescript
{
  subtype: "initialize",
  hooks?: Record<string, HookConfig[]>,
  sdkMcpServers?: string[],
  jsonSchema?: Record<string, unknown>,
  systemPrompt?: string,
  appendSystemPrompt?: string,
  agents?: Record<string, AgentDef>,
  promptSuggestions?: boolean,
  agentProgressSummaries?: boolean
}
```

Response:
```typescript
{
  commands: { name: string, description: string, argumentHint?: string }[],
  agents: { name: string, description: string, model?: string }[],
  output_style: string,
  available_output_styles: string[],
  models: {
    value: string,
    displayName: string,
    description: string,
    supportsEffort?: boolean,
    supportedEffortLevels?: ("low" | "medium" | "high" | "max")[],
    supportsAdaptiveThinking?: boolean,
    supportsFastMode?: boolean,
    supportsAutoMode?: boolean
  }[],
  account: {
    email: string,
    organization: string,
    subscriptionType: string   // e.g. "Claude Max"
  },
  pid?: number,
  fast_mode_state?: string
}
```

Richer than the `system/init` event: includes model capabilities (effort levels, fast mode), account info, command argument hints, and available output styles.

**Cockpit status:** Not used. Could provide model picker data, account info, and slash command metadata.

#### `mcp_status`

Returns full state of all MCP servers including tools, config, scope, and errors.

```typescript
{ subtype: "mcp_status" }
```

Response:
```typescript
{
  mcpServers: {
    name: string,
    status: "connected" | "disabled" | "failed",
    serverInfo: { name: string, version: string },  // {} when disabled
    config: {
      type?: "stdio" | "sse" | "http",
      command?: string,
      args?: string[],
      url?: string
    },
    scope: "user" | "claudeai" | "dynamic",
    tools: { name: string, annotations?: Record<string, unknown> }[],  // [] when disabled
    error?: string   // present when status="failed"
  }[]
}
```

Much richer than the `system/init` event which only has `{name, status}`.

**Cockpit status:** Not used. Could power a live MCP server status panel.

#### `mcp_message`

Send a raw JSON-RPC message to an MCP server. Fire-and-forget: the CLI acks receipt but does NOT return the MCP server's response. Primarily useful for side-effect-only operations (notifications, pings). Even sending to a nonexistent server returns success.

```typescript
{ subtype: "mcp_message", serverName: string, message: unknown }
```

Note: uses `serverName` (camelCase), not `server_name`.

**Cockpit status:** Not used.

#### `mcp_set_servers`

Add/replace dynamically managed MCP servers for the session. Accepts an object keyed by server name (not an array). Dynamic servers appear with `scope: "dynamic"` in `mcp_status`. Servers from the previous `mcp_set_servers` call that are missing from the new call are removed.

```typescript
{
  subtype: "mcp_set_servers",
  servers: Record<string, McpServerConfig>
}

// McpServerConfig variants:
{ type?: "stdio", command: string, args?: string[], env?: Record<string, string> }
{ type: "sse", url: string, headers?: Record<string, string> }
{ type: "http", url: string, headers?: Record<string, string> }
```

Response:
```typescript
{
  added: string[],
  removed: string[],
  errors: Record<string, string>  // server name -> error message
}
```

**Cockpit status:** Not used. Could enable adding session-scoped MCP servers without editing config files.

#### `mcp_reconnect`

Disconnect and reconnect to an MCP server.

```typescript
{ subtype: "mcp_reconnect", serverName: string }
```

Note: uses `serverName` (camelCase). Using `server_name` returns `"Server not found: undefined"`.

Response is a bare ack.

**Cockpit status:** Not used.

#### `mcp_toggle`

Enable or disable an MCP server.

```typescript
{ subtype: "mcp_toggle", serverName: string, enabled: boolean }
```

Note: uses `serverName` (camelCase).

Response is a bare ack. State change visible via `mcp_status`.

**Cockpit status:** Not used.

#### `rewind_files`

Rewind file changes to the state before a given user message was processed. Requires `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` in the process environment (disabled by default in stream-json mode).

```typescript
{ subtype: "rewind_files", user_message_id: string, dry_run?: boolean }
```

The `user_message_id` must be the `uuid` sent on the *input* user message (not from output events or assistant messages). The CLI snapshots file state keyed to this UUID before processing.

Dry run response (`dry_run: true`):
```typescript
// Always subtype: "success" with canRewind boolean
{
  canRewind: boolean,
  filesChanged?: string[],   // paths that would change
  insertions?: number,
  deletions?: number,
  error?: string             // present when canRewind=false
}
```

Actual rewind response (`dry_run: false`):
```typescript
// Success:
{ canRewind: true }

// Failure uses subtype: "error" at the control_response level:
// { subtype: "error", error: "No file checkpoint found for this message." }
```

Rewind restores files to their state at the moment the user message was received (before the assistant processed it). The process stays alive after rewind.

**Cockpit status:** Not used. Cockpit does not send `uuid` on user messages, so checkpoints are not created. To enable rewind: (1) set `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` in the spawn env, (2) include `uuid` on every user message written to stdin.

#### `cancel_async_message`

Cancel a pending message from the CLI's internal priority queue. Only works if the message has not yet been dequeued for execution.

```typescript
{ subtype: "cancel_async_message", message_uuid: string }
```

Response (always success, never errors):
```typescript
{ cancelled: boolean }  // true if removed from queue, false if not found/already processing
```

**CLI internal queue:** The CLI maintains a priority queue with levels `now` (0), `next` (1), `later` (2). Lower number = dequeued first. When idle, messages are dequeued immediately, so the queue is only populated when the CLI is busy processing a turn.

**User message priority field:** The `user` message type accepts an optional `priority` field:
```typescript
{
  type: "user",
  uuid?: string,
  message: { role: "user", content: ... },
  priority?: "now" | "next" | "later"  // defaults to "next"
}
```

**Cockpit status:** Not used. Cockpit maintains its own FIFO queue in `session.queuedMessages` and serializes messages to stdin one at a time. The CLI's priority queue and `cancel_async_message` are bypassed. Cockpit's own `cancelQueuedMessage()` pops from the cockpit-side queue instead.

#### `stop_task`

Stop a running background task by ID. The CLI looks up the task, validates it is still running, then kills it based on task type (`local_bash`, `local_agent`, `remote_agent`). After stopping, the CLI emits a `task_notification` event with `status: "stopped"`.

```typescript
{ subtype: "stop_task", task_id: string }
```

Response:
```typescript
{ taskId: string, taskType: string, command: string }
```

Errors: `"not_found"` if task doesn't exist, `"not_running"` if already completed/failed/killed.

**Cockpit status:** Not used. No `stopTask()` method exists on SessionManager. The task UI has no stop button. Also note: the event parser hardcodes `task_notification` status to `"completed"`, ignoring the `"stopped"` and `"failed"` values the CLI sends.

#### `hook_callback`

Direction: CLI sends this TO the consumer when a hook event fires and matches a registered hook's matcher. Hook matchers are registered via the `initialize` control request's `hooks` field.

```typescript
// CLI -> consumer (as a control_request):
{
  subtype: "hook_callback",
  callback_id: string,      // format: "hook_0", "hook_1", etc. (sequential)
  input: HookCallbackInput, // hook event data (tool name, input, etc.)
  tool_use_id?: string
}
```

The consumer responds with a `control_response` containing the hook's output.

**Cockpit status:** Not used. Cockpit does not send hook configurations in `initialize`, so it never receives `hook_callback` requests.

#### `elicitation`

Direction: CLI sends this TO the consumer when an MCP server requests user input. Triggered by MCP error code -32042 (`UrlElicitationRequired`) for OAuth flows, or by the standard MCP elicitation protocol for form-based input.

```typescript
// CLI -> consumer (as a control_request):
{
  subtype: "elicitation",
  mcp_server_name: string,
  message: string,
  mode?: "form" | "url",
  url?: string,                        // for URL/OAuth mode
  elicitation_id?: string,
  requested_schema?: Record<string, unknown>  // JSON schema for form fields
}
```

Expected response:
```typescript
{
  action: "accept" | "decline" | "cancel",
  content?: Record<string, unknown>  // user-provided form data
}
```

If the consumer fails to respond, the CLI defaults to `{ action: "cancel" }`.

**Cockpit status:** Not used. MCP servers that require OAuth would trigger this.

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

## `/btw` Side Questions

The `/btw` slash command lets users ask a quick question while Claude is working without interrupting the current turn.

### How it works in the CLI (TUI)

The CLI handles `/btw` entirely inside its React TUI layer. It never reaches the stdin message pipeline or the priority queue.

1. Input text is matched against `/^\/btw\b/gi`
2. A separate lightweight API call is made via `AT()` with:
   - `querySource: "side_question"`
   - `forkLabel: "side_question"` (forks from the current conversation context)
   - `maxTurns: 1`
   - `skipCacheWrite: true`
   - All tool use denied (`behavior: "deny"`)
3. The main turn continues uninterrupted in the background
4. The response is rendered in an overlay, then auto-dismissed into chat history
5. Behind feature flag `tengu_marble_whisper2`

The system prompt instructs the side agent that it is a separate instance, has no tools, and should answer directly from conversation context.

### How Cockpit implements it

Since `/btw` is not exposed through the stdin/SDK protocol, Cockpit spawns a separate `claude -p` process with `--no-session-persistence`, `--allowedTools ""`, and a similar system prompt. The last 20 messages are passed as text context.

Key differences from the native CLI:
- Cockpit spawns a new process (overhead) vs the CLI calling the API directly in-process
- Cockpit passes a truncated text summary of 20 messages vs the CLI forking from the full conversation context
- Cockpit's system prompt is simpler than the CLI's

Potential improvement: call the Anthropic API directly instead of spawning a CLI process, and pass the full conversation context.

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
