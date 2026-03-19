# Slash Command Support

## Problem

Claude Code slash commands do not work through the stream-json protocol. When a user types a slash command, it gets sent as a regular user message to the Claude process via stdin JSON:

```typescript
// session-manager.ts:196
const userInput = { type: "user", message: { role: "user", content: "/compact" } };
session.stdin.write(JSON.stringify(userInput) + "\n");
```

Claude treats this as a normal chat message. Slash commands are a REPL-layer feature parsed from raw stdin in the terminal CLI. The JSON protocol bypasses that parsing entirely. There is no CLI flag, API endpoint, or control message type to discover or invoke slash commands programmatically. They must be hardcoded.

## Full command list from official docs

Source: https://code.claude.com/docs/en/interactive-mode

### Commands relevant to Cockpit

| Command | Priority | Handling | Notes |
|---------|----------|----------|-------|
| `/clear` | High | Backend | Reset messages, kill process, set `hasSpawnedBefore = false` so next spawn is fresh. Aliases: `/reset`, `/new` |
| `/compact [instructions]` | High | Backend | Kill process. Next `--resume` triggers Claude's built-in compaction. Optional focus instructions would need to be passed somehow. |
| `/cost` | High | Backend | Token usage stats. Need to track from `result` events or stderr. |
| `/context` | Medium | Backend | Context window usage visualization. Requires tracking token counts. |
| `/model [model]` | High | Backend | Switch model mid-session. Kill process, respawn with `--model` flag. |
| `/fast [on\|off]` | Medium | Backend | Toggle fast mode. Respawn with appropriate flag. |
| `/help` | High | Frontend | Display available commands in chat UI. Pure client-side. |
| `/rename [name]` | Medium | Backend | Rename session. Update `session.info.name` and persist. |
| `/export [filename]` | Low | Frontend | Export conversation as text. Can do client-side from messages array. |
| `/diff` | Low | Backend | Show uncommitted changes. Run `git diff` in session cwd. |
| `/plan` | Medium | Backend | Enter plan mode. Could pass as a flag on next spawn. |
| `/btw <question>` | Low | Backend | Side question without adding to context. Would need separate process invocation. |
| `/permissions` | Low | Frontend | View current permission settings. Alias: `/allowed-tools` |
| `/memory` | Low | Backend | Edit CLAUDE.md files. |

### Commands NOT relevant to Cockpit (skip)

| Command | Reason |
|---------|--------|
| `/exit`, `/quit` | Cockpit manages session lifecycle |
| `/config`, `/settings` | Terminal UI settings |
| `/vim` | Terminal editing mode |
| `/theme` | Terminal color theme |
| `/terminal-setup` | Terminal keybindings |
| `/desktop`, `/app` | macOS/Windows desktop app |
| `/login`, `/logout` | Auth managed by Cockpit |
| `/doctor` | CLI health check |
| `/feedback`, `/bug` | CLI feedback |
| `/resume`, `/continue` | Cockpit manages sessions |
| `/fork` | Session forking, Cockpit could support later |
| `/chrome` | Chrome integration |
| `/ide` | IDE integration |
| `/mcp` | MCP server management |
| `/skills` | CLI skills management |
| `/plugin`, `/reload-plugins` | CLI plugins |
| `/hooks` | CLI hook config |
| `/agents` | CLI agent config |
| `/stickers`, `/passes` | Misc |
| `/init` | CLAUDE.md initialization |
| `/install-github-app` | GitHub app setup |
| `/install-slack-app` | Slack app setup |
| `/sandbox` | Sandbox mode toggle |
| `/security-review` | Could add later as a skill |
| `/pr-comments` | Could add later |
| `/release-notes` | CLI release notes |
| `/stats`, `/usage`, `/insights` | Could add later |
| `/extra-usage`, `/upgrade`, `/privacy-settings` | Account management |
| `/add-dir` | Could add later |
| `/keybindings` | Terminal keybindings |
| `/statusline` | Terminal status line |
| `/remote-control`, `/remote-env` | Remote control |
| `/mobile`, `/ios`, `/android` | Mobile app |
| `/rewind`, `/checkpoint` | Could add later with snapshot support |
| `/copy` | Terminal clipboard |
| `/tasks` | Background task management |

## Implementation plan

### Phase 1: Core commands

**1. Command detection in session-manager.ts `sendMessage()`**

Intercept messages starting with `/` before writing to stdin.

```typescript
sendMessage(sessionId: string, text: string): boolean {
  if (text.startsWith("/")) {
    return this.handleCommand(sessionId, text);
  }
  // ... existing logic
}
```

**2. New `handleCommand` method on SessionManager**

Parse the command name and arguments. Emit events back through the session emitter so the frontend picks them up through the existing WebSocket pipeline.

`/clear` (aliases: `/reset`, `/new`):
- Reset `session.messages` to empty array
- Kill existing process if running
- Set `hasSpawnedBefore = false` so next message starts fresh (no `--resume`)
- Emit a new event type that tells the frontend to clear its message list
- Persist

`/compact [instructions]`:
- Kill existing process
- Next message will spawn with `--resume`, which triggers Claude's built-in context compaction
- Store optional instructions somewhere (unclear how to pass focus instructions through resume)

`/model [model]`:
- Store model preference on the session
- Kill existing process
- Next spawn includes `--model` flag
- Emit system message confirming the switch

`/help`:
- Emit a synthetic system message listing available commands
- No process interaction needed

`/rename [name]`:
- Update `session.info.name`
- Persist
- Emit status update

**3. New message types**

Add to `ServerMessage` in `src/types/index.ts`:

```typescript
| { type: "session:clear"; sessionId: string }
| { type: "session:system"; sessionId: string; text: string }
```

**4. Frontend handling in use-session.ts**

Add cases to the message handler switch:
- `session:clear`: reset messages state to `[]`
- `session:system`: display as a system/info message in the chat

**5. System message rendering**

Add a visual treatment for system messages (distinct from user and assistant messages). Centered, muted text like "Conversation cleared" or "Model switched to opus".

### Phase 2: Nice to have

- `/cost` and `/context` - requires token tracking from stream events
- `/fast` - model configuration toggle
- `/diff` - run git diff in session cwd, display output
- `/export` - client-side conversation export
- `/plan` - toggle plan mode flag on session
- Autocomplete/hint when user types `/` in the input area

## Files to change

- `src/server/session-manager.ts` - command interception and handling
- `src/types/index.ts` - new message types
- `src/hooks/use-session.ts` - handle new server message types
- `src/server/ws-handler.ts` - forward new event types
- `src/components/chat-view.tsx` or message renderer - system message display

## Key finding

There is no programmatic way to discover slash commands from the Claude CLI. The `--disable-slash-commands` flag exists but no `--list-slash-commands` or equivalent. The binary is a compiled native executable (not JS), so the command list cannot be extracted at runtime. Commands must be hardcoded based on the official docs.
