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

## Process signals

- `SIGINT` interrupts the current generation (equivalent to pressing Escape in the terminal). The process stays alive and accepts new input.
- `SIGTERM` / `SIGKILL` terminates the process entirely.

The stop button in Aperture sends `SIGINT` to interrupt, not kill.
