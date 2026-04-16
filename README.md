# Cockpit

Web UI for Claude Code.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) installed and available on PATH
- Anthropic API key

## Quick Start

```sh
bunx cockpit
```

Or install globally:

```sh
bun install -g cockpit
cockpit
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `3001` |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude sessions | (required) |
| `COCKPIT_DISABLE_AUTH` | Set to `true` to disable password auth | `false` |
| `COCKPIT_RESET_PASSWORD` | Set to `true` to reset password on next startup | `false` |

Copy `.env.example` and fill in your values:

```sh
cp .env.example .env
```

## Docker

```sh
docker-compose up
```

## Development

```sh
bun install
bun run dev
```

## License

Apache 2.0
