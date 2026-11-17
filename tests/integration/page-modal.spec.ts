// The page modal: with modalPagesEnabled on (its default), a page opened from
// inside another opens in a modal over it instead of replacing it. Two things
// open pages that way now that the navigation is real links: an issue picked
// from a session's issues list, and Session insights from the context panel.
// The modal shows the real page in an iframe, which drops the navigation,
// keeps its own history to itself, and hands a page it does not show (a
// session) back to the main window. Off, the same click navigates.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse } from "../mock-api/builder";
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

/** A project with one issue, and the setting this test needs. */
async function seedIssue(page: Page, harness: Harness, modalPagesEnabled: boolean): Promise<void> {
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { modalPagesEnabled, issuesEnabled: true } });
  expect(patched.ok()).toBe(true);
  const { project } = await (
    await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Greeter", prefix: "GR" } })
  ).json();
  await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title: "Add a greeting" } });
}

/** The session's own issues list, with the issue in it. */
async function openIssuesList(page: Page, sessionUrl: string): Promise<void> {
  await openSession(page, sessionUrl);
  await page.getByTestId("session-issues").click();
  await expect(page.getByTestId("session-issues-modal")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Add a greeting")).toBeVisible({ timeout: 15_000 });
}

test("with the setting off, an issue picked from a session's list replaces the session", async ({ page, harness }) => {
  const workDir = makeWorkDir(harness);
  try {
    await seedIssue(page, harness, false);
    const sessionUrl = await createSession(page, harness, workDir);
    await openIssuesList(page, sessionUrl);

    await page.getByText("Add a greeting").click();
    await expect(page).toHaveURL(/\/issues\/GR-1(\?|$)/);
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("with the setting on, an issue opens over the session and closes back to it", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  try {
    await seedIssue(page, harness, true);
    const sessionUrl = await createSession(page, harness, workDir);
    await openIssuesList(page, sessionUrl);
    // The session's issues list keeps itself in the URL, so that is the page
    // the modal must leave in place.
    const baseUrl = page.url();
    const frame = page.frameLocator(FRAME);

    // Opens over the session, as the page itself without the navigation.
    await page.getByText("Add a greeting").click();
    await expect(page.getByTestId("page-modal")).toBeVisible();
    await expect(frame.getByTestId("page-modal-close")).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText("Add a greeting").first()).toBeVisible();
    await expect(frame.getByTestId("app-nav-rail")).toHaveCount(0);
    expect(page.url()).toBe(baseUrl);
    await expect(page.getByTestId("message-input")).toBeAttached();

    // The close button inside puts the session back.
    await frame.getByTestId("page-modal-close").click();
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    expect(page.url()).toBe(baseUrl);

    // Escape closes it, and never reaches the composer, where it would stop
    // Claude. The click leaves focus alone, as Safari's does.
    await page.getByTestId("message-input").focus();
    await page.getByText("Add a greeting").click();
    await expect(page.getByTestId("page-modal")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    expect(page.url()).toBe(baseUrl);

    // Back closes the modal rather than stepping through its pages or leaving
    // the session.
    await page.getByText("Add a greeting").click();
    await expect(frame.getByTestId("page-modal-close")).toBeVisible({ timeout: 15_000 });
    await page.goBack();
    await expect(page.getByTestId("page-modal")).toHaveCount(0);
    expect(page.url()).toBe(baseUrl);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("an issue changed in the page modal comes back changed in the session's list", async ({ page, harness }) => {
  test.setTimeout(90_000);
  const workDir = makeWorkDir(harness);
  try {
    await seedIssue(page, harness, true);
    const sessionUrl = await createSession(page, harness, workDir);
    await openIssuesList(page, sessionUrl);
    const frame = page.frameLocator(FRAME);

    await page.getByText("Add a greeting").click();
    await expect(frame.getByTestId("page-modal-close")).toBeVisible({ timeout: 15_000 });

    // Move it out of Backlog on its own page, inside the modal. The select is
    // driven by the saved issue, so this waits for the write to land.
    await frame.getByTestId("issue-status").selectOption("Implementation");
    await expect(frame.getByTestId("issue-status")).toHaveValue("Implementation");

    await frame.getByTestId("page-modal-close").click();
    await expect(page.getByTestId("page-modal")).toHaveCount(0);

    // The list behind the modal never unmounted, so it has to have been read
    // again: the issue now sits under its new status.
    const list = page.getByTestId("session-issues-list");
    await expect(list.getByText("Implementation", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText("Add a greeting")).toBeVisible();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("Session insights from the context panel opens in the page modal too", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const workDir = makeWorkDir(harness);
  try {
    const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, {
      data: { modalPagesEnabled: true, telemetryEnabled: true },
    });
    expect(patched.ok()).toBe(true);
    const sessionUrl = await createSession(page, harness, workDir);
    await openSession(page, sessionUrl);

    // The ring only exists once the session has usage, so give it a turn.
    harness.mock.setScript([{ events: textResponse("All done.") }]);
    await page.waitForTimeout(5000);
    await page.getByTestId("message-input").fill("say something");
    await page.getByTestId("btn-send").click();
    await expect(page.getByText("All done.")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("context-indicator").click();
    await page.getByTestId("session-insights-link").click();

    // The session stays underneath, and the page the link names is in the
    // modal's frame.
    await expect(page.getByTestId("page-modal")).toBeVisible();
    expect(page.url()).toBe(sessionUrl);
    const inner = page.frame({ name: "cockpit-page-modal" });
    expect(inner).not.toBeNull();
    await expect
      .poll(() => inner!.url(), { timeout: 15_000 })
      .toContain(`/insights?session=${new URL(sessionUrl).pathname.split("/").pop()}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
