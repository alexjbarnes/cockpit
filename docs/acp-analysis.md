# ACP (Agent Client Protocol) Analysis

Evaluation of whether Aperture should adopt ACP instead of directly spawning the Claude CLI.

## What ACP is

ACP is a JSON-RPC 2.0 protocol that standardizes communication between code editors (clients) and AI coding agents (servers). Think LSP, but for AI coding agents instead of language servers.

Transport options: stdio (local subprocess), HTTP, or WebSocket (remote, still WIP).

Created by the Zed team and collaborators. 34 agents are registered including `claude-acp`, `copilot`, `cursor`, `cline`, `gemini`.

Spec and SDKs: https://agentclientprotocol.com

## How Claude supports ACP today

Anthropic does not implement ACP directly in the CLI. Zed publishes `@zed-industries/claude-agent-acp` (v0.22.0), which bridges ACP to the `@anthropic-ai/claude-agent-sdk`.

```
ACP Client (editor)
  | JSON-RPC over stdio
@zed-industries/claude-agent-acp
  | function calls
@anthropic-ai/claude-agent-sdk (query() API)
  | Claude API
Anthropic
```

The bridge translates ACP `session/prompt` into Agent SDK `query()` calls, and converts Claude streaming events back into ACP `session/update` notifications.

## What Aperture currently does

```
Browser (React)
  | WebSocket + HTTP
Aperture server (Bun)
  | stdio (JSON lines)
claude CLI process (spawned with -p --input-format stream-json --output-format stream-json)
  | Claude API
Anthropic
```

Aperture spawns `claude` as a subprocess, writes JSON lines to stdin, reads JSON lines from stdout, and manages session lifecycle (spawn, resume, kill, respawn).

## Three options for adopting ACP

**Option A: Spawn `claude-agent-acp` instead of `claude` CLI**

```
Browser -> Aperture server -> claude-agent-acp (via stdio JSON-RPC) -> Claude Agent SDK -> API
```

**Option B: Talk to a remote ACP agent over HTTP/WS**

```
Browser -> Aperture server -> ACP over HTTP/WS -> claude-agent-acp (remote) -> API
```

**Option C: Use the Agent SDK directly (no ACP, no CLI)**

```
Browser -> Aperture server -> @anthropic-ai/claude-agent-sdk (in-process) -> API
```

## What ACP gives you

| Feature | Current (CLI) | ACP |
|---------|--------------|-----|
| Session create/resume/list/fork | Manual via CLI flags | First-class `session/new`, `session/load`, `session/list` |
| Permission handling | Control requests on stdin | `RequestPermission` with structured options (allow_once, allow_always, reject_once, reject_always) |
| File read/write | Agent uses its own tools | Agent can request `fs/read_text_file`, `fs/write_text_file` from client |
| Terminal access | Agent runs Bash tool internally | Agent can request `terminal/create`, `terminal/output`, `terminal/wait_for_exit` from client |
| Tool call visibility | Parse events from stdout | Structured tool call notifications with metadata |
| Diff rendering | Parse tool output for file paths | `Diff` type with `path`, `oldText`, `newText` |
| Plan/task tracking | Parse `task_update` events | `Plan` and `PlanEntry` types with pending/in_progress/completed |
| MCP server passthrough | Configured at CLI spawn | Client declares MCP servers in `session/new`, agent connects |
| Mode switching | `set_permission_mode` control request | `current_mode_update` notification, config options |
| Auth | API key in env | Protocol-level `authenticate` method |
| Cancellation | SIGINT to process | `session/cancel` method |

## What you'd gain

1. **Structured permission model.** Typed permission options (allow_once, allow_always, reject_once, reject_always) as first-class protocol concepts. No more crafting control_response JSON.

2. **Client-side file operations.** The agent asks Aperture to read/write files rather than doing it silently. Hook point for displaying changes, conflict detection, gating writes.

3. **Client-side terminal.** Agent requests terminal access through the protocol. Show terminal output in UI with full lifecycle management.

4. **Session management as protocol.** `session/list`, `session/load`, `session/new` with fork capability. No more managing `--resume` vs `--session-id` flags.

5. **Diff as a first-class type.** `{ path, oldText, newText }` comes through the protocol rather than extracted from tool output.

6. **Agent-agnostic architecture.** Implement ACP client once, swap between Claude, Gemini, Copilot, or any ACP agent. 34-agent registry becomes your catalog.

## What you'd lose

1. **Process isolation changes shape.** With the Agent SDK in-process (Option C), a crash takes down the server. With `claude-agent-acp` as subprocess (Option A), isolation is preserved but through a different binary.

2. **Massive refactor.** session-manager.ts (980+ lines) is built around spawning `claude`, parsing JSON lines, tracking tool state. All replaced with ACP JSON-RPC calls. EventParser becomes unnecessary. ws-handler.ts needs rewriting too.

3. **Third-party dependency.** `@zed-industries/claude-agent-acp` is maintained by Zed, not Anthropic. If Zed's priorities diverge, you're stuck. The underlying `@anthropic-ai/claude-agent-sdk` is Anthropic's, but the ACP bridge is Zed's.

4. **Remote transport not production-ready.** HTTP/WS transport is "a work in progress" per the spec. Only stdio works today.

5. **Feature parity gaps.** `--effort`, `--verbose`, `--debug`, hooks, worktrees, custom subagents via `--agents` may not have ACP equivalents. The bridge is at v0.22.0 with 11 versions; moving fast but not mature.

6. **Double abstraction.** `Aperture -> ACP -> Agent SDK -> API` is one more hop than `Aperture -> CLI -> API`. Two translation layers where you currently have one.

## Can you drop in any ACP agent?

At the protocol/transport layer: yes. Any ACP-compliant agent connects and communicates.

At the UX layer: no, not without work. Each agent declares capabilities during the `initialize` handshake. The practical issues:

- **Aperture's UI is Claude-specific.** Thinking blocks, tool use panels, streaming snapshots, bypass permissions. Other agents won't emit thinking blocks. Their tool patterns differ.
- **Capability gaps degrade UX.** If an agent doesn't declare `loadSession`, resume breaks. If it doesn't support images in prompts, image attachment fails silently.
- **Quality varies.** The protocol is standardized but implementations aren't. A bad agent gives a bad experience regardless of protocol correctness.
- **Capability-adaptive UI required.** Show/hide features based on what the agent declares. Real engineering work on top of implementing the ACP client.

"Any agent can plug in" is true. "Any agent provides a good experience" requires per-agent testing and UI adaptation.

## First-hand experience

Claude Code through ACP in Zed was buggy. Hard to tell whether the issues were Zed's ACP client, the `claude-agent-acp` bridge, or the Agent SDK underneath. This is the core risk of multi-layer abstraction: when something breaks, debugging spans three codebases.

## Recommendation

**Not yet, but worth preparing for.**

Today:
- Keep the CLI spawning approach. It works, the permission delegation fix solves stuck sessions, and the integration is well understood.
- Structure session-manager so CLI-specific bits (spawning, JSON line parsing, control requests) are behind an interface. If ACP is adopted later, swap the implementation without touching ws-handler or the React client.

Watch for:
- ACP remote transport stabilizing (enables Option B, which is the most interesting for Aperture)
- `claude-agent-acp` reaching feature parity with the CLI
- Anthropic adopting ACP natively in the CLI (would eliminate the Zed bridge dependency)
- ACP spec settling (0.16.x SDK, still pre-1.0)

The strongest argument for ACP: agent-agnosticism. If Aperture wants to support multiple AI backends, ACP gives you that.

The strongest argument against ACP now: dependency chain. Going from `claude` CLI (Anthropic, 135 SDK versions) to `@zed-industries/claude-agent-acp` (Zed, 11 versions) is a riskier foundation.

## Key packages

| Package | Maintainer | Purpose |
|---------|-----------|---------|
| `@agentclientprotocol/sdk` | Zed team | ACP protocol SDK (client + agent) |
| `@zed-industries/claude-agent-acp` | Zed team | ACP bridge for Claude via Agent SDK |
| `@anthropic-ai/claude-agent-sdk` | Anthropic | Claude Agent SDK (query API) |

## Key links

- ACP website: https://agentclientprotocol.com
- ACP spec repo: https://github.com/agentclientprotocol/agent-client-protocol
- TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk
- Agent registry: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- Claude ACP bridge: https://github.com/zed-industries/claude-agent-acp
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk-typescript
