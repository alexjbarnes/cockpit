// The settings icon beside the input turns red while the CLI runs in a
// permission mode other than the one chosen, and stops once cockpit ends that
// process.
//
// A wrapper starts the real CLI in acceptEdits on its first session spawn,
// whatever mode cockpit asked for, the way a settings source can force one. The
// CLI then reports acceptEdits on its hook payloads while the chosen mode is
// Bypass, the harness default.

import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { textResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const REAL_CLAUDE = (() => {
  try {
    execSync(`${CLAUDE_BIN} --version`, { stdio: "ignore" });
    return execSync(`command -v ${CLAUDE_BIN}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

test.skip(!REAL_CLAUDE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);

const wrapperDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-modewrap-"));
const wrapper = path.join(wrapperDir, "claude");
writeFileSync(
  wrapper,
  `#!/usr/bin/env bash
# The first session spawn runs in acceptEdits; every later call is untouched.
marker="${wrapperDir}/swapped"
args=("$@")
if [[ ! -e "$marker" && " $* " == *" --session-id "* ]]; then
  : > "$marker"
  swapped=0
  for i in "\${!args[@]}"; do
    if [[ "\${args[$i]}" == "--permission-mode" ]]; then args[$((i + 1))]="acceptEdits"; swapped=1; fi
  done
  (( swapped )) || args+=("--permission-mode" "acceptEdits")
fi
exec ${JSON.stringify(REAL_CLAUDE)} "\${args[@]}"
`,
);
chmodSync(wrapper, 0o755);

// Cockpit runs whichever `claude` is first on PATH (it does not read
// CLAUDE_BIN), and the harness hands the server this worker's environment.
const savedPath = process.env.PATH;
test.beforeAll(() => {
  process.env.PATH = `${wrapperDir}${path.delimiter}${savedPath ?? ""}`;
});
test.afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(wrapperDir, { recursive: true, force: true });
});

test("the settings icon is red while the CLI is not in the chosen mode", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-modemismatch-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([{ events: textResponse("Hello there.") }]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The eager spawn from session:connect has to finish, or the send races a
    // second one.
    await page.waitForTimeout(5000);

    // The CLI reports its mode on its hook payloads, so after a turn it has.
    await page.getByTestId("message-input").fill("hello");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("Hello there.")).toBeVisible({ timeout: 30_000 });

    const icon = page.getByTestId("btn-session-settings");
    await expect(icon).toHaveAttribute("data-mode-mismatch", "true", { timeout: 10_000 });
    await expect(icon).toHaveClass(/text-red-500/);

    await icon.click();
    await page.getByRole("button", { name: "Harness" }).click();
    const note = page.getByTestId("permission-mode-mismatch");
    await expect(note).toContainText("running in Accept edits, not Bypass");

    // Manual keeps the CLI as it is, so the mismatch stands, now against the
    // mode the server applied.
    await page.getByTestId("perm-mode-manual").click();
    await expect(note).toContainText("running in Accept edits, not Manual");
    await expect(icon).toHaveClass(/text-red-500/);
    await page.getByRole("button", { name: "Done" }).click();

    // Plan mode ends the process, and what it reported goes with it. No new
    // CLI starts until the next message, so nothing reports in its place.
    await page.getByTitle("Switch to Plan mode (Tab)").click();
    await expect(page.getByTitle("Switch to Build mode (Tab)")).toBeVisible({ timeout: 15_000 });
    await expect(icon).not.toHaveAttribute("data-mode-mismatch", "true");
    await expect(icon).not.toHaveClass(/text-(red|orange|green)-500/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
