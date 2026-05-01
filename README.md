<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/banner-dark.png" />
    <img src="public/banner-light.png" width="480" alt="Cockpit" />
  </picture>
</p>

<p align="center">A web UI for Claude Code that frees it from your terminal.</p>

## Why

Claude Code is great. It's also a terminal app. One window, one machine, foreground only. Cockpit takes the same engine and runs it as a server you reach from any browser.

Three things follow:

1. **Claude Code on your phone.** Reply to your assistant from a train, a kitchen, anywhere a browser opens.
2. **Many Claude Code sessions running at once.** Switch between projects without juggling tmux panes. Sessions live on the server, so closing the browser does not kill them. The chat view stitches across `/clear` so long threads keep their full visual history.
3. **Cron-driven Claude Code.** Schedule a prompt, walk away. Each run produces a transcript that renders the same as a live session.

Inside a session: a diff viewer for code changes (split or inline), a file viewer with syntax highlighting, message search across the full transcript, and plan-mode approvals when Claude proposes a plan.

It also takes care of things you usually hand-edit: agents, skills, hooks, MCP servers, CLAUDE.md memory. All editable from the UI.

PR reviews are a first-class flow. Pick an org, pick a repo, pick a PR. Cockpit reads the diff via the GitHub CLI and starts a Claude session scoped to it. Diff on one side, chat on the other.

Run it on your laptop the way you'd run the TUI. Or run it on a home server and reach it from your phone. Same UI either way.

## Screenshots

<p align="center">
  <a href="docs/screenshots/chat-view.png"><img src="docs/screenshots/chat-view.png" width="48%" alt="Chat view with sessions sidebar" /></a>
  <a href="docs/screenshots/session-settings.png"><img src="docs/screenshots/session-settings.png" width="48%" alt="Per-session settings popover" /></a>
</p>

<p align="center">
  <a href="docs/screenshots/scheduled-jobs.png"><img src="docs/screenshots/scheduled-jobs.png" width="48%" alt="Scheduled jobs page" /></a>
  <a href="docs/screenshots/pr-review.png"><img src="docs/screenshots/pr-review.png" width="48%" alt="Pull request review with diff and chat" /></a>
</p>

<p align="center">
  <a href="docs/screenshots/message-search.png"><img src="docs/screenshots/message-search.png" width="48%" alt="Message search across the transcript" /></a>
  <a href="docs/screenshots/settings.png"><img src="docs/screenshots/settings.png" width="48%" alt="Settings page" /></a>
</p>

<p align="center">
  <a href="docs/screenshots/context-usage.png"><img src="docs/screenshots/context-usage.png" width="48%" alt="Context window usage modal" /></a>
  <a href="docs/screenshots/account-usage.png"><img src="docs/screenshots/account-usage.png" width="48%" alt="Account usage modal" /></a>
</p>

## Quick start

```sh
npx @alexjbarnes/cockpit
```

Or install globally:

```sh
npm install -g @alexjbarnes/cockpit
cockpit
```

Open http://localhost:3001 and set a password on first run.

## Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) installed and on PATH
- An Anthropic API key configured for Claude Code
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated, if you want PR reviews

Tested on Linux and macOS. Windows is unverified.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3001` |
| `HOST` | Bind address | `0.0.0.0` |
| `COCKPIT_RESET_PASSWORD` | Set to `true` to reset password on next startup | `false` |

## Remote access

Cockpit binds to `0.0.0.0` by default. On the host machine, open `http://localhost:3001`. From other devices on the same LAN, use the host's local IP (the startup log prints usable URLs).

To reach Cockpit from outside your LAN, prefer [Tailscale](https://tailscale.com/) over port forwarding. Tailscale gives every device a private IP on a flat network without opening router ports or exposing the server publicly.

To restrict Cockpit to the host machine only, set `HOST=127.0.0.1`.

## Documentation

- [Sessions](docs/sessions.md): chat, sidebar, attachments, plan mode, diffs, file view, todos, search, session linking
- [PR reviews](docs/pr-reviews.md): GitHub PR browsing and review sessions
- [Scheduled jobs](docs/scheduled-jobs.md): cron-driven Claude Code runs
- [Settings](docs/settings.md): auth, models, themes, agents, skills, hooks, MCP servers, CLAUDE.md

## Development

```sh
npm install
npm run dev
```

## License

Apache 2.0
