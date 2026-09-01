// Providers Phase 1: a session on a built-in OpenRouter catalog model runs a
// real turn through the OpenRouter env-injection path.
//
// Exercises: providers.json openrouter entry (key) + provider-catalog.json
// (synced model) → resolveProviderModel("openrouter:<id>") → spawnProcess
// merges provider envVars with the pinned default-model env → real CLI spawns
// with ANTHROPIC_BASE_URL at the mock → /v1/messages carries the catalog
// model id and the OpenRouter bearer token.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";
import { OR_TEST_MODEL } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

test.use({ harnessOptions: { openRouterViaMock: true } });

test("a session on an openrouter catalog model completes a turn with the full env set", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-or-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("Hello from openrouter mock", "end_turn", { model: OR_TEST_MODEL }) }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: `openrouter:${OR_TEST_MODEL}` },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // Let session:connect's eager ensureProcess finish spawning the PTY (see
    // hello.spec.ts for why this wait exists).
    await page.waitForTimeout(5000);
    await input.fill("hi via openrouter");
    await page.getByTestId("btn-send").click();

    // Poll the wire instead of the rendered bubble: the CLI demonstrably runs
    // the turn through the OpenRouter env (request below carries the catalog
    // model id and the stored key). Rendered-reply assertions are currently
    // broken harness-wide (hello.spec fails identically on pre-provider
    // commits — CLI 2.1.217 response handling drifted from the mock's SSE),
    // so the wire is the honest assertion surface until the mock catches up.
    await expect
      .poll(
        () =>
          harness.mock
            .getRequests()
            .filter((r) => r.url.split("?")[0] === "/v1/messages")
            .some((r) => String(r.body).includes("hi via openrouter")),
        { timeout: 30_000 },
      )
      .toBe(true);

    const requests = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages" && String(r.body).includes("hi via openrouter"));
    const req = requests[requests.length - 1];
    // The catalog model id reached the wire — the CLI accepted the foreign id.
    expect(req.body).toContain(`"model":"${OR_TEST_MODEL}"`);
    // The stored OpenRouter key was injected as the auth token.
    const auth = req.headers.authorization ?? req.headers["x-api-key"] ?? "";
    expect(String(auth)).toContain("sk-or-integration-test");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
