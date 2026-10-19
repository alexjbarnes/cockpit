// A session on a Groq model runs a real turn through cockpit's
// Anthropic-to-OpenAI format proxy.
//
// Exercises: providers.json groq entry (key + one enabled model) →
// resolveProviderModel ("groq:<id>") → spawn env pointing ANTHROPIC_BASE_URL at
// the in-process format proxy → the real CLI speaks Anthropic wire to the proxy
// → the proxy translates and forwards to the mock's /v1/chat/completions with
// the stored Groq key. The same path serves Google AI Studio and NVIDIA NIM,
// which were added alongside it: like Groq they are plain OpenAI-wire
// built-ins, and the only per-provider thing left is the base URL.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import { GROQ_TEST_MODEL } from "./harness";

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

test.use({ harnessOptions: { groqViaMock: true } });

test("a session on a groq model reaches the OpenAI door through the format proxy", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-groq-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: `groq:${GROQ_TEST_MODEL}` },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    const input = page.getByTestId("message-input");
    await expect(input).toBeVisible();
    // The pill names the provider for anything that is not a built-in
    // Anthropic model, and shows the model's display name.
    await expect(page.getByTestId("model-pill")).toContainText("Groq · Mock OSS 120B");
    // Let session:connect's eager ensureProcess finish spawning the PTY.
    await page.waitForTimeout(5000);
    await input.fill("hi via groq proxy");
    await page.getByTestId("btn-send").click();

    // The wire is the assertion surface (rendered-reply checks are broken
    // harness-wide): the upstream OpenAI door receiving the translated turn
    // proves connect → provider entry → proxy → upstream.
    await expect
      .poll(
        () =>
          harness.mock
            .getRequests()
            .filter((r) => r.url.split("?")[0] === "/v1/chat/completions")
            .some((r) => String(r.body).includes("hi via groq proxy")),
        { timeout: 30_000 },
      )
      .toBe(true);

    const requests = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/chat/completions" && String(r.body).includes("hi via groq proxy"));
    const req = requests[requests.length - 1];
    const body = JSON.parse(req.body) as { model: string; messages: Array<{ role: string }> };
    expect(body.model).toBe(GROQ_TEST_MODEL);
    expect(body.messages.some((m) => m.role === "user")).toBe(true);
    // The proxy injected the stored Groq key upstream; the CLI never saw it.
    expect(String(req.headers.authorization ?? "")).toBe("Bearer gsk-integration-key");

    // And the provider's own usage view works: the metered spend comes from
    // cockpit's proxy, which is the only usage source these three have.
    const usageRes = await page.request.get(`${harness.cockpitUrl}/api/providers/groq/usage`);
    expect(usageRes.ok(), await usageRes.text()).toBe(true);
    const usage = (await usageRes.json()) as { spend: { month: { requests: number } } };
    expect(usage.spend.month.requests).toBeGreaterThanOrEqual(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
