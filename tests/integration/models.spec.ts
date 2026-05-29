// Integration test: model routing through the full stack.
//
// Each test creates a session with a mock provider model at a given thinking
// level, sends a message, and asserts the /v1/messages body carries the
// correct modelId and that output_config presence matches effort eligibility.
//
// Notes on CLI 2.1.156 behavior (verified empirically):
// - body.model always reflects the resolved --model flag
// - output_config.effort is always "max" when --effort is passed (regardless of
//   the level), and absent when --effort is not passed (haiku).
// - The specific effort value is CLI-version-dependent and not asserted.
// - Cockpit correctly passes --effort when the model declares effort levels.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test as base, expect } from "@playwright/test";
import { textResponse } from "../mock-api/builder";
import { startHarness } from "./harness";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const CLAUDE_AVAILABLE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function injectCookie(page: import("@playwright/test").Page, url: string, token: string): Promise<void> {
  await page.context().addCookies([{ name: "cockpit_session", value: token, url, httpOnly: true, sameSite: "Strict" as const }]);
}

interface TestCase {
  label: string;
  model: string;
  expectedModel: string;
  hasEffort: boolean;
}

const TESTS: TestCase[] = [
  { label: "sonnet", model: "mock:claude-sonnet-4-6", expectedModel: "claude-sonnet-4-6", hasEffort: true },
  { label: "opus 4.7", model: "mock:claude-opus-4-7", expectedModel: "claude-opus-4-7", hasEffort: true },
  { label: "opus 4.8", model: "mock:claude-opus-4-8", expectedModel: "claude-opus-4-8", hasEffort: true },
  { label: "haiku", model: "mock:claude-haiku-4-5-20251001", expectedModel: "claude-haiku-4-5-20251001", hasEffort: false },
];

for (const tc of TESTS) {
  base(tc.label, async ({ page }) => {
    const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-ms-"));
    mkdirSync(path.join(workDir, ".git"), { recursive: true });

    const harness = await startHarness();

    try {
      // Skip the full test quickly if no claude binary
      if (!CLAUDE_AVAILABLE) {
        console.log(`Skipped: no claude binary at ${CLAUDE_BIN}`);
        return;
      }

      await injectCookie(page, harness.cockpitUrl, harness.cockpitToken);
      harness.mock.setScript([{ events: textResponse("ok") }]);

      const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
        data: { cwd: workDir, runtime: "pty", model: tc.model },
      });
      const { sessionId } = await createRes.json();

      await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
      await expect(page.getByTestId("message-input")).toBeVisible();
      await page.waitForTimeout(5000);

      const before = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages").length;
      await page.getByTestId("message-input").fill("hi");
      await page.getByTestId("btn-send").click();

      await expect(async () => {
        const current = harness.mock.getRequests().filter((r) => r.url.split("?")[0] === "/v1/messages").length;
        expect(current).toBeGreaterThan(before);
      }).toPass({ timeout: 25_000 });

      const all = harness.mock.getRequests();
      const lastV1 = [...all].reverse().find((r) => r.url.split("?")[0] === "/v1/messages");
      expect(lastV1).toBeDefined();
      const body = JSON.parse(lastV1!.body);

      expect(body.model).toBe(tc.expectedModel);

      if (tc.hasEffort) {
        // CLI emits output_config when --effort is passed
        expect(body.output_config).toBeDefined();
      } else {
        // Haiku has no effort levels — --effort not passed, no output_config
        expect(body.output_config).toBeUndefined();
      }
    } finally {
      await harness.stop();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
}
