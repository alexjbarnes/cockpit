// The phone's navigation: the bar along the bottom, the More page, the bar
// giving way to the keyboard, and a session's files drawer holding only the
// session's own things. No CLI except the drawer test.

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

test.use({ viewport: { width: 393, height: 760 } });

async function enable(page: Page, harness: Harness, extra: Record<string, unknown> = {}): Promise<void> {
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true, ...extra } });
  expect(patched.ok()).toBe(true);
}

const bar = (page: Page) => page.getByTestId("app-nav-bar");

test("the bar replaces the hamburger, and More holds the rest", async ({ page, harness }) => {
  await enable(page, harness);
  await page.goto(`${harness.cockpitUrl}/issues`);

  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId("app-nav-rail")).toBeHidden();
  await expect(page.getByTitle("Toggle sidebar (Ctrl+B)")).toHaveCount(0);
  await expect(page.getByTestId("nav-bar-sessions")).toBeVisible();
  await expect(page.getByTestId("nav-bar-issues")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-bar-inbox")).toBeVisible();
  await expect(page.getByTestId("nav-bar-assistant")).toBeVisible();
  await expect(page.getByTestId("nav-bar-more")).toBeVisible();

  // More lists the places that do not fit, and is active on their pages.
  await page.getByTestId("nav-bar-more").click();
  await expect(page).toHaveURL(/\/more$/);
  await expect(page.getByTestId("more-reviews")).toBeVisible();
  await expect(page.getByTestId("more-jobs")).toBeVisible();
  await expect(page.getByTestId("more-settings")).toBeVisible();
  await expect(page.getByTestId("nav-bar-more")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("more-jobs").click();
  await expect(page).toHaveURL(/\/jobs$/);
  await expect(page.getByTestId("nav-bar-more")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-bar-issues")).not.toHaveAttribute("aria-current", "page");
});

test("focus alone does not move the bar", async ({ page, harness }) => {
  await enable(page, harness);
  await page.goto(`${harness.cockpitUrl}/issues`);
  await expect(bar(page)).toBeVisible();

  // The bar gives way to the keyboard, not to focus: hiding on focus moved the
  // composer's Send button as the field blurred, so the first tap was lost.
  await page.evaluate(() => {
    const ta = document.createElement("textarea");
    ta.id = "typing-probe";
    document.body.appendChild(ta);
    ta.focus();
  });
  await expect(bar(page)).toBeVisible();
  await page.evaluate(() => {
    document.getElementById("typing-probe")?.blur();
    document.getElementById("typing-probe")?.remove();
  });
  await expect(bar(page)).toBeVisible();
});

test("the floating buttons clear the bar", async ({ page, harness }) => {
  await enable(page, harness);
  for (const [path, label] of [
    ["/issues", "New Issue"],
    ["/jobs", "New Job"],
    ["/", "New Session"],
  ] as const) {
    await page.goto(harness.cockpitUrl + path);
    const fab = page.getByRole("button", { name: label }).locator("..");
    await expect(fab).toBeVisible();
    const [fabBox, barBox] = [await fab.boundingBox(), await bar(page).boundingBox()];
    expect(fabBox && barBox).toBeTruthy();
    expect(fabBox!.y + fabBox!.height).toBeLessThanOrEqual(barBox!.y);
  }
});

test("a session's drawer holds only its files and changes", async ({ page, harness }) => {
  test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-nav-phone-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    await enable(page, harness);
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();

    // Sessions is the pinned list on a phone, where there is no sidebar.
    await page.getByTestId("nav-bar-sessions").click();
    await expect(page).toHaveURL(`${harness.cockpitUrl}/sessions`);
    await page.goBack();
    await expect(page.getByTestId("message-input")).toBeVisible();

    await expect(page.getByTestId("session-files-drawer")).toBeVisible();
    await page.getByTestId("session-files-drawer").click();
    await expect(page.getByTestId("sidebar-section-files-changes")).toBeVisible();
    await expect(page.getByTestId("sidebar-section-pr-files")).toBeVisible();
    await expect(page.getByTestId("sidebar-section-sessions")).toBeHidden();
    await expect(page.getByTestId("sidebar-section-reviews")).toBeHidden();

    await page.getByTestId("sidebar-close").click();
    // Off-screen, not unmounted: the drawer slides out of view.
    const section = page.getByTestId("sidebar-section-files-changes");
    await expect.poll(async () => (await section.boundingBox())?.x ?? 0, { timeout: 10_000 }).toBeLessThan(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
