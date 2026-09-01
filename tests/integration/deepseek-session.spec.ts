// A session on a DeepSeek model runs a real turn through cockpit's proxy in
// anthropic passthrough mode.
//
// Exercises: providers.json deepseek entry (key + models) →
// resolveProviderModel ("deepseek:<id>") → spawn env pointing
// ANTHROPIC_BASE_URL at the in-process proxy with the stored key as the CLI's
// own ANTHROPIC_AUTH_TOKEN → real CLI speaks Anthropic wire → proxy relays
// verbatim to the mock's /v1/messages (DeepSeek's Anthropic-native door).
// Also proves the foreign-model effort path end to end: the seeded model
// declares effortLevels, so the spawn carries --effort high +
// CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, and the upstream request must carry a
// thinking/effort config.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { DEEPSEEK_TEST_MODEL } from "./harness";

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

test.use({ harnessOptions: { deepseekViaMock: true } });

test("a session on a deepseek model reaches the anthropic door with its own key and effort", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-deepseek-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: `deepseek:${DEEPSEEK_TEST_MODEL}` },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // Let session:connect's eager ensureProcess finish spawning the PTY (see
    // hello.spec.ts for why this wait exists).
    await page.waitForTimeout(5000);
    await input.fill("hi via deepseek passthrough");
    await page.getByTestId("btn-send").click();

    // The wire is the assertion surface (rendered-reply checks are broken
    // harness-wide, see openrouter-session.spec.ts). The mock's /v1/messages
    // door receiving the relayed turn proves the passthrough path.
    await expect
      .poll(
        () =>
          harness.mock
            .getRequests()
            .filter((r) => r.url.split("?")[0] === "/v1/messages")
            .some((r) => String(r.body).includes("hi via deepseek passthrough")),
        { timeout: 30_000 },
      )
      .toBe(true);

    const requests = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages" && String(r.body).includes("hi via deepseek passthrough"));
    const req = requests[requests.length - 1];
    const body = JSON.parse(req.body) as {
      model: string;
      thinking?: { type?: string };
      output_config?: { effort?: string };
    };
    // Bare model id on the anthropic wire, relayed verbatim.
    expect(body.model).toBe(DEEPSEEK_TEST_MODEL);
    // The CLI authenticates itself: the stored key rode in as its own
    // ANTHROPIC_AUTH_TOKEN, and passthrough forwards client auth untouched.
    expect(String(req.headers.authorization ?? "")).toBe("Bearer deepseek-integration-key");
    // Effort reached the wire: with CLAUDE_CODE_ALWAYS_ENABLE_EFFORT the CLI
    // sends a thinking config (budget style) or output_config effort for the
    // foreign reasoning model.
    const effortOnWire = body.thinking?.type === "enabled" || body.thinking?.type === "adaptive" || !!body.output_config?.effort;
    expect(effortOnWire).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
