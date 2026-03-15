# Claude Code TUI Commands

Commands handled by the Claude Code terminal UI, not sent to the CLI as skills/slash_commands. Extracted from the binary via `=== "command"` comparisons in `processSlashCommand`.

## Implemented in Aperture

| Command | Implementation |
|---------|---------------|
| `/clear` | session-manager handleCommand (also `/reset`, `/new`) |
| `/model` | session-manager handleCommand |
| `/help` | session-manager handleCommand |
| `/rename` | session-manager handleCommand (Aperture-only) |
| `/btw` | client-side in use-session sendMessage, sends mid-stream nudge |
| `/compact` | passes through to CLI |
| `/cost` | passes through to CLI |

## Not yet implemented

| Command | What it does | Priority |
|---------|-------------|----------|
| `/config` | Open/show configuration | Low |
| `/diff` | Show git diff of changes Claude made in session | Medium |
| `/fast` | Toggle fast mode (same model, faster output) | Medium |
| `/status` | Show session status info | Low |
| `/tag` | Toggle a searchable tag on the current session | Low |
| `/thinking` | Toggle thinking mode | Low (already have UI toggle) |
| `/mcp` | Show MCP server status | Low |
| `/login` | Manage authentication | N/A for web UI |
| `/exit` | Exit the TUI | N/A for web UI |
| `/ide` | Connect to IDE | N/A for web UI |
| `/vim` | Toggle vim editing mode | N/A for web UI |
| `/resume` | Resume a previous session | N/A (handled by session picker) |
| `/init` | Internal initialization | N/A |

## Notes

- These commands do NOT appear in the CLI's `system/init` event `slash_commands` array
- The init event contains skills and CLI-registered commands only
- Aperture-local commands (like `/btw`) are injected via `apertureCommands` in `slash-command-menu.tsx`
- The hardcoded fallback list in `src/lib/commands.ts` is used before init data arrives
