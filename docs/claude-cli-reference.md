# Claude CLI Reference

Notes on Claude Code CLI behavior, flags, and quirks discovered while building Cockpit.

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

Slash commands are a REPL-layer feature. They are not available through the stream-json protocol used by Cockpit. See [slash-commands.md](./slash-commands.md) for the full analysis and implementation plan.

## Interactive mode (stream-json)

Cockpit communicates with the CLI via `--input-format stream-json --output-format stream-json`. Messages are sent as JSON lines on stdin:

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
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req-123",
    "response": { "behavior": "allow", "updatedInput": {} }
  }
}
```

### Control request subtypes

The CLI uses a request/response pattern with correlated `request_id` fields. Subtypes are split by direction.

**Server to CLI:**

| Subtype | Purpose |
|---------|---------|
| `initialize` | Register hooks, MCP servers, agents, system prompt (must be sent before first user message) |
| `set_permission_mode` | Change permission mode mid-session |
| `set_model` | Switch model (`"default"` to reset) |
| `set_max_thinking_tokens` | Adjust thinking budget |
| `interrupt` | Abort current agent turn |
| `apply_flag_settings` | Apply CLI flag settings |
| `get_settings` | Read current settings |
| `rewind_files` | Revert file changes to a checkpoint |
| `stop_task` | Stop the current task |
| `set_proactive` | Toggle proactive mode |
| `remote_control` | Remote control operations |
| `generate_session_title` | Generate a title for the session |
| `cancel_async_message` | Cancel async message |
| `mcp_reconnect` | Reconnect MCP server |
| `mcp_toggle` | Enable/disable MCP server |
| `mcp_set_servers` | Configure MCP servers |
| `mcp_status` | Get MCP server statuses |
| `mcp_authenticate` | Authenticate MCP server |
| `mcp_clear_auth` | Clear MCP auth |
| `mcp_oauth_callback_url` | OAuth callback for MCP |
| `mcp_message` | Route JSON-RPC to/from MCP (bidirectional) |

**CLI to Server:**

| Subtype | Purpose |
|---------|---------|
| `can_use_tool` | Permission request for tool use |
| `hook_callback` | Invoke a registered hook callback |

### Initialize control request

The `initialize` request can be sent before the first user message to register hooks, MCP servers, agents, and system prompt overrides.

```typescript
// Request
{
  subtype: "initialize";
  hooks?: Record<HookEvent, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]>;
  sdkMcpServers?: string[];
  jsonSchema?: Record<string, unknown>;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  agents?: Record<string, AgentDefinition>;
}

// Response
{
  commands: { name: string; description: string; argumentHint?: string }[];
  output_style: string;
  available_output_styles: string[];
  models: { value: string; displayName: string; description: string }[];
  account: { email?: string; organization?: string; subscriptionType?: string; apiKeySource?: string };
  fast_mode?: boolean;
}
```

Sending `initialize` twice returns error: `"Already initialized"`.

Cockpit does not currently use `initialize`. It could be useful for registering hooks or injecting system prompt additions without `--append-system-prompt`.

## Permission handling

This was a major source of stuck sessions. The correct approach delegates all permission logic to the CLI natively rather than intercepting permission requests in the server.

### Permission modes

The CLI supports these permission modes via `--permission-mode` or `set_permission_mode`:

| Mode | `can_use_tool` sent? | Behavior |
|------|---------------------|----------|
| `default` | Yes (when rules don't resolve) | Prompt for each tool use |
| `acceptEdits` | Yes (for non-edit tools) | Auto-allow file edits, prompt for others |
| `plan` | Yes (limited) | Read-only exploration mode |
| `dontAsk` | Never | Auto-denies unresolved permissions |
| `bypassPermissions` | Never | Everything auto-approved locally |
| `delegate` | N/A | Restricted to coordination tools only |
| `auto` | Yes | Let the CLI decide |

### Key flags

**`--allow-dangerously-skip-permissions`**: Unlocks `bypassPermissions` as a valid mode. Without this flag, the CLI rejects attempts to set `bypassPermissions`. Cockpit always passes this flag so bypass can be toggled on/off mid-session.

**`--permission-prompt-tool stdio`**: Routes permission prompts through the stream-json protocol as `permission_request` events instead of the interactive TUI. Required for Cockpit to surface permission dialogs in the browser.

**`--permission-mode <mode>`**: Sets the initial permission mode at spawn time.

### Architecture

Cockpit spawns the CLI with:
```bash
claude --allow-dangerously-skip-permissions --permission-prompt-tool stdio [--permission-mode bypassPermissions]
```

The `--permission-mode bypassPermissions` flag is included only if the user has bypass enabled for that session.

To toggle bypass mid-session, Cockpit sends a control request on stdin:
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

### Three-layer permission decision pipeline

The CLI evaluates permissions through three layers before sending `can_use_tool` over the wire:

```
Tool Use Request
  |
  +-- Layer 1: PreToolUse Hooks (local shell scripts)
  |     allow -> tool executes
  |     deny -> tool blocked
  |     ask -> fall through
  |
  +-- Layer 2: Local Rule Evaluation
  |     Check deny rules -> if match -> DENIED
  |     Check ask rules -> if match -> behavior="ask"
  |     Check mode:
  |       bypassPermissions -> ALLOWED (never reaches wire)
  |       dontAsk -> DENIED (never reaches wire)
  |     Check allow rules (incl. --allowedTools) -> ALLOWED
  |     Default -> behavior="ask"
  |
  +-- Layer 3: Remote Prompt (stdin/WebSocket)
        Sends control_request { subtype: "can_use_tool", ... }
        Response: { behavior: "allow" } -> EXECUTE
        Response: { behavior: "deny" } -> BLOCKED
```

Only requests that pass through all three layers reach Cockpit. If `bypassPermissions` is active, nothing reaches us.

### Responding to permission requests

When bypass is off, the CLI sends `can_use_tool` control requests on stdout. The server stores these in `session.pendingRequests` so they survive WS reconnections.

```typescript
{
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
    permission_suggestions?: PermissionUpdate[];
    blocked_path?: string;
    decision_reason?: "hook" | "asyncAgent" | "sandboxOverride" | "classifier" | "workingDir" | "other";
    agent_id?: string;
    description?: string;
  };
}
```

The response uses a nested envelope. The `behavior` field is a discriminated union of exactly `"allow"` and `"deny"`. There is no `"alwaysAllow"` value.

**Allow:**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req-123",
    "response": {
      "behavior": "allow",
      "updatedInput": {},
      "updatedPermissions": []
    }
  }
}
```

`updatedInput` is required and replaces the tool's input entirely. Pass through the original input unchanged, or modify it to sanitize commands or restrict paths.

`updatedPermissions` is optional. When provided, the CLI persists the rules and auto-approves future matching tool calls.

**Deny:**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req-123",
    "response": {
      "behavior": "deny",
      "message": "User denied",
      "interrupt": false
    }
  }
}
```

Setting `interrupt: true` aborts the entire agent turn (calls `abortController.abort()`). Without it, the agent sees the denial and may try a different approach.

**Error response:**
```json
{
  "type": "control_response",
  "response": {
    "subtype": "error",
    "request_id": "req-123",
    "error": "reason",
    "pending_permission_requests": []
  }
}
```

**Cancel request** (cancels a pending `can_use_tool` from the CLI side):
```json
{ "type": "control_cancel_request", "request_id": "req-123" }
```

### "Always allow" via updatedPermissions

The mechanism for persisting tool permissions is the `updatedPermissions` field on the allow response. The CLI sends `permission_suggestions` in the request which are pre-built rules you can pass back.

```typescript
type PermissionUpdate =
  | { type: "addRules", rules: PermissionRule[], behavior: "allow" | "deny" | "ask", destination: PermissionDestination }
  | { type: "replaceRules", rules: PermissionRule[], behavior: "allow" | "deny" | "ask", destination: PermissionDestination }
  | { type: "removeRules", rules: PermissionRule[], behavior: "allow" | "deny" | "ask", destination: PermissionDestination }
  | { type: "setMode", mode: PermissionMode, destination: PermissionDestination }
  | { type: "addDirectories", directories: string[], destination: PermissionDestination }
  | { type: "removeDirectories", directories: string[], destination: PermissionDestination }

type PermissionRule = { toolName: string; ruleContent?: string }

type PermissionDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
```

Example: auto-approve future git commands:
```json
{
  "behavior": "allow",
  "updatedInput": { "command": "git status" },
  "updatedPermissions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "git:*" }],
      "behavior": "allow",
      "destination": "session"
    }
  ]
}
```

Destinations:
- `session` - persists for the current CLI session only
- `localSettings` - persists to `.claude/settings.local.json` in the project
- `projectSettings` - persists to `.claude/settings.json` in the project
- `userSettings` - persists to `~/.claude/settings.json` globally
- `cliArg` - equivalent to `--allowedTools` flag

### Timeout behavior

If the server never responds to `can_use_tool`, the CLI blocks indefinitely. On transport close, all pending requests are rejected with "Tool permission stream closed before response received".

### AskUserQuestion responses

For `AskUserQuestion` tool calls, the response uses `user_response` instead:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req-123",
    "response": "the user's answer"
  }
}

## Flags relevant to Cockpit

Flags Cockpit currently uses are documented above. These additional flags are worth knowing about for future features or debugging.

### Session management

**`--name <name>`**: Set a display name for the session. Named sessions can be resumed with `claude --resume <name>`. Cockpit could use this to give sessions human-readable names.

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

**`--replay-user-messages`**: In stream-json mode, re-emits user messages on stdout for acknowledgment. Could help Cockpit confirm message delivery.

**`--include-partial-messages`**: Emits partial streaming events (token-by-token). Requires `--output-format stream-json`. Cockpit likely already gets these via the stream-json protocol.

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

## Plan mode

Plan mode lets the agent explore the codebase and design an implementation approach before writing code. The agent enters plan mode via `EnterPlanMode` (no permission required) and exits via `ExitPlanMode` (requires permission).

### Flow

1. Agent calls `EnterPlanMode` -- switches to plan mode
2. Agent explores the codebase using read-only tools (Glob, Grep, Read, Agent)
3. Agent writes a plan to a file at `~/.claude/plans/<slug>.md`
4. Agent calls `ExitPlanMode` -- triggers the approval prompt

### ExitPlanMode tool input

```json
{
  "allowedPrompts": [
    { "tool": "Bash", "prompt": "run tests" },
    { "tool": "Bash", "prompt": "install dependencies" }
  ]
}
```

`allowedPrompts` is optional. It describes prompt-based permissions the agent requests for implementation. Only the `Bash` tool uses this.

### CLI exit options

When `ExitPlanMode` fires, the CLI presents a numbered menu:

```
Would you like to proceed?

> 1. Yes, clear context and auto-accept edits    (shift+tab)
  2. Yes, clear context and manually approve edits
  3. Yes, auto-accept edits
  4. Yes, manually approve edits
  5. Type here to tell Claude what to change
```

| # | Effect |
|---|--------|
| 1 | Default. Clears conversation history (plan file persists on disk), auto-accepts file edits and granted `allowedPrompts` during implementation. Session is renamed from the plan content. |
| 2 | Clears conversation history, requires manual approval of each tool use. |
| 3 | Preserves conversation context, auto-accepts file edits and granted `allowedPrompts`. |
| 4 | Preserves conversation context, requires manual approval of each tool use. |
| 5 | Free-text input. Denies the plan exit and sends the user's feedback back to the agent so it can revise the plan while staying in plan mode. |

Options 1 and 2 clear context to free up the context window. The plan file at `~/.claude/plans/` survives the clear and is referenced in the system prompt, so the agent picks it up on the next turn.

When the session was started with `--dangerously-skip-permissions`, "auto-accept edits" is replaced with "bypass permissions" in options 1 and 3.

### Additional exit mechanisms

- `Shift+Tab` in the main prompt cycles permission modes and can exit plan mode directly
- `/plan` slash command toggles plan mode on/off
- Rejecting the `ExitPlanMode` tool call sends the agent back to continue planning

### How clear context works internally

The CLI performs a hard wipe, not a summarization. `clearConversation` does:
- `setMessages(() => [])` -- zeros out the message array
- Generates a new conversation UUID
- Clears file-read state caches
- Kills running shell commands and aborts controllers
- Fires PreCompact/PostCompact hook events

No API call. No LLM summarization. The plan file at `~/.claude/plans/` persists on disk and is referenced in the system prompt, so the agent picks it up on the next turn despite having zero conversation history.

The CLI also **rejects** (not approves) the ExitPlanMode tool call when clearing context. This prevents the agent from continuing in the old context. After the clear, a fresh turn starts.

### Cockpit implementation

Cockpit renders a `PlanApprovalPrompt` component (instead of the generic `PermissionPrompt`) when `permission.toolName === "ExitPlanMode"`. It replicates the 5 CLI options:

- Options 1-2 (clear context): deny the permission (matches CLI's reject behavior), send `/clear` to kill the process and wipe state, then send "Implement the plan" to start a fresh turn
- Options 3-4 (keep context): approve the permission normally
- Options 1, 3 (auto-accept): enable bypass mode via `permission:set_bypass`
- Option 5 (feedback): deny the permission, then send the user's text as a new message

Keyboard navigation (arrow keys, j/k, Enter) mirrors the CLI's list selector.

## Hooks system

The CLI supports hooks that fire at various points in the agent lifecycle. Hooks are configured in settings JSON files and can run shell commands, HTTP requests, LLM prompts, or sub-agents.

This is relevant to Cockpit because hooks fire regardless of whether the CLI is in interactive or stream-json mode. Cockpit users' hooks will still execute.

### Hook events

| Event | When | Can block? |
|-------|------|------------|
| `Setup` | Initial setup | No |
| `SessionStart` | Session begins/resumes | No |
| `UserPromptSubmit` | User sends a prompt | Yes |
| `PreToolUse` | Before tool executes | Yes |
| `PermissionRequest` | Permission dialog shown | Yes |
| `PostToolUse` | After tool succeeds | No |
| `PostToolUseFailure` | After tool fails | No |
| `Notification` | Notification event | No |
| `Stop` | Agent finishes | Yes |
| `SubagentStart` | Subagent spawned | No |
| `SubagentStop` | Subagent finishes | Yes |
| `PreCompact` | Before context compaction | No |
| `PostCompact` | After compaction | No |
| `TeammateIdle` | Teammate goes idle | No |
| `TaskCompleted` | Background task finishes | No |
| `SessionEnd` | Session terminates | No |

Blocking hooks (exit code 2) can prevent tool execution, deny permissions, block prompts, or prevent the agent from stopping. This means a user's hook could cause behavior that looks like a stuck session from Cockpit's perspective.

### Hook types

| Type | How it works |
|------|-------------|
| `command` | Runs a shell script, reads JSON from stdin, writes decision to stdout |
| `http` | POST to a URL, JSON body, decision from response |
| `prompt` | Sends input to an LLM, gets structured decision back |
| `agent` | Like prompt but can use tools (Read, Grep, etc.) |

### Implications for Cockpit

- Hooks fire inside the CLI process, invisible to Cockpit's event stream
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

### SDK vs CLI for Cockpit

Cockpit currently spawns the CLI with `--input-format stream-json --output-format stream-json`. The SDK alternative would mean importing `@anthropic-ai/claude-agent-sdk` and calling `query()` directly from the Node.js server process.

Tradeoffs:
- SDK gives typed objects instead of parsing JSON lines
- SDK supports hook callbacks as functions (not just shell commands)
- SDK handles the agent loop internally
- CLI spawning gives process isolation (crash doesn't take down server)
- CLI spawning allows different Node/Bun runtimes
- CLI is what Cockpit has been built around; switching would be a major refactor

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

This matches what Cockpit's event-parser.ts already handles from the CLI's stream-json output.

## Process signals

- `SIGINT` interrupts the current generation (equivalent to pressing Escape in the terminal). The process stays alive and accepts new input.
- `SIGTERM` / `SIGKILL` terminates the process entirely.

The stop button in Cockpit sends `SIGINT` to interrupt, not kill.

When killing a CLI process, kill the process group (`kill(-pid, 'SIGTERM')`) not just the process. The CLI spawns child processes for bash commands, and killing only the parent leaves orphaned shells running. On Windows use `taskkill /pid X /t /f`.

## File rewind

The CLI has a built-in file revert mechanism via the `rewind_files` control request. This rewinds file changes to a specific user message checkpoint without needing a shadow git repo.

```typescript
// Request
{ subtype: "rewind_files", user_message_id: string, dry_run?: boolean }

// Response (success)
{ canRewind: true, filesChanged?: number, insertions?: number, deletions?: number }
```

Set `dry_run: true` to preview the revert without applying it. The `user_message_id` corresponds to the `id` field from user messages in the transcript.

## Patterns from other implementations

Useful techniques observed in claude-code-chat (VS Code extension) and Companion (WebSocket wrapper):

**Pending permission cleanup on process death.** When the CLI process exits or crashes, cancel all pending permission requests in the UI. Without this, stale permission dialogs hang indefinitely after a crash. Cockpit should clear `session.pendingRequests` and notify the client when the process closes.

**Protocol drift detection.** Log unknown message types once per type per session. This catches breaking CLI updates early. A `Set<string>` of seen unknown types prevents log spam.

**Permission suggestions as UI buttons.** The CLI sends `permission_suggestions` with each `can_use_tool` request. These can be rendered as distinct buttons ("Allow git:* for session", "Allow Bash always") rather than a single "Always allow" button. Each suggestion maps to a `PermissionUpdate` that gets passed back as `updatedPermissions`.

**AI validation of permissions.** Companion runs an automated safety check on permission requests before showing them to users, tagging each as `safe`, `dangerous`, or `uncertain`. Safe requests can be auto-approved, dangerous auto-denied.

**`control_cancel_request` for stale permissions.** The server can send `{ type: "control_cancel_request", request_id: "..." }` to cancel a pending `can_use_tool` from the CLI side. Useful when the user navigates away or the request becomes irrelevant.

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
| `CLAUDE_CODE_SESSION_ACCESS_TOKEN` | Bearer token for WebSocket auth (highest priority) |
| `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` | File descriptor to read auth token from |
| `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` | Enable hybrid transport (WS receive + HTTP POST send) |
| `CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION` | Sent as `x-environment-runner-version` header |
| `CLAUDE_CODE_REMOTE` | Indicates running in remote mode |
| `CLAUDE_CODE_REMOTE_SESSION_ID` | Remote session identifier |
| `CLAUDE_CODE_CONTAINER_ID` | Container ID for remote environments |

Full list: https://code.claude.com/docs/en/env-vars

## WebSocket transport (--sdk-url)

The CLI has a hidden `--sdk-url <ws-url>` flag that makes it connect to a WebSocket server instead of using stdin/stdout. The protocol is the same NDJSON format. This is how the Claude Code web UI communicates with the CLI.

```bash
claude --sdk-url ws://localhost:8765 \
       --print \
       --output-format stream-json \
       --input-format stream-json \
       --verbose \
       -p "placeholder"
```

The `-p "placeholder"` prompt is ignored when `--sdk-url` is used. The CLI waits for a `user` message over WebSocket instead.

Key differences from stdin/stdout:
- CLI is the WebSocket client, not the server
- Auth via `Authorization: Bearer <token>` header on upgrade
- `keep_alive` messages sent periodically (bidirectional)
- WebSocket ping/pong every 10s
- Automatic reconnection with exponential backoff (max 3 attempts, 1s to 30s delay)
- Circular buffer of 1000 messages for replay on reconnect
- `X-Last-Request-Id` header on reconnect for message replay

Hybrid transport (enabled via `CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2`): receives over WebSocket but sends via HTTP POST with retry. URL conversion: `wss://host/ws/path` to `https://host/session/path/events`.

Cockpit uses stdin/stdout, not `--sdk-url`. The WebSocket transport could be an alternative approach that avoids process management but adds network complexity.

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
