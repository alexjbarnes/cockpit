# Claude CLI Reference

Notes on Claude Code CLI behavior, flags, and quirks discovered while building Aperture.

## Print mode (-p)

`claude -p` runs the CLI as a one-shot command: stdin in, stdout out, process exits. No session created, no JSONL log, no persistence. Useful for simple prompt/response tasks like generating commit messages.

```bash
echo "your prompt" | claude -p --model haiku
```

Pipe large prompts via stdin rather than passing as a CLI argument (OS arg length limits).

## Extended thinking

Thinking is enabled by default with a 31,999-token budget. This adds significant latency even for simple prompts.

Disable it entirely:
```bash
MAX_THINKING_TOKENS=0 claude -p --model haiku "prompt"
```

Reduce the budget:
```bash
MAX_THINKING_TOKENS=5000 claude -p --model haiku "prompt"
```

With Haiku, disabling thinking cut response time from ~14s to ~6s for a trivial prompt.

## Effort level

The `--effort` flag controls thinking depth. Only supported by Opus 4.6 and Sonnet 4.6. Haiku 4.5 does not support it.

```bash
claude -p --model sonnet --effort low "prompt"
```

For Haiku, use `MAX_THINKING_TOKENS=0` instead.

## Session persistence

By default, even `-p` mode writes session data to disk. Disable with:
```bash
claude -p --no-session-persistence --model haiku "prompt"
```

## Reducing startup overhead

The CLI loads CLAUDE.md files, MCP servers, tool definitions, and a large system prompt by default. For simple tasks:

```bash
# Minimal mode: strips MCP, hooks, CLAUDE.md
CLAUDE_CODE_SIMPLE=1 claude -p --model haiku "prompt"

# Disable all tools (removes tool definitions from system prompt)
claude -p --model haiku --allowedTools "" "prompt"

# Replace the system prompt entirely
claude -p --model haiku --system-prompt "Answer concisely." "prompt"

# Limit output length
CLAUDE_CODE_MAX_OUTPUT_TOKENS=1024 claude -p --model haiku "prompt"
```

## Environment variables

The CLI sets `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` when spawning child processes. When spawning the CLI from a server process that itself was spawned by the CLI, delete these from the env to avoid conflicts:

```typescript
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;
```

## Model aliases

| Alias | Full ID |
|-------|---------|
| `opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5-20251001` |

No speed difference between alias and full ID.

## Slash commands

Slash commands are a REPL-layer feature. They are not available through the stream-json protocol used by Aperture. See [slash-commands.md](./slash-commands.md) for the full analysis and implementation plan.

## Interactive mode (stream-json)

Aperture communicates with the CLI via `--input-format stream-json --output-format stream-json`. Messages are sent as JSON lines on stdin:

```json
{"type": "user", "message": {"role": "user", "content": "hello"}}
```

The CLI streams responses as JSON lines on stdout. See `src/server/event-parser.ts` for the full event schema.

### Stdin message types

Three message types can be sent to the CLI on stdin:

**User messages** send prompts:
```json
{"type": "user", "message": {"role": "user", "content": "hello"}}
```

**Control requests** send commands to the CLI process:
```json
{"type": "control_request", "request_id": "unique-id", "request": {"subtype": "set_permission_mode", "mode": "bypassPermissions"}}
```

**Control responses** reply to permission/question prompts from the CLI:
```json
{"type": "control_response", "request_id": "req-123", "permission_decision": "allow"}
```

### Control request subtypes

Discovered by examining the Claude SDK source code. The CLI accepts these `control_request` subtypes:

| Subtype | Purpose |
|---------|---------|
| `initialize` | Initialize session |
| `set_permission_mode` | Change permission mode mid-session |
| `set_model` | Switch model |
| `set_max_thinking_tokens` | Adjust thinking budget |
| `interrupt` | Interrupt current generation |
| `apply_flag_settings` | Apply CLI flag settings |
| `get_settings` | Read current settings |
| `rewind_files` | Revert file changes |
| `stop_task` | Stop the current task |
| `set_proactive` | Toggle proactive mode |
| `remote_control` | Remote control operations |
| `generate_session_title` | Generate a title for the session |
| `cancel_async_message` | Cancel async message |
| `mcp_reconnect` | Reconnect MCP server |
| `mcp_toggle` | Toggle MCP server |
| `mcp_set_servers` | Configure MCP servers |
| `mcp_status` | Check MCP status |
| `mcp_authenticate` | Authenticate MCP server |
| `mcp_clear_auth` | Clear MCP auth |
| `mcp_oauth_callback_url` | OAuth callback for MCP |
| `mcp_message` | Send message to MCP |

## Permission handling

This was a major source of stuck sessions. The correct approach delegates all permission logic to the CLI natively rather than intercepting permission requests in the server.

### Permission modes

The CLI supports these permission modes via `--permission-mode` or `set_permission_mode`:

| Mode | Behavior |
|------|----------|
| `default` | Prompt for each tool use |
| `acceptEdits` | Auto-allow file edits, prompt for others |
| `plan` | Read-only, no tool execution |
| `dontAsk` | Allow all, but skip dangerous tools |
| `bypassPermissions` | Allow everything including dangerous tools |
| `auto` | Let the CLI decide |

### Key flags

**`--allow-dangerously-skip-permissions`**: Unlocks `bypassPermissions` as a valid mode. Without this flag, the CLI rejects attempts to set `bypassPermissions`. Aperture always passes this flag so bypass can be toggled on/off mid-session.

**`--permission-prompt-tool stdio`**: Routes permission prompts through the stream-json protocol as `permission_request` events instead of the interactive TUI. Required for Aperture to surface permission dialogs in the browser.

**`--permission-mode <mode>`**: Sets the initial permission mode at spawn time.

### Architecture

Aperture spawns the CLI with:
```bash
claude --allow-dangerously-skip-permissions --permission-prompt-tool stdio [--permission-mode bypassPermissions]
```

The `--permission-mode bypassPermissions` flag is included only if the user has bypass enabled for that session.

To toggle bypass mid-session, Aperture sends a control request on stdin:
```json
{"type": "control_request", "request_id": "perm-12345", "request": {"subtype": "set_permission_mode", "mode": "bypassPermissions"}}
```

To disable bypass mid-session:
```json
{"type": "control_request", "request_id": "perm-12346", "request": {"subtype": "set_permission_mode", "mode": "default"}}
```

### Why not handle permissions server-side

Earlier versions intercepted `permission_request` events in the WS handler and auto-responded when bypass was active. This caused stuck sessions: when the WebSocket dropped mid-generation, the event listener was removed. If the CLI emitted a `permission_request` during the gap, nobody responded. The CLI blocked forever waiting for a response.

Delegating to the CLI via `--permission-mode` and `set_permission_mode` means the CLI itself skips permission prompts when bypass is active. No event listener needed. No gap to fall through.

### Responding to permission requests

When bypass is off, the CLI sends `permission_request` events. The server stores these in `session.pendingRequests` so they survive WS reconnections. The client responds via:
```json
{"type": "control_response", "request_id": "req-123", "permission_decision": "allow"}
```

Valid `permission_decision` values: `"allow"`, `"deny"`, `"allowForever"`.

For `AskUserQuestion` tool calls, the response uses `user_response` instead:
```json
{"type": "control_response", "request_id": "req-123", "user_response": "the user's answer"}
```

## Process signals

- `SIGINT` interrupts the current generation (equivalent to pressing Escape in the terminal). The process stays alive and accepts new input.
- `SIGTERM` / `SIGKILL` terminates the process entirely.

The stop button in Aperture sends `SIGINT` to interrupt, not kill.
