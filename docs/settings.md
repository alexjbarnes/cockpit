# Settings and Claude config

Settings is where you configure Cockpit and the Claude Code environment it drives.

## Auth

Cockpit ships with password auth on by default. The first run prompts you to set a password (4+ characters, scrypt-hashed, stored in `~/.cockpit/password.json`).

To reset the password: set `COCKPIT_RESET_PASSWORD=true` and restart.

## Session defaults

The Settings page picks the defaults for new sessions:

- Model. Built-in Haiku, Sonnet, or Opus with a version switcher, or any model from a custom provider (see [Providers](#providers)). Models can be set per slot: main, subagent, and fast.
- Context size. 200K (default) or 1M, for models that support both.
- Thinking level. Low, Medium, High, XHigh, Max. Trades latency for depth of reasoning. Only the levels the model supports are offered.
- Default runtime is Stream; choose Stream or PTY per session (see [Sessions: runtime mode](sessions.md#runtime-mode)).
- Permission bypass. Off by default. When on, Claude skips permission prompts. An orange warning is shown when active.

Existing sessions keep their own settings. Defaults only apply to new sessions.

## Providers

Beyond the built-in Anthropic models, you can configure custom Anthropic-compatible providers (proxies, gateways, alternate endpoints) from the Providers page, each with its own environment variables and model list. See [Model providers](providers.md) for the full walkthrough.

## UI preferences

- Theme. Light, Dark, or System.
- Diff style. Split (side by side) or inline.
- Collapsible sections. Toggle whether thinking blocks, read results, edit results, and tool calls collapse by default.
- Message stitching. On by default. When enabled, the chat view loads messages from previous CLI sessions within the same Cockpit session, keeping full visual history across `/clear` boundaries. Turn off to show only the current CLI session's messages.
- Reviews. On by default. Shows the Reviews section in the sidebar and enables PR review features. Turn off to hide reviews entirely.
- Dismiss keyboard on send. On by default. Automatically dismisses the on-screen keyboard on mobile after sending a message.

## Versions and updates

Settings shows the installed versions of both Cockpit and the Claude Code CLI and checks npm for the latest of each. An Update button installs the latest globally, with native-install detection so it uses the right command for how you installed. Each one links to its changelog.

## Customizations

Cockpit edits Claude's configuration files for you so you don't have to hand-edit dotfiles. Each customization lives at its own route.

### Agents

`/agents` manages subagents. Each agent has a name, system prompt, allowed tools, and scope.

Scopes:

- Global. Stored in `~/.claude/agents/`. Available in every session.
- Project. Stored in `.claude/agents/` at the repo root. Travels with the repo.

### Skills

`/skills` manages reusable prompt fragments. Trigger via the mention menu or as a slash command. Same scoping as agents.

### Commands

`/commands` manages custom slash commands. Define name, description, and prompt template. Custom commands appear in the slash menu alongside built-ins.

### Hooks

`/hooks` manages event-driven automation. Hooks fire on Claude Code events:

- UserPromptSubmit
- PreToolUse (blocking; can deny a tool call)
- PermissionRequest (blocking; can auto-allow or deny)
- Stop
- SubagentStop

Each hook is a shell command. Scopes: Global, Project, Local (project-local, not committed to the repo).

### MCP servers

`/mcp-servers` manages Model Context Protocol integrations. Add a server with name, type (stdio or SSE), and command or URL. The Test button validates the connection. Same global and project scope split as agents.

### CLAUDE.md

`/claude-md` edits Claude's memory files inline. Three scopes:

- User: `~/.claude/CLAUDE.md`
- Project: `./CLAUDE.md`
- Project hidden: `./.claude/CLAUDE.md`

The editor is CodeMirror with markdown support. Save writes through to the actual file Claude reads.

## Notifications

The notifications page at `/settings/notifications` configures external alerts for Cockpit events like scheduled job completions and inbox messages.

Two providers are supported:

- **Telegram.** Requires a bot token and chat ID. Create a bot via BotFather, then use `getUpdates` to find your chat ID.
- **ntfy.sh.** Requires a server URL and topic. Optionally provide an access token for private topics.

Each provider can be enabled or disabled independently. Providers support priority filtering (info, warning, error) so you can limit alerts to failures only.

A base URL setting lets you configure the URL prefix for clickable links in notification messages (useful when running Cockpit behind a reverse proxy or on a remote server).

Use the Test button to send a test notification to each configured provider.

Configuration is stored in `~/.cockpit/notifications.json`.

## Inbox

The inbox at `/inbox` collects messages from scheduled job completions and system events. Each message has a title, body, priority level (info, warning, error), and timestamp.

The inbox button in the sidebar shows an unread count badge. From the inbox page you can mark all as read or clear all messages.

Inbox messages are stored in `~/.cockpit/inbox.jsonl`. When a message arrives, it is also dispatched to any configured notification providers.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Server port | `3001` |
| `HOST` | Bind address | `0.0.0.0` |
| `COCKPIT_RESET_PASSWORD` | Force password reset on next startup | `false` |
| `COCKPIT_CONFIG_DIR` | Location of Cockpit config (password, providers, defaults, jobs, inbox) | `~/.cockpit` |
| `CLAUDE_CONFIG_DIR` | Location of Claude config and transcripts that Cockpit reads | `~/.claude` |
| `COCKPIT_CACHE_DIR` | Location of per-session caches (hook settings, attachments) | `~/.cache/cockpit` |
| `COCKPIT_DEBUG` | Set to `1` to write a structured debug log (see Troubleshooting) | unset |
| `COCKPIT_TOKEN` | Auth-bypass token for automated/embedded use; requests presenting it skip the login. Keep it secret | unset |

Setting `COCKPIT_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` lets you run fully isolated Cockpit instances side by side.

Claude Code's own environment variables (`ANTHROPIC_API_KEY`, etc.) are read by the CLI as normal.

## Paths

Cockpit config paths are under `COCKPIT_CONFIG_DIR` (default `~/.cockpit`); Claude paths are under `CLAUDE_CONFIG_DIR` (default `~/.claude`).

| Path | Used for |
|---|---|
| `~/.cockpit/password.json` | Password hash |
| `~/.cockpit/providers.json` | Custom model providers |
| `~/.cockpit/defaults.json` | Session defaults (model slots, context size, thinking level) |
| `~/.cockpit/notifications.json` | Notification provider config |
| `~/.cockpit/inbox.jsonl` | Inbox messages |
| `~/.cockpit/scheduled-jobs.json` | Scheduled job definitions |
| `~/.cockpit/job-runs/` | Scheduled job run history |
| `~/.cockpit/job-locks/` | Scheduled job locks |
| `~/.claude/cockpit/pinned_sessions.json` | Pinned session list |
| `~/.claude/plans/` | Plan files written by Claude |
| `~/.claude/agents/` | Global agents |
| `.claude/agents/` | Project agents |
| `~/.claude/CLAUDE.md` | User memory |
| `./CLAUDE.md` | Project memory |

## Troubleshooting

### Forgot password

Delete `~/.cockpit/password.json` and restart. Cockpit prompts for a new password on next visit. Same effect as setting `COCKPIT_RESET_PASSWORD=true` for one start.

### Claude Code CLI not found

Cockpit shells out to `claude` on PATH. Run `which claude` to confirm the binary is reachable. If you installed via `mise`, `brew`, or `nvm`, make sure that tool's shim directory is on the PATH of the user running Cockpit (which may differ from your interactive shell, especially under systemd or a launchd plist).

### Server starts in dev mode when you expected production

The server treats anything other than `NODE_ENV=production` as dev. `npm run start` and the published `bin/cockpit.js` both set it explicitly. If you spawn `node dist/server.js` directly without `NODE_ENV=production`, you get dev mode (Next runs HMR, no static optimisations).

### Debug log

Set `COCKPIT_DEBUG=1` before starting. Cockpit writes a structured JSONL log to `~/.cockpit/debug.jsonl` capturing stream-json traffic between Cockpit and Claude, WebSocket events, and per-session diagnostics.

- Follow: `tail -f ~/.cockpit/debug.jsonl | jq .`
- Clear: `truncate -s 0 ~/.cockpit/debug.jsonl`
- From the repo: `just debug-log` and `just debug-clear`.
