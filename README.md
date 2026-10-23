<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/banner-dark.png" />
    <img src="public/banner-light.png" width="480" alt="Cockpit" />
  </picture>
</p>

<p align="center">A web UI for Claude Code that frees it from your terminal.</p>

## Why

Claude Code is great. It's also a terminal app. One window, one machine, foreground only. Cockpit runs the same engine as a server: sessions live on the server, the browser is just a viewer, and closing your laptop kills nothing.

The shape is simple: **browser ↔ Cockpit server ↔ the real Claude Code CLI**. Not a reimplementation of the agent loop, the actual CLI, driven headless or through a pseudo-terminal.

Four things follow:

1. **Claude Code on your phone.** Reply from a train, a kitchen, anywhere a browser opens. The session you started at your desk is right there, still working.
2. **Many sessions running at once.** Switch between projects without juggling tmux panes. Status beacons show which sessions are working, waiting, or idle, and the chat view stitches across `/clear` so long threads keep their full visual history.
3. **Any model through the full agentic loop.** Tool use, file edits, and permission prompts work the same whether the model is Claude, something free off OpenRouter's catalog, or DeepSeek. Providers that only speak the OpenAI wire format run through a built-in translation proxy, thinking traces included.
4. **Unattended agents on a schedule.** Not a cron wrapper: each job is a sandboxed run with its own model, its own tool and MCP allowlists, and a time budget, reporting back through an inbox or straight to your phone.

Inside a session: a tabbed, split-pane layout holding the chat, a diff viewer for code changes (split or inline), a file viewer with syntax highlighting, and an embedded terminal. Messages sent while Claude is working queue server-side and deliver when the turn ends, and `/btw` answers a quick side question in a separate tool-less Claude without disturbing the run. Plus global search across all sessions (Ctrl+Shift+F), searchable prompt history on the up arrow, and plan-mode approvals when Claude proposes a plan. The sidebar keeps sessions, active reviews, file changes, and file trees in collapsible sections.

**Bring every provider under one roof.** One-key connect to OpenRouter, OpenCode Zen, and DeepSeek, or point Cockpit at any Anthropic-compatible endpoint of your own, each with its own credentials. Connect OpenRouter and its whole catalog is a click away, free models included, with live pricing and a FREE badge shown right in the picker. Curate the list down to the handful you actually use, then pick the model per session and per scheduled job, with 200K or 1M context and a thinking level. Each provider tracks its own spend or balance in the usage panel.

Each session runs in **Stream** mode (headless JSON, the default) or **PTY** mode, which drives the interactive CLI inside a pseudo-terminal. PTY exists for a reason: subscription plans bill programmatic and interactive usage differently, and PTY keeps Cockpit sessions on the interactive side. Switch per session.

It also takes care of things you usually hand-edit: agents, skills, hooks, MCP servers, plugins, CLAUDE.md memory. All editable from the UI, or conversationally: the built-in Cockpit Assistant is a Claude session wired to Cockpit's own MCP server, so "create a nightly job that..." becomes a config change you approve or reject.

PR reviews are a first-class flow. Pick an org, pick a repo, pick a PR. Cockpit reads the diff via the GitHub CLI and starts a Claude session scoped to it. Diff on one side, chat on the other. Active reviews pin to the sidebar alongside your sessions. Day-to-day git lives here too: review the working tree, generate a commit message, commit and push without leaving the browser.

**Scheduled jobs** are where the server earns its keep. Give one a prompt and a schedule (a cron expression or a simple interval) and scope it tightly: its own model and thinking level, the exact tools and MCP servers it is allowed to touch, a run-time budget, how long to keep transcripts. It runs unattended, and each run renders as a normal session transcript you can open later. Results land in an inbox, with optional push to Telegram or ntfy.sh, so a nightly dependency bump or a morning PR-triage pass reaches your phone while you are away from the machine.

Run it on your laptop the way you'd run the TUI. Or run it on a home server and reach it from your phone. Same UI either way.

## See it in action

https://github.com/user-attachments/assets/95241a55-8cc7-48b2-8f9b-b2ed58b8dfe2

A tour in under two minutes: sessions running side by side, the real Claude Code making a change and testing it, a file and a terminal next to the chat, switching model mid-session, providers, Insights, the issue tracker, the Cockpit Assistant setting up a job, scheduled jobs and their inbox, and approving a push from a phone notification. Everything in it is made up: [`scripts/tour`](scripts/tour) records it from a throwaway workspace.

## Quick start

```sh
npx @alexjbarnes/cockpit
```

Or install globally:

```sh
npm install -g @alexjbarnes/cockpit
cockpit
```

The startup log prints usable connection URLs (local and network). Open http://localhost:3001 and set a password on first run.

## Prerequisites

- Node.js 22.23.4, 24.22.1 or 26.12.1, or a later release of the same line. Earlier releases still trust certificates issued under the eMudhra intermediate CA keys that were reported compromised.
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
| `COCKPIT_CONFIG_DIR` | Cockpit config location (password, providers, defaults, jobs, inbox) | `~/.cockpit` |
| `CLAUDE_CONFIG_DIR` | Claude config and transcripts Cockpit reads | `~/.claude` |
| `COCKPIT_DEBUG` | Set to `1` to write a structured debug log | unset |

Setting `COCKPIT_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` together lets you run isolated instances side by side. See [Settings](docs/settings.md#environment-variables) for the full list.

## Remote access

Cockpit binds to `0.0.0.0` by default. On the host machine, open `http://localhost:3001`. From other devices on the same LAN, use the host's local IP (the startup log prints usable URLs).

To reach Cockpit from outside your LAN, prefer [Tailscale](https://tailscale.com/) over port forwarding. Tailscale gives every device a private IP on a flat network without opening router ports or exposing the server publicly.

To restrict Cockpit to the host machine only, set `HOST=127.0.0.1`.

## Documentation

- [Sessions](docs/sessions.md): chat, runtime modes, tabbed layout, sidebar, attachments, plan mode, diffs, file view, prompt history, todos, search, session linking
- [Model providers](docs/providers.md): built-in OpenRouter, OpenCode Zen, and DeepSeek gateways, custom Anthropic-compatible providers, the OpenAI translation proxy, context sizes, model slots, and per-provider usage
- [Embedded terminal](docs/terminal.md): in-browser shell with themes and mobile support
- [PR reviews](docs/pr-reviews.md): GitHub PR browsing and review sessions
- [Scheduled jobs](docs/scheduled-jobs.md): cron-driven Claude Code runs
- [Settings](docs/settings.md): auth, models, providers, themes, notifications, inbox, updates, agents, skills, hooks, MCP servers, CLAUDE.md

## Development

```sh
npm install
npm run dev
```

Unit tests run with `npx vitest run`. The [integration suite](docs/integration-tests.md) drives the real Claude Code CLI against a mock Anthropic API through Playwright, so runtime behaviour is proven rather than assumed. Issues and PRs welcome.

## License

Apache 2.0
