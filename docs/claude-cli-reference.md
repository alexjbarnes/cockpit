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

## Flags relevant to Aperture

Flags Aperture currently uses are documented above. These additional flags are worth knowing about for future features or debugging.

### Session management

**`--name <name>`**: Set a display name for the session. Named sessions can be resumed with `claude --resume <name>`. Aperture could use this to give sessions human-readable names.

**`--fork-session`**: When used with `--resume` or `--continue`, creates a new session ID instead of reusing the original. Useful for branching conversations.

**`--add-dir <paths>`**: Grant tool access to additional directories beyond the launch directory. Also available mid-session via `/add-dir` command.

### Tool control

**`--tools <tools>`**: Restricts which built-in tools are available. Use `""` to disable all, `"default"` for all, or specific names like `"Bash,Edit,Read"`. This removes tools entirely from the model's context.

**`--allowedTools <tools>`**: Auto-approves the listed tools (no permission prompt). Does not restrict availability. Uses permission rule syntax: `"Bash(git log *)" "Read"`.

**`--disallowedTools <tools>`**: Removes the listed tools from the model's context. They cannot be used at all.

The distinction matters: `--tools` controls what exists, `--allowedTools` controls what gets auto-approved, `--disallowedTools` removes specific tools.

### System prompt

**`--append-system-prompt <text>`**: Appends to the default system prompt. Safer than `--system-prompt` because it preserves Claude Code's built-in capabilities.

**`--append-system-prompt-file <path>`**: Same as above but loads from a file.

**`--system-prompt <text>`**: Replaces the entire default prompt. Only use when you need complete control.

### Output control

**`--replay-user-messages`**: In stream-json mode, re-emits user messages on stdout for acknowledgment. Could help Aperture confirm message delivery.

**`--include-partial-messages`**: Emits partial streaming events (token-by-token). Requires `--output-format stream-json`. Aperture likely already gets these via the stream-json protocol.

**`--verbose`**: Enables verbose logging with full turn-by-turn output.

**`--debug [filter]`**: Debug mode with optional category filtering. Categories include `api`, `hooks`, `mcp`, `file`. Use `!category` to exclude. Example: `--debug "api,mcp"`.

### Budget and limits

**`--max-turns <n>`**: Limit the number of agentic turns. Print mode only. Exits with error when reached.

**`--max-budget-usd <amount>`**: Maximum dollar spend on API calls. Print mode only.

**`--fallback-model <model>`**: Auto-fallback when the primary model is overloaded. Print mode only.

### Other

**`--agents <json>`**: Define custom subagents dynamically via JSON. Example: `--agents '{"reviewer":{"description":"Reviews code","prompt":"You are a code reviewer"}}'`.

**`--mcp-config <path>`**: Load MCP servers from JSON files.

**`--strict-mcp-config`**: Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations.

**`--settings <file-or-json>`**: Path to a settings JSON file or inline JSON string.

**`--worktree <name>`**: Start in an isolated git worktree. The CLI manages creation and cleanup.

## Built-in tools

The CLI exposes these tools. Tool names are used in permission rules, `--allowedTools`, `--disallowedTools`, and hook matchers.

| Tool | Description | Permission |
|------|-------------|------------|
| `Read` | Read file contents | No |
| `Write` | Create or overwrite files | Yes |
| `Edit` | Targeted edits to files | Yes |
| `Bash` | Execute shell commands | Yes |
| `Glob` | Find files by pattern | No |
| `Grep` | Search file contents with regex | No |
| `Agent` | Spawn a subagent with its own context | No |
| `AskUserQuestion` | Ask the user a question | No |
| `WebFetch` | Fetch URL content | Yes |
| `WebSearch` | Web search | Yes |
| `Skill` | Execute a skill | Yes |
| `TodoWrite` | Manage task checklist (non-interactive / SDK) | No |
| `TaskCreate` | Create a task (interactive mode) | No |
| `TaskGet` | Get task details | No |
| `TaskList` | List all tasks | No |
| `TaskUpdate` | Update task status | No |
| `TaskOutput` | Read background task output | No |
| `TaskStop` | Kill a background task | No |
| `CronCreate` | Schedule a recurring prompt | No |
| `CronDelete` | Cancel a scheduled task | No |
| `CronList` | List scheduled tasks | No |
| `EnterPlanMode` | Switch to plan mode | No |
| `ExitPlanMode` | Present plan and exit plan mode | Yes |
| `EnterWorktree` | Create and enter git worktree | No |
| `ExitWorktree` | Leave worktree | No |
| `NotebookEdit` | Modify Jupyter notebook cells | Yes |
| `LSP` | Language server operations (requires plugin) | No |
| `ToolSearch` | Search and load deferred MCP tools | No |
| `ListMcpResourcesTool` | List MCP resources | No |
| `ReadMcpResourceTool` | Read MCP resource by URI | No |

## Hooks system

The CLI supports hooks that fire at various points in the agent lifecycle. Hooks are configured in settings JSON files and can run shell commands, HTTP requests, LLM prompts, or sub-agents.

This is relevant to Aperture because hooks fire regardless of whether the CLI is in interactive or stream-json mode. Aperture users' hooks will still execute.

### Hook events

| Event | When | Can block? |
|-------|------|------------|
| `SessionStart` | Session begins/resumes | No |
| `UserPromptSubmit` | User sends a prompt | Yes |
| `PreToolUse` | Before tool executes | Yes |
| `PermissionRequest` | Permission dialog shown | Yes |
| `PostToolUse` | After tool succeeds | No |
| `PostToolUseFailure` | After tool fails | No |
| `Stop` | Agent finishes | Yes |
| `SubagentStart` | Subagent spawned | No |
| `SubagentStop` | Subagent finishes | Yes |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After compaction | No |
| `SessionEnd` | Session terminates | No |

Blocking hooks (exit code 2) can prevent tool execution, deny permissions, block prompts, or prevent the agent from stopping. This means a user's hook could cause behavior that looks like a stuck session from Aperture's perspective.

### Hook types

| Type | How it works |
|------|-------------|
| `command` | Runs a shell script, reads JSON from stdin, writes decision to stdout |
| `http` | POST to a URL, JSON body, decision from response |
| `prompt` | Sends input to an LLM, gets structured decision back |
| `agent` | Like prompt but can use tools (Read, Grep, etc.) |

### Implications for Aperture

- Hooks fire inside the CLI process, invisible to Aperture's event stream
- A blocking `PreToolUse` hook that hangs will look like a stuck session
- `PermissionRequest` hooks can override permission decisions
- `Stop` hooks can prevent the agent from finishing (keeps running)
- The `--debug "hooks"` flag is useful for diagnosing hook-related issues

## Agent SDK (TypeScript/Python)

The CLI's `-p` mode and stream-json protocol are one way to integrate. Anthropic also publishes the Claude Agent SDK as a library:

- TypeScript: `@anthropic-ai/claude-agent-sdk`
- Python: `claude-agent-sdk`

The SDK provides a `query()` function that yields typed message objects:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

### SDK message types

| Type | Description |
|------|-------------|
| `SystemMessage` (subtype `init`) | Session initialization, contains `session_id` |
| `AssistantMessage` | Complete response with all content blocks |
| `StreamEvent` | Raw API streaming event (when `includePartialMessages: true`) |
| `ResultMessage` | Final result when agent finishes |
| `CompactBoundaryMessage` | Indicates conversation history was compacted |

### SDK vs CLI for Aperture

Aperture currently spawns the CLI with `--input-format stream-json --output-format stream-json`. The SDK alternative would mean importing `@anthropic-ai/claude-agent-sdk` and calling `query()` directly from the Node.js server process.

Tradeoffs:
- SDK gives typed objects instead of parsing JSON lines
- SDK supports hook callbacks as functions (not just shell commands)
- SDK handles the agent loop internally
- CLI spawning gives process isolation (crash doesn't take down server)
- CLI spawning allows different Node/Bun runtimes
- CLI is what Aperture has been built around; switching would be a major refactor

### SDK streaming events

When `includePartialMessages` is enabled, `StreamEvent` wraps raw Claude API events:

| Event Type | Description |
|------------|-------------|
| `message_start` | Start of a new message |
| `content_block_start` | Start of text or tool_use block |
| `content_block_delta` | Incremental text or tool input |
| `content_block_stop` | End of a content block |
| `message_delta` | Message-level updates (stop reason, usage) |
| `message_stop` | End of the message |

This matches what Aperture's event-parser.ts already handles from the CLI's stream-json output.

## Process signals

- `SIGINT` interrupts the current generation (equivalent to pressing Escape in the terminal). The process stays alive and accepts new input.
- `SIGTERM` / `SIGKILL` terminates the process entirely.

The stop button in Aperture sends `SIGINT` to interrupt, not kill.

## Key environment variables

Set these before launching `claude` or configure in `settings.json` under the `env` key.

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_SIMPLE=1` | Minimal mode: strips MCP, hooks, CLAUDE.md |
| `MAX_THINKING_TOKENS` | Override thinking token budget (0 to disable) |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Limit output token count |
| `CLAUDE_CODE_USE_BEDROCK=1` | Use Amazon Bedrock as API provider |
| `CLAUDE_CODE_USE_VERTEX=1` | Use Google Vertex AI as API provider |
| `CLAUDE_CODE_USE_FOUNDRY=1` | Use Microsoft Azure as API provider |
| `CLAUDECODE` | Set by CLI on child processes (delete when re-spawning CLI) |
| `CLAUDE_CODE_ENTRYPOINT` | Set by CLI on child processes (delete when re-spawning CLI) |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` | Reset cwd to project dir after each Bash command |
| `CLAUDE_ENV_FILE` | Path to shell script for persisting env vars across Bash commands |

Full list: https://code.claude.com/docs/en/env-vars

## Official documentation

The CLI docs have moved to `code.claude.com`. The Agent SDK docs are at `platform.claude.com`.

| Topic | URL |
|-------|-----|
| CLI reference | https://code.claude.com/docs/en/cli-reference |
| Permissions | https://code.claude.com/docs/en/permissions |
| Settings | https://code.claude.com/docs/en/settings |
| Environment variables | https://code.claude.com/docs/en/env-vars |
| Hooks | https://code.claude.com/docs/en/hooks |
| Tools reference | https://code.claude.com/docs/en/tools-reference |
| Headless / SDK CLI | https://code.claude.com/docs/en/headless |
| Agent SDK overview | https://platform.claude.com/docs/en/agent-sdk/overview |
| Agent SDK streaming | https://platform.claude.com/docs/en/agent-sdk/streaming-output |
| Full docs index | https://code.claude.com/docs/llms.txt |
