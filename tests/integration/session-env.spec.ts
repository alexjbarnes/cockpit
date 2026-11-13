// A shell inside a session must not inherit what is only in cockpit's
// environment because cockpit is a server. NODE_ENV=production made a dev
// server started in a session serve a production build, and PORT made it
// fight cockpit for the port cockpit was listening on.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";

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

test("a session's shell does not see cockpit's NODE_ENV, PORT or settings", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-env-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    // The harness starts cockpit with NODE_ENV, PORT and COCKPIT_CONFIG_DIR
    // set, so all three are there to leak.
    const probe =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
      'echo "ENVPROBE node=[${NODE_ENV-unset}] port=[${PORT-unset}] cfg=[${COCKPIT_CONFIG_DIR-unset}] hook=[${COCKPIT_HOOK_URL:+set}]"';
    harness.mock.setScript([
      { events: toolUseResponse("Bash", { command: probe, description: "Print the environment" }) },
      { events: textResponse("Checked.") },
    ]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    await page.getByTestId("message-input").fill("print the environment");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("Checked.")).toBeVisible({ timeout: 45_000 });

    const bodies = harness.mock
      .getRequests()
      .filter((r) => r.url.split("?")[0] === "/v1/messages")
      .map((r) => r.body);
    // No "$" in a value: that skips the command's own text, which the request
    // also carries, and matches only what the shell printed.
    const seen = bodies
      .map((body) => /ENVPROBE node=\[([^\]$]*)\] port=\[([^\]$]*)\] cfg=\[([^\]$]*)\] hook=\[([^\]$]*)\]/.exec(body))
      .find((m) => m !== null);
    expect(seen, "the command's output came back to the model").toBeTruthy();
    expect(seen?.[1]).toBe("unset");
    expect(seen?.[2]).toBe("unset");
    expect(seen?.[3]).toBe("unset");
    // The hook bridge's own variables still reach the CLI, or no hook would work.
    expect(seen?.[4]).toBe("set");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
