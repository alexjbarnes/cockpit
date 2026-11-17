// Moving around the new navigation: the rail's places, the Issues | Workflows
// and Inbox | Waiting switches, and each place remembering the screen you last
// had there. No CLI is needed except for the session in the first test.

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

test.use({ viewport: { width: 1280, height: 800 } });

async function enableIssues(page: Page, harness: Harness): Promise<void> {
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
  expect(patched.ok()).toBe(true);
}

test("Sessions returns to the session you last had, beside the sidebar", async ({ page, harness }) => {
  test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-nav-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    await enableIssues(page, harness);
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    const sessionUrl = `${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`;
    await page.request.patch(`${harness.cockpitUrl}/api/sessions/pinned`, { data: { add: sessionId } });

    await page.goto(sessionUrl);
    await expect(page.getByTestId("message-input")).toBeVisible();

    // Away to Issues, and Sessions comes back to the same session, with the
    // pinned list beside it rather than a list page of its own.
    await page.getByTestId("nav-rail-issues").click();
    await expect(page).toHaveURL(/\/issues$/);
    await page.getByTestId("nav-rail-sessions").click();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByTestId("sidebar-section-sessions")).toBeVisible();

    // With nothing visited yet in this browser, Sessions opens the folders,
    // still with the sidebar beside them.
    await page.evaluate(() => sessionStorage.removeItem("cockpit_last_sessions"));
    await page.getByTestId("nav-rail-issues").click();
    await page.getByTestId("nav-rail-sessions").click();
    await expect(page).toHaveURL(`${harness.cockpitUrl}/`);
    await expect(page.getByTestId("sidebar-section-sessions")).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a pinned session can be taken off the list without deleting it", async ({ page, harness }) => {
  test.skip(!CLAUDE_AVAILABLE, `claude binary not found at ${CLAUDE_BIN} (set CLAUDE_BIN env)`);
  test.setTimeout(120_000);
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-unpin-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);
  try {
    const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: workDir, runtime: "pty" } });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await page.request.patch(`${harness.cockpitUrl}/api/sessions/pinned`, { data: { add: sessionId } });

    await page.goto(`${harness.cockpitUrl}/sessions`);
    await expect(page.getByTestId(`pinned-session-${sessionId}`)).toBeVisible();
    await page.getByTestId(`unpin-session-${sessionId}`).click();
    await expect(page.getByTestId(`pinned-session-${sessionId}`)).toHaveCount(0);
    await expect(page.getByTestId("pinned-empty")).toBeVisible();

    // The pin is gone; the session is not. The write is in flight as the row
    // leaves the screen, so wait for it rather than reading once.
    await expect
      .poll(async () => {
        const pins = (await (await page.request.get(`${harness.cockpitUrl}/api/sessions/pinned`)).json()) as { pinned: string[] };
        return pins.pinned;
      })
      .not.toContain(sessionId);
    const session = await page.request.get(`${harness.cockpitUrl}/api/sessions/${sessionId}`);
    expect(session.ok()).toBe(true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("Settings returns to the last settings page", async ({ page, harness }) => {
  await enableIssues(page, harness);
  await page.goto(`${harness.cockpitUrl}/settings`);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);

  await page.getByTestId("nav-rail-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.getByTestId("nav-rail-settings").click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
});

test("Issues remembers Workflows, and the switch's Issues side goes to the list", async ({ page, harness }) => {
  await enableIssues(page, harness);
  await page.goto(`${harness.cockpitUrl}/issues`);
  await page.getByTestId("issues-workflows-switch").getByRole("button", { name: "Workflows" }).click();
  await expect(page).toHaveURL(/\/workflows$/);

  await page.getByTestId("nav-rail-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.getByTestId("nav-rail-issues").click();
  await expect(page).toHaveURL(/\/workflows$/);

  // The switch's Issues side cannot bounce back to Workflows.
  await page.getByTestId("issues-workflows-switch").getByRole("button", { name: "Issues" }).click();
  await expect(page).toHaveURL(/\/issues$/);
});

test("Inbox remembers Waiting on you", async ({ page, harness }) => {
  await enableIssues(page, harness);
  await page.goto(`${harness.cockpitUrl}/inbox`);
  await page.getByTestId("inbox-switch").getByRole("button", { name: "Waiting on you" }).click();
  await expect(page).toHaveURL(/\/inbox\/waiting$/);

  await page.getByTestId("nav-rail-jobs").click();
  await expect(page).toHaveURL(/\/jobs$/);
  await page.getByTestId("nav-rail-inbox").click();
  await expect(page).toHaveURL(/\/inbox\/waiting$/);

  // The switch's Inbox side goes to the list.
  await page.getByTestId("inbox-switch").getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("a place you are already in goes to its first screen", async ({ page, harness }) => {
  await enableIssues(page, harness);
  await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Greeter", prefix: "GR" } });
  const { projects } = await (await page.request.get(`${harness.cockpitUrl}/api/projects`)).json();
  const { issue } = await (
    await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: projects[0].id, title: "Add a greeting" } })
  ).json();

  await page.goto(`${harness.cockpitUrl}/issues/${issue.key}`);
  await page.getByTestId("nav-rail-issues").click();
  await expect(page).toHaveURL(/\/issues$/);
});

test("Issues returns to the side you last had, not the issue you opened", async ({ page, harness }) => {
  await enableIssues(page, harness);
  await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Sides", prefix: "SID" } });
  const { projects } = await (await page.request.get(`${harness.cockpitUrl}/api/projects`)).json();
  const { issue } = await (
    await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: projects[0].id, title: "From workflows" } })
  ).json();

  // Workflows is the side you last had.
  await page.goto(`${harness.cockpitUrl}/workflows`);
  await expect(page).toHaveURL(/\/workflows$/);

  // An issue opened from there is a detail of the place, not a side: the
  // footer item comes back to Workflows rather than to the issue's own page.
  await page.goto(`${harness.cockpitUrl}/issues/${issue.key}`);
  await page.getByTestId("nav-rail-issues").click();
  await expect(page).toHaveURL(/\/workflows$/);

  // Leaving the place entirely does not change that either.
  await page.getByTestId("nav-rail-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  await page.getByTestId("nav-rail-issues").click();
  await expect(page).toHaveURL(/\/workflows$/);
});
