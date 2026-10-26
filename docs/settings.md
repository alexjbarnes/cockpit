# Settings and Claude config

Settings is where you configure Cockpit and the Claude Code environment it drives.

## Auth

Cockpit ships with password auth on by default. The first run prompts you to set a password (4+ characters, scrypt-hashed, stored in `~/.cockpit/password.json`).

To reset the password: set `COCKPIT_RESET_PASSWORD=true` and restart.

## Session defaults

The Settings page picks the defaults for new sessions:

- Model. The picker lists Anthropic's Haiku, Sonnet, Opus and Fable with their versions, and every model from a connected gateway or custom provider (see [Providers](providers.md)), with a search and a provider filter. A provider's model is stored qualified, `provider:model`. Models can be set per slot: main, subagent, and fast.
- Context size. 200K (default) or 1M, for models that support both. A provider's model offers whichever sizes its catalogue declares.
- Thinking level. Low, Medium, High, XHigh, Max. Trades latency for depth of reasoning. Only the levels the model supports are offered, and picking a model that cannot run the current level moves it to one it can.
- Default runtime is Stream; choose Stream or PTY per session (see [Sessions: runtime mode](sessions.md#runtime-mode)).
- Permission bypass. Off by default. When on, Claude skips permission prompts. An orange warning is shown when active.
- Sandbox Bash. Off by default. When on, new sessions run Bash in the OS sandbox, with any domains listed here added to the shared rules below.

Existing sessions keep their own settings. Defaults only apply to new sessions.

## Sandbox

Settings → Sandbox edits Claude Code's own sandbox rules, the `sandbox` block of `~/.claude/settings.json`. They apply to every sandboxed Claude session, in cockpit or not, and a running session picks up a change straight away, so saving needs no restart. Everything else in that file is left as it was.

- Allowed and denied domains for sandboxed network access.
- Commands run outside the sandbox (`excludedCommands`), matched like Bash permission rules. They still go through the usual permission check.
- Extra writable paths, paths never writable, paths never readable, and paths readable again inside a denied one.
- Unix sockets and local ports (macOS). Allowing local ports lets sandboxed commands start and reach servers on localhost, and opens every local port to them.
- Whether a command the sandbox blocks may ask to be retried outside it.

Whether a session is sandboxed at all is its own switch: the session panel, the default above, and a switch per scheduled job. A session's own domains are added to these rules rather than replacing them.

Cockpit's own directory (`~/.cockpit`) is always unreadable to sandboxed commands, since it holds the key cockpit's login tokens are signed with and the providers' API keys.

## Providers

Beyond the built-in Anthropic models, the Providers page connects three built-in gateways with a single API key each (OpenRouter, OpenCode Zen, DeepSeek) and lets you add custom Anthropic-compatible providers (proxies, alternate endpoints) with their own environment variables and model list. Providers that speak only the OpenAI wire format run through a built-in translation proxy, and each provider shows its own spend or balance in the usage indicator. See [Model providers](providers.md) for the full walkthrough.

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

`/hooks` manages event-driven automation. Hooks fire on Claude Code events. The page offers the full set the CLI documents, from `SessionStart` and `UserPromptSubmit` through `PreToolUse` and `PermissionRequest` to `SessionEnd`, `Elicitation` and the task/teammate lifecycle; `PreToolUse`, `PermissionRequest` and the other blocking ones can deny or stop what they wrap. Each hook is a shell command. Scopes: Global, Project, Local (project-local, not committed to the repo).

### MCP servers

`/mcp-servers` manages Model Context Protocol integrations. Add a server with name, type (stdio or SSE), and command or URL. The Test button validates the connection. Same global and project scope split as agents.

The Claude account card lists the servers the CLI itself reports, which is the only place an account connector (`claude.ai <name>`) appears: they live on the account, not in any config file Cockpit can read. The list comes from `claude mcp list`, which health-checks every server, so it takes a few seconds and is cached for a minute.

Authenticate runs the CLI's own sign-in. A connector prints a URL to authorise at on claude.ai; a server that speaks OAuth prints its own authorisation URL and then wants the URL the browser was redirected to pasted back. Signing in replaces the credentials the server already holds, so abandoning the flow part-way can leave a working server disconnected. Servers that use OAuth also have an Authenticate button on their own page.

Account connectors only load in sessions that sign in with the Claude account. A session running on another provider sets its own API credentials, which the CLI treats as taking precedence, so those sessions never use them.

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

## Telemetry (experimental)

Settings → Appearance → Experimental → Telemetry. Off by default. When on, every session started afterwards sends Claude Code's OpenTelemetry to cockpit: metrics (tokens, cost, active time, lines changed), events (each prompt, API request, tool decision and tool result) and traces (each turn, API call and tool call, with timings). Prompts, replies, tool input and tool output are included. Raw API request bodies are not.

It is stored in `~/.cockpit/telemetry.db`, a SQLite database readable only by you, for 30 days. Past 2 GB the oldest prompt and tool text goes first, so the numbers outlast it. Read it through `GET /api/telemetry` (filters: `session`, `cliSession`, `signal`, `name`, `since`, `until`; paging: `order=time|ingest`, `cursor`, `after`, `limit`; `content=inline` puts long text back) and `GET /api/telemetry/stats`.

- Needs Node 22.13 or later, whose built-in SQLite it uses. On an older Node the switch is disabled and says why.
- A session leaves telemetry alone if Claude Code is already sending it somewhere: an endpoint, headers or a headers helper in managed settings, or in your own settings or environment while telemetry is switched on there. It does the same when managed settings choose the gRPC protocol, which cockpit cannot receive; a managed `http/protobuf` or `http/json` is fine, since cockpit reads both. The stats say which key decided it.
- The CLI's telemetry is in beta, so names and attributes can change between versions. `cost_usd` is the CLI's estimate at Anthropic's prices, and is wrong for other providers' models.
- Stream-runtime sessions do not send any.

### Insights

While telemetry is on, the sidebar footer's chart button opens Insights (`/insights`), which charts what is stored over the last 24 hours, 7 days or 30 days:

- **Overview**: spend, tokens and cache use, turns, tool calls, time waiting on you, API errors, lines changed and prompts, with spend per day by model and the sessions that cost most.
- **Spend**: spend per day by model or provider, tokens by kind with the cache hit rate, what the spend went on (conversation, subagents, session titles, web fetches) and at which effort level, sessions, projects and scheduled jobs ranked by spend, and the most expensive turns.
- **Speed**: each model's time to first token, response time and output speed, typical and slowest tenth, how long turns take, and where their time goes (model, tools, waiting for approval, other).
- **Tools**: calls, failures and time per tool, Bash by program and the slowest commands, MCP tools by server, the files touched most, and who answered permission prompts.
- **Health**: API errors and retries, tool failures, MCP servers that failed to connect, and the time Claude Code spent running hooks.
- **Activity**: lines added and removed, edits by language, commits and pull requests, prompts per day and by weekday and hour.

Tapping a session anywhere it is listed, or **Session insights** in a session's context ring, narrows every tab to that session and adds **Turns** (each turn split into where its time went, opening into a timeline of its requests and tool calls) and **Context** (how full the context was at each request).

Spend is priced by the provider that served each request. Anthropic's models use Claude Code's own figure, which is what the requests would cost at API prices; other providers' models use the provider's catalogue prices at the time you look, and a model with no price is counted as unpriced rather than free. The provider is recorded with each session's telemetry; for telemetry recorded before that, it comes from the session's model setting. Your own active time is not shown: Claude Code only counts typing in its own terminal, which cockpit replaces. Who answered a permission prompt (you, bypass, cockpit's rules or the terminal) is recorded by cockpit from this release on.

## Inbox

The inbox at `/inbox` collects messages from scheduled job completions and system events. Each message has a title, body, priority level (info, warning, error), and timestamp.

The inbox button in the sidebar shows an unread count badge. From the inbox page you can mark all as read or clear all messages. Select turns on checkboxes: pick messages one by one, or all at once from the count, then mark them read or unread, or delete them together.

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
| `COCKPIT_ISSUES_ENABLED` | `1` or `0` overrides the issue tracker switch for this run, without saving it | unset |
| `COCKPIT_TELEMETRY_ENABLED` | `1` or `0` overrides the telemetry switch for this run, without saving it | unset |

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
| `~/.cockpit/telemetry.db` | Recorded telemetry, when switched on |
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
