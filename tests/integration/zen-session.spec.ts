// Phase 3: a session on an OpenCode Zen model runs a real turn through
// cockpit's Anthropic-to-OpenAI format proxy.
//
// Exercises: providers.json zen entry (key + models) → resolveProviderModel
// ("zen:<id>") → spawn env pointing ANTHROPIC_BASE_URL at the in-process
// format proxy → real CLI speaks Anthropic wire to the proxy → proxy
// translates to OpenAI format and forwards to the mock's /v1/chat/completions
// with the stored zen key.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { ZEN_TEST_MODEL } from "./harness";

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

test.use({ harnessOptions: { zenViaMock: true } });

test("a session on a zen model reaches the OpenAI door through the format proxy", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-zen-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: `zen:${ZEN_TEST_MODEL}` },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // Let session:connect's eager ensureProcess finish spawning the PTY (see
    // hello.spec.ts for why this wait exists).
    await page.waitForTimeout(5000);
    await input.fill("hi via zen proxy");
    await page.getByTestId("btn-send").click();

    // The wire is the assertion surface (rendered-reply checks are broken
    // harness-wide, see openrouter-session.spec.ts). The upstream OpenAI door
    // receiving the translated turn proves the whole proxy path.
    await expect
      .poll(
        () =>
          harness.mock
            .getRequests()
            .filter((r) => r.url.split("?")[0] === "/v1/chat/completions")
            .some((r) => String(r.body).includes("hi via zen proxy")),
        { timeout: 30_000 },
      )
      .toBe(true);

    const requests = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/chat/completions" && String(r.body).includes("hi via zen proxy"));
    const req = requests[requests.length - 1];
    const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string }>; stream?: boolean; reasoning_effort?: string };
    // Translated OpenAI shape with the bare zen model id.
    expect(body.model).toBe(ZEN_TEST_MODEL);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.some((m) => m.role === "user")).toBe(true);
    // The proxy injected the stored zen key upstream; the CLI never saw it.
    expect(String(req.headers.authorization ?? "")).toBe("Bearer zen-integration-key");
    // The seeded model declares effortLevels ["high","max"]: the CLI (spawned
    // with --effort high + CLAUDE_CODE_ALWAYS_ENABLE_EFFORT) sends thinking
    // config, and the proxy maps it onto reasoning_effort for the upstream.
    expect(body.reasoning_effort).toBe("high");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
