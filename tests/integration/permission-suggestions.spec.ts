// The CLI attaches its own "always allow" answers to every PermissionRequest
// hook — add this directory, stop asking about edits, save this rule — and the
// card offers them beside Allow: the same alternatives the CLI's own dialog
// would show, named by the CLI rather than by cockpit.
//
// Taking one has to actually take. The chosen suggestion travels back as the
// decision's updatedPermissions, and the CLI applies it: that is what the
// second command in this test proves, because without the echo the CLI asks
// about it again (checked by reverting the echo and watching this fail).

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

test("the card offers the CLI's own suggestion, and taking it sticks", async ({ page, harness }) => {
  test.setTimeout(180_000);

  // Manual, or the harness's bypass default answers this itself.
  const manual = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { permissionMode: "manual" } });
  expect(manual.ok()).toBe(true);

  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-permsug-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  // Counted off the wire: one permission request means the CLI asked once.
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  const asked = () => frames.filter((f) => f.includes('"permission:request"')).length;

  try {
    const first = `rm -rf ${Array.from({ length: 8 }, (_, i) => `build/a-${i}`).join(" ")}`;
    const second = `rm -rf ${Array.from({ length: 8 }, (_, i) => `build/b-${i}`).join(" ")}`;
    harness.mock.setScript([
      // The title request the CLI sends beside a turn gets its own reply, so it
      // cannot take one of the entries below.
      { match: '"json_schema"', events: textResponse('{"title":"Remove the build"}') },
      { events: toolUseResponse("Bash", { command: first, description: "First" }) },
      { events: textResponse("First done.") },
      { events: toolUseResponse("Bash", { command: second, description: "Second" }) },
      { events: textResponse("Second done.") },
    ]);

    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    await page.waitForTimeout(5000);

    await page.getByTestId("message-input").fill("first command");
    await page.getByTestId("btn-send").click();

    const card = page.getByTestId("permission-prompt");
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The alternatives are the CLI's: a named suggestion with the scope it
    // would apply at. There is no cockpit-invented label on this card.
    await expect(card.getByTestId("btn-always")).toHaveText(/\(session\)|\(project|\(global/);
    await card.getByTestId("permission-more").click();
    const suggestion = card.locator("details button", { hasText: "Stop asking about edits (session)" });
    await expect(suggestion).toBeVisible();

    // Take it, and take the next command's silence as the proof it applied:
    // the same click without the suggestion travelling back leaves the CLI
    // asking again.
    await suggestion.click();
    await expect(page.getByText("First done.")).toBeVisible({ timeout: 60_000 });
    expect(asked(), "the CLI asked once about the first command").toBe(1);

    await page.getByTestId("message-input").fill("second command");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("Second done.")).toBeVisible({ timeout: 60_000 });
    expect(asked(), "the second command went through on the mode the CLI's own suggestion set").toBe(1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
