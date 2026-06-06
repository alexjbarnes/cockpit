---
description: Write an end-to-end integration test that exercises a runtime path against the REAL Claude Code CLI driven by a mock Anthropic API. Use to prove a behavioural acceptance criterion actually works (session spawn, agent tools, permission flow, scheduled jobs, model selection, system-prompt injection) rather than that the code merely exists. This is how you catch "code is present and renders but the feature is dead" bugs that unit tests and static review miss.
---

# Integration-test a cockpit runtime path against the mock CLI

Unit tests prove a helper returns the right value. Static review proves the diff looks correct. Neither proves the feature actually works end to end. For anything whose value is runtime behaviour — the cockpit agent calling a tool, a session spawning with the right flags, a job posting to the inbox, the permission gate allowing/denying — the only honest evidence is driving the real Claude CLI and watching it happen. This harness does that with a scripted mock Anthropic API so it is deterministic and offline.

## When to use
- A behavioural acceptance criterion: "the assistant calls a tool and it succeeds", "asking X returns Y", "a cockpit-agent tool is not denied".
- A spawn-time contract: the CLI receives `--system`, `--mcp-config`, a model, a permission mode.
- A regression you can only see at the wire level (what the CLI sent to the API, what came back, what rendered).

If you only need to assert a pure function's output, write a normal `tests/*.test.ts` vitest unit test instead. Use this harness when the proof requires a running CLI.

## The harness (tests/integration/)
`startHarness()` (in `tests/integration/harness.ts`) boots three things in isolated tmpdirs: a mock Anthropic API on a random port that replays scripted SSE, a seeded `COCKPIT_CONFIG_DIR` + `CLAUDE_CONFIG_DIR` (password, a `mock` provider pointing the CLI at the mock, default model), and a cockpit server (`node dist/server.js`) on a random port. The Playwright fixture in `tests/integration/fixtures.ts` exposes a per-test `harness` and an already-authenticated `page` (it injects the `cockpit_session` cookie), so you navigate straight to authenticated routes.

## Write a test
Model on `tests/integration/hello.spec.ts`. Import the fixture, skip when no CLI is present, script the mock, create a session, drive the UI, assert both the rendered output and what the CLI sent.

```ts
import { execSync } from "node:child_process";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try { execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" }); return true; } catch { return false; }
})();
test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

test("the cockpit agent calls a config tool and it is not denied", async ({ page, harness }) => {
  // Script the mock: turn 1 emits a tool_use, turn 2 a final text answer.
  harness.mock.setScript([
    { events: toolUseResponse("list_jobs", {}) },
    { events: textResponse("You have 2 scheduled jobs.") },
  ]);

  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
    data: { cwd: harness.configDir, cockpitAgent: true, runtime: "pty" },
  });
  const { sessionId } = await res.json();

  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(harness.configDir)}`);
  const input = page.getByTestId("message-input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(5000); // let the eager PTY spawn settle before sending
  await input.fill("list my jobs");
  await page.getByTestId("btn-send").click();

  await expect(page.getByText("You have 2 scheduled jobs.")).toBeVisible({ timeout: 30_000 });

  // Assert what reached the API: the system prompt and the tool result round-tripped,
  // so the tool was NOT denied. getRequests() returns { url, body } for each call.
  const calls = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages");
  expect(calls.length).toBeGreaterThanOrEqual(2); // tool turn + follow-up turn
  expect(calls[0].body).toContain("Cockpit Assistant"); // --system prompt arrived
});
```

## Scripting the mock (tests/mock-api/builder.ts)
- `textResponse(text, stopReason?)` — a plain assistant text turn.
- `toolUseResponse(name, input, opts?)` — an assistant turn that calls a tool (drives the permission/tool path).
- `askUserQuestionResponse(...)`, `errorResponse(status, message)`, `messageStop(usage)` for the other cases.
- `harness.mock.setScript([{ events: <builder> }, ...])` sets one entry per conversation turn; the last entry repeats if the CLI makes more calls.
- `harness.mock.getRequests()` returns every request the CLI made, with `url` and `body`. This is your wire-level assertion surface: the `--system` prompt, the user message, and tool results all show up in `/v1/messages` bodies. CLI calls carry a `?beta=true` query, so match on `r.url.split("?")[0]`.

## Asserting spawn args without a browser
If you only need to prove the CLI was spawned with a flag (e.g. `--system` or `--mcp-config` is present for `cockpitAgent` sessions), a fast vitest unit test that spies on the spawn args is cheaper than a full browser run. Model on `tests/session-manager-mcp-lifecycle.test.ts`. Use the integration harness when the proof requires the CLI to actually run and respond.

## Run it
- `npm run test:integration` (the `pretest:integration` script runs `npm run build` first; the harness runs `node dist/server.js` in production mode, so rebuild after any source edit).
- Needs the `claude` binary on PATH, or `CLAUDE_BIN=/path/to/claude`. Tests `test.skip` when it is absent — **a skipped integration test is not a passing one.** Do not treat a green run with everything skipped as verification; confirm the CLI was actually present.
- `COCKPIT_IT_DEBUG=1` surfaces cockpit's logs to stdout when a test hangs.
- `runtime` defaults to `pty`; pass `{ runtime: "stream" }` to `startHarness` (or session create) to exercise the stream path.

## Gotchas
- 60s per-test timeout. The PTY needs a settle window after session create before the first `message:send`, or the send races the spawn — the `waitForTimeout(5000)` in the example is load-bearing.
- The mock replays a fixed script; it is not a real model. Script exactly the turns your path needs.
- Production-mode server means stale `dist/` serves old code. If your change does not show up, you forgot to rebuild.

## Reference
`tests/integration/harness.ts`, `tests/integration/fixtures.ts`, `tests/integration/hello.spec.ts`, `tests/mock-api/builder.ts`, `tests/mock-api/server.ts`.
