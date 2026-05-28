# Integration Tests

End-to-end tests that drive the **real Claude Code CLI** through cockpit, with all API traffic going to a **mock Anthropic server**. Tests run in a browser via Playwright.

This harness exists to hunt bugs in the cockpit ↔ CLI layer: transcript parsing, hook event flow, WebSocket protocol, context-window accounting, UI rendering of streamed content. Real model variance is removed by the mock; everything else is exercised end-to-end.

## Status

In active development. See the section "Building this out" below for what is and isn't done.

## Architecture

```
+-------------------+      WebSocket / HTTP      +------------------+
|    Playwright     |  <---------------------->  |  Cockpit server  |
|  (Chromium tab)   |                            |   (tsx server)   |
+-------------------+                            +------------------+
                                                          |
                                                   spawns | (PTY or stream)
                                                          v
                                                 +------------------+
                                                 | claude-code CLI  |
                                                 | ANTHROPIC_BASE_  |
                                                 | URL=http://...   |
                                                 +------------------+
                                                          |
                                                  POST /v1/messages
                                                          v
                                                 +------------------+
                                                 |   Mock Anthropic |
                                                 |    API server    |
                                                 +------------------+
```

Three processes:

1. **Mock API server** — `tests/mock-api/server.ts`. Speaks SSE streaming on `POST /v1/messages`. Tests upload a turn script via `POST /__script`; the mock replays the scripted events for each subsequent CLI request.

2. **Cockpit server** — the normal `tsx server.ts`, spawned with two key env vars:
   - `COCKPIT_CONFIG_DIR=<tmpdir>` — cockpit's own state (`providers.json`, `password.json`, etc.) lives here instead of `~/.cockpit`.
   - `CLAUDE_CONFIG_DIR=<tmpdir>` — the CLI's transcript files and user settings live here instead of `~/.claude`. Cockpit's transcript watcher reads from the same path.
   - `COCKPIT_TOKEN=<random>` — auth bypass: any request with this token validates.

3. **Claude Code CLI** — spawned by cockpit's session manager. Inherits `CLAUDE_CONFIG_DIR` for transcript output. The mock is configured as a custom provider in cockpit, so the CLI gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<mockPort>` and `ANTHROPIC_AUTH_TOKEN=<anything>` injected at spawn time.

Process isolation: every test gets its own tmpdir for `COCKPIT_CONFIG_DIR` and `CLAUDE_CONFIG_DIR`, so tests don't see each other's sessions or providers.

## Environment variables

| Variable | Read by | Purpose |
|----------|---------|---------|
| `COCKPIT_CONFIG_DIR` | cockpit server | Override `~/.cockpit` location. Holds `providers.json`, `password.json`, `defaults.json`, jobs, inbox, session-prefs, mcp cache. |
| `COCKPIT_CACHE_DIR` | cockpit server | Override `~/.cache/cockpit` location. Holds runtime hook-settings and attachments. |
| `CLAUDE_CONFIG_DIR` | cockpit server, CLI | Override `~/.claude` location. CLI reads/writes transcripts and user settings here; cockpit reads them from the same path. |
| `COCKPIT_TOKEN` | cockpit server | Auth bypass for e2e: skips password setup and accepts this exact token as valid. |
| `COCKPIT_INTEGRATION_TESTS` | test runner gating | Set to `1` to opt in. Without it, integration tests skip. |
| `CLAUDE_BIN` | test harness | Path to the claude-code binary. Defaults to `claude` on PATH. |
| `ANTHROPIC_BASE_URL` | CLI | Set per-session by cockpit from the active provider's `envVars`. Tests configure the mock URL into the provider entry. |
| `ANTHROPIC_AUTH_TOKEN` | CLI | Set per-session by cockpit from the active provider's `envVars`. Mock requires a non-empty Bearer token. |

## Running locally

Not runnable yet. See "Building this out".

## Building this out

Tracked in `next` branch commits:

- [x] **Commit 1 — Path helpers and refactor.** Added `src/server/paths.ts` with `getCockpitDir()`, `getCockpitCacheDir()`, `getClaudeDir()`, `getClaudeUserConfigFile()`. Replaced every `~/.cockpit` / `~/.claude` / `~/.cache/cockpit` literal in `src/` to go through these helpers. Env-var overrides take precedence; defaults preserve current behaviour for non-test callers.
- [x] **Commit 2 — Mock API audit and fixes.** `textResponse`/`toolUseResponse` accept a `model` option so tests can vary the echoed model. Added `POST /v1/messages/count_tokens` stub returning `{input_tokens: 0}`. Added `tests/mock-api/server.test.ts` with 8 smoke tests covering auth, SSE shape, request capture, count_tokens, multi-turn scripts. The mock now passes a representative request lifecycle locally without a CLI in the loop.
- [ ] **Commit 3 — Integration harness.** `tests/integration/harness.ts` boots mock + cockpit, seeds the config dir, returns auth token. `tests/integration/fixtures.ts` is the Playwright fixture wrapping it.
- [ ] **Commit 4 — First Playwright test.** "Hello" round-trip: type a message in the browser, mock returns "Hello from mock", assert the text rendered.
- [ ] **Commit 5 — Docs polish.** Fill in the gaps in this file once the harness is real and we know what footguns showed up.
