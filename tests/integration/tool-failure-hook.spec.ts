// A tool that fails has to close its own card: PostToolUse fires only on
// success, so before cockpit registered PostToolUseFailure the row spun in the
// chat for the rest of the session and a turn that had already finished read
// as stuck.
//
// This drives the real CLI with a scripted Bash call that exits non-zero and
// proves the failure hook reached cockpit (its diag line, which only a hook
// payload produces) and that the turn then settled on the model's next reply.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("a failed tool closes its card and the turn settles", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-toolfail-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    harness.mock.setScript([
      { events: toolUseResponse("Bash", { command: "echo boom >&2; exit 3", description: "fail on purpose" }) },
      { events: textResponse("It failed, as arranged.") },
    ]);

    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = (await createRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // Let the eager PTY spawn settle before the first send.
    await page.waitForTimeout(5000);

    await page.getByTestId("message-input").fill("run the command");
    await page.getByTestId("btn-send").click();

    // The model only replies a second time because the tool result came back,
    // so this line also says the turn was not left waiting on the card.
    await expect(page.getByText("It failed, as arranged.")).toBeVisible({ timeout: 45_000 });

    const debug = readFileSync(path.join(harness.configDir, "debug.jsonl"), "utf-8");
    const failure = debug.split("\n").filter((line) => line.includes("hook:PostToolUseFailure"));
    expect(failure.length, "the failure hook reached cockpit").toBeGreaterThan(0);
    expect(failure.join("\n")).toContain("Bash");
    // Named as the CLI reports it ("Exit code 3"), which is what the card shows.
    expect(failure.join("\n")).toContain("Exit code 3");
    // The user can see why it failed, not just that the card is done.
    await expect(page.getByText("boom")).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
