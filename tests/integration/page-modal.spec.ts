// The experimental page modal: with modalPagesEnabled on, the sidebar footer's
// pages open in a modal over the session instead of replacing it. The modal
// shows the real page in an iframe, which drops the sidebar, keeps its
// navigation to itself, and hands a page it does not show (a session) back to
// the main window. Off, the footer navigates as it always has.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

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

const FRAME = 'iframe[name="cockpit-page-modal"]';

function makeWorkDir(harness: Harness): string {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-pagemodal-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  return workDir;
}

async function createSession(page: Page, harness: Harness, workDir: string): Promise<string> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  return `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
}

async function openSession(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("message-input")).toBeVisible();
}

test("with the experiment off, the footer's pages replace the session as before", async ({ page, harness }) => {
  const workDir = makeWorkDir(harness);
  try {
    await openSession(page, await createSession(page, harness, workDir));
    await page.getByTitle("Scheduled Jobs").click();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("with the experiment on, the footer's pages open over the session and close back to it", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  try {
    const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { modalPagesEnabled: true } });
    expect(patched.ok()).toBe(true);
    const sessionUrl = await createSession(page, harness, workDir);
    const otherSessionUrl = await createSession(page, harness, workDir);
    await openSession(page, sessionUrl);
    const frame = page.frameLocator(FRAME);

    // Opens over the session, as the page itself without the sidebar.
    await page.getByTitle("Scheduled Jobs").click();
    await expect(page.getByTestId("page-modal")).toBeVisible();
    await expect(frame.getByTestId("page-modal-close")).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText("Scheduled Jobs").first()).toBeVisible();
    await expect(frame.getByTitle("Settings")).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeAttached();

    // The close button inside puts the session back.
    await frame.getByTestId("page-modal-close").click();
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);

    // Escape closes it, and never reaches the composer, where it would stop
    // Claude. The click leaves focus alone, as Safari's does.
    await page.getByTestId("message-input").focus();
    await page.getByTitle("Inbox").dispatchEvent("click");
    await expect(page.getByTestId("page-modal")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);

    // Navigating inside stays inside, and Back closes the modal rather than
    // stepping through its pages or leaving the session.
    await page.getByTitle("Settings").click();
    await frame.getByText("Appearance", { exact: true }).click();
    await expect(frame.getByText("Pages in a modal")).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toBe(sessionUrl);
    await page.goBack();
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    expect(page.url()).toBe(sessionUrl);

    // A page the modal does not show, such as a session, opens in the main
    // window, and Back then returns to the session the modal was opened from.
    await page.getByTitle("Inbox").click();
    await expect(frame.getByTestId("page-modal-close")).toBeVisible({ timeout: 15_000 });
    const inner = page.frame({ name: "cockpit-page-modal" });
    expect(inner).not.toBeNull();
    const otherPath = otherSessionUrl.slice(harness.cockpitUrl.length);
    await inner!.evaluate((p) => window.history.pushState(null, "", p), otherPath);
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    await expect(page).toHaveURL(otherSessionUrl);
    await page.goBack();
    await expect(page).toHaveURL(sessionUrl);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
