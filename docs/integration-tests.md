# Integration Tests

End-to-end tests that drive the **real Claude Code CLI** through cockpit, with all API traffic going to a **mock Anthropic server**. Tests run in a browser via Playwright.

This harness hunts bugs in the cockpit ↔ CLI layer: transcript parsing, hook event flow, WebSocket protocol, context-window accounting, UI rendering of streamed content. Real model variance is removed by the mock; everything else is exercised end-to-end.

## Architecture

```
+-------------------+      WebSocket / HTTP      +------------------+
|    Playwright     |  <---------------------->  |  Cockpit server  |
|  (Chromium tab)   |                            |   (tsx server)   |
+-------------------+                            +------------------+
                                                          |
                                                   spawns | (PTY)
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

Three processes, each in its own tmpdir per test:

1. **Mock API server** — `tests/mock-api/server.ts`. Speaks SSE streaming on `POST /v1/messages`. Tests upload a turn script via `setScript()`; the mock replays the scripted events for each CLI request. Also captures every request (including unknown 404s) for assertions.

2. **Cockpit server** — the normal `tsx server.ts`, spawned in `NODE_ENV=production` with env vars below.

3. **Claude Code CLI** — spawned by cockpit's session manager. Inherits `CLAUDE_CONFIG_DIR` for transcript output. The mock is configured as a custom provider in cockpit, so the CLI gets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` injected at spawn time.

Per-test isolation: each test gets its own `COCKPIT_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, and `workDir` so tests don't see each other's sessions, providers, or transcripts.

## Running locally

```bash
# One-time: install Chromium for Playwright
npx playwright install chromium

# pretest:integration rebuilds .next/ so cockpit serves current src
npm run test:integration

# Debug a single test with cockpit logs visible
COCKPIT_IT_DEBUG=1 npx playwright test --config=tests/integration/playwright.config.ts hello.spec.ts

# Plus mock activity (every unknown endpoint logged)
COCKPIT_IT_DEBUG=1 COCKPIT_MOCK_DEBUG=1 npx playwright test --config=tests/integration/playwright.config.ts
```

Cockpit runs in `NODE_ENV=production` because Next.js dev mode singleton-locks the project directory — a developer's running `npm run dev` would conflict with the harness's spawned cockpit. The trade-off: changes to `src/` aren't visible until `npm run build` runs, which `pretest:integration` does for you.

## Environment variables

| Variable | Read by | Purpose |
|----------|---------|---------|
| `COCKPIT_CONFIG_DIR` | cockpit server | Override `~/.cockpit`. Holds `providers.json`, `password.json`, `defaults.json`, jobs, inbox, session-prefs, mcp cache. |
| `COCKPIT_CACHE_DIR` | cockpit server | Override `~/.cache/cockpit`. Holds runtime hook-settings and attachments. |
| `CLAUDE_CONFIG_DIR` | cockpit server, CLI | Override `~/.claude`. CLI writes transcripts here; cockpit reads them from the same path. |
| `COCKPIT_TOKEN` | cockpit server | Auth bypass: any cookie or Bearer value equal to this passes `validateSession()`. Needs a `password.json` to be on disk too (the early `getSigningKey()` check returns null otherwise). |
| `CLAUDE_BIN` | harness | Path to the claude-code binary. Defaults to `claude` on PATH. |
| `COCKPIT_IT_DEBUG` | harness | When `1`, stream cockpit stdout/stderr to the test runner's console. |
| `COCKPIT_MOCK_DEBUG` | mock server | When `1`, log every unknown endpoint the CLI hits. Used the first time the harness was wired up to find calls like `HEAD /` and `POST /v1/messages?beta=true`. |
| `ANTHROPIC_BASE_URL` | CLI (set by cockpit) | Injected from the mock provider's `envVars`. |
| `ANTHROPIC_AUTH_TOKEN` | CLI (set by cockpit) | Injected from the mock provider's `envVars`. CLI sends as `Authorization: Bearer <token>`. |

## Harness API

`tests/integration/harness.ts` exports `startHarness()`:

```ts
const h = await startHarness();
// h.mock           - MockApiServer (setScript / getRequests / reset / stop)
// h.cockpitUrl     - "http://127.0.0.1:<port>"
// h.cockpitToken   - COCKPIT_TOKEN value (already in the browser cookie via fixture)
// h.configDir      - tmpdir holding providers.json / password.json / defaults.json
// h.claudeDir      - tmpdir for the CLI's projects/ transcripts
// h.stop()         - tears down everything and removes both tmpdirs
```

Seeded state:

- `<configDir>/password.json` — required to make the `COCKPIT_TOKEN` bypass active. `validateSession()` calls `getSigningKey()` first and returns false if no signing key exists, regardless of the bypass token.
- `<configDir>/providers.json` — one custom provider with id `mock`, model `claude-sonnet-4-6`, envVars pointing the CLI at the mock.
- `<configDir>/defaults.json` — sets `modelSlots.main` to `mock:claude-sonnet-4-6` and `bypassAllPermissions: true`.
- `<claudeDir>/.claude.json` — pre-set with `theme: "dark"` and `hasCompletedOnboarding: true` so the CLI's first-run onboarding flow (welcome banner, theme picker, security notes) doesn't appear.

The Playwright fixture in `tests/integration/fixtures.ts` wraps the harness and injects the auth cookie into every browser context. Test files just import `test` from `./fixtures` and use the `harness` fixture.

## Writing a test

```ts
import { textResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";

test("my scenario", async ({ page, harness }) => {
  // 1. Tell the mock what to reply with.
  harness.mock.setScript([{ events: textResponse("Hello from mock") }]);

  // 2. Create the session via the API to skip the new-session UI.
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
    data: { cwd: workDir, runtime: "pty" },
  });
  const { sessionId } = await res.json();

  // 3. Navigate, wait for the session to settle, send a message.
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
  await expect(page.getByTestId("message-input")).toBeVisible();
  await page.waitForTimeout(5000);                  // see "PTY spawn race" below
  await page.getByTestId("message-input").fill("hi");
  await page.getByTestId("btn-send").click();

  // 4. Assert UI behaviour and mock traffic.
  await expect(page.getByText("Hello from mock")).toBeVisible({ timeout: 30_000 });
  const reqs = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages");
  expect(reqs.length).toBeGreaterThanOrEqual(1);
});
```

Useful selectors (already present in `src/components/`):

- `[data-testid="message-input"]` — the chat textarea
- `[data-testid="btn-send"]` — the send button
- `[data-testid="status-pending|running|unread|idle"]` — sidebar status dots
- `[data-testid="runtime-pty|stream"]` — runtime toggle in session settings

Asserting against `getByText("...")` is fine for most response content; the message-bubble component doesn't yet expose per-role testids.

## Gotchas (these all bit us getting the first test working)

**PTY spawn race.** `session:connect` eagerly calls `ensureProcess` to fetch CLI init data (slash commands, agents). The spawn is async. If a `message:send` arrives while `PtyRuntime.isAlive` is still false, `sendMessage` falls through to a second spawn and the user input never reaches the first PTY. The test waits ~5 seconds after the input area renders, which is enough for PTY startup on a hot CLI binary. A cleaner signal would be welcome but the wait works.

**Mock URL matching.** The CLI hits `/v1/messages?beta=true` (and the query string varies). Filter on `r.url.split("?")[0]` when asserting on mock requests, not exact match.

**Auth header is `Authorization: Bearer`, not `x-api-key`.** The harness uses `ANTHROPIC_AUTH_TOKEN`, which the CLI sends as Bearer. The alternative `ANTHROPIC_API_KEY` triggers a TUI prompt "Detected a custom API key in your environment — use it? 1. Yes 2. No (recommended)" with the default at "No", and the PTY can't easily dismiss it. The mock accepts both headers as a defensive measure.

**First-run dialogs in a fresh `CLAUDE_CONFIG_DIR`.** Real users complete the CLI's onboarding once interactively; tests with a fresh dir see all of it. We pre-seed `.claude.json` with `theme: "dark"` and `hasCompletedOnboarding: true` to skip the welcome flow. The workspace trust prompt is handled by cockpit's own `pty-session.handleTrustDialog`. The bypass-mode warning is suppressed by `skipDangerousModePermissionPrompt: true` that cockpit writes into the per-session settings.json (see `src/server/claude-settings.ts`) — this benefits real users too.

**CLI bootstrap calls.** Without `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, the CLI tries to hit `api.anthropic.com/api/claude_cli/bootstrap` directly (not via `ANTHROPIC_BASE_URL`) to fetch the model catalog. The harness sets this to skip those calls.

**Hardcoded model allowlist.** `--model mock-sonnet` fails because the CLI rejects unknown model names before any API call. Use a real Anthropic model ID (e.g. `claude-sonnet-4-6`) in the provider entry. The mock doesn't care what the name actually is; it just echoes back what you scripted.

## How the auth bypass works

`auth.ts:validateSession()` runs in this order:

1. `getSigningKey()` returns null when no `password.json` exists → return false immediately. The bypass never gets a chance.
2. If `process.env.COCKPIT_TOKEN` is set and the incoming token matches it exactly → return true.
3. Otherwise, validate the HMAC signature on the token.

So the harness has to write a `password.json` (any salt/hash works) **and** set `COCKPIT_TOKEN` for the bypass to kick in. The fixture sets a `cockpit_session=<token>` cookie on the browser context so navigation to authenticated routes Just Works.

## Layout

```
tests/
  integration/
    harness.ts             - startHarness(): mock + cockpit + tmpdirs
    fixtures.ts            - Playwright fixture wiring harness + cookie
    playwright.config.ts   - workers=1, screenshots on fail, retain trace
    hello.spec.ts          - "user types 'hi', sees 'Hello from mock'"
  mock-api/
    server.ts              - SSE-streaming /v1/messages, control endpoints
    builder.ts             - textResponse() / toolUseResponse() / etc.
    types.ts               - Anthropic SSE event shapes
    server.test.ts         - 8 unit tests for the mock itself (vitest)
docs/
  integration-tests.md     - this file
```
