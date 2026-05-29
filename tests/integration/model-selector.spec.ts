// Regression: opening the session-settings dialog must not crash for a custom
// provider model whose entry lacks a contextSizes field.
//
// Background — May 2026: a real Deepseek provider config carried the legacy
// supportsExtendedContext flag but no contextSizes (that field postdates the
// config). The settings popover computed `sizes = m.contextSizes` (undefined)
// then rendered `sizes.length >= 2`, throwing "Cannot read properties of
// undefined (reading 'length')" and tripping the page error boundary ("This
// page couldn't load"). Same hazard for effortLevels. Fix: `?? []` guards in
// input-area.tsx. The harness seeds a "legacy" model with no contextSizes to
// reproduce; this test opens the dialog and asserts it renders.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("session-settings dialog opens for a custom model with no contextSizes", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-mscrash-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });

  try {
    // Session whose current model is the legacy mock model (no contextSizes).
    const createRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty", model: "mock:claude-sonnet-4-6-legacy" },
    });
    expect(createRes.ok()).toBe(true);
    const { sessionId } = await createRes.json();

    // Capture any uncaught client error (the crash surfaced as a pageerror).
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The dialog is pure client state, so no PTY round-trip is needed. A short
    // settle is enough for providers to load into the input area.
    await page.waitForTimeout(2000);

    // Open the settings dialog — this is what crashed pre-fix.
    await page.getByTestId("btn-session-settings").click();

    // The dialog header must render. With the bug, the error boundary replaced
    // the whole page with "This page couldn't load".
    await expect(page.getByRole("heading", { name: "Session settings" })).toBeVisible();
    await expect(page.getByText("This page couldn’t load")).toHaveCount(0);

    // No uncaught "reading 'length'" (or any) error should have fired.
    expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toHaveLength(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
