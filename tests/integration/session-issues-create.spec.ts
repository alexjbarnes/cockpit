// Creating an issue from the session header's Issues list. The list is a modal
// over the session, so the create form must open over it and leave the user on
// the same list with the new issue in it, not on the issue's own page.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";

test("an issue created from the session's list stays in the modal", async ({ page, harness }) => {
  test.setTimeout(120_000);
  // The list is used on a phone as much as a desktop, and the plus button sits
  // in a header that already truncates.
  await page.setViewportSize({ width: 393, height: 760 });
  const repoPath = mkdtempSync(path.join(tmpdir(), "cockpit-it-issue-create-"));
  try {
    const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    expect(patched.ok()).toBe(true);

    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Create project", prefix: "CRT", repoPath },
    });
    expect(projectRes.ok()).toBe(true);
    const { project } = (await projectRes.json()) as { project: { id: string } };

    harness.trustWorkDir(repoPath);
    const sessionRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: repoPath, runtime: "pty" } });
    expect(sessionRes.ok()).toBe(true);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repoPath)}`);

    await page.getByTestId("session-issues").click();
    const modal = page.getByTestId("session-issues-modal");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    // Wait for the project list, so the create form opens with the session's
    // project rather than its empty-state message.
    await expect(page.getByTestId("session-issues-project")).toHaveValue(project.id);

    const plus = page.getByTestId("session-issues-new");
    await expect(plus).toBeVisible();
    const box = await plus.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width, "the plus button is off the phone's screen").toBeLessThanOrEqual(393);

    await plus.click();
    const dialog = page.getByTestId("new-issue-dialog");
    await expect(dialog).toBeVisible();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, "the create form scrolls sideways").toBeLessThanOrEqual(1);
    await expect(page.getByTestId("new-issue-project")).toHaveValue(project.id);
    await page.getByTestId("new-issue-title").fill("Made from the session list");
    await page.getByTestId("new-issue-create").click();

    // The form closes, the list is still there, and the page never moves.
    await expect(dialog).not.toBeVisible();
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}\\?cwd=`));
    await expect(modal).toContainText("Made from the session list");
    await expect(modal).toContainText("CRT-1");

    // And it was written, not just added to the list.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${harness.cockpitUrl}/api/issues`);
          const data = (await res.json()) as { issues: Array<{ key: string; title: string }> };
          return data.issues.some((i) => i.key === "CRT-1" && i.title === "Made from the session list");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("the Issues page still creates through the same form", async ({ page, harness }) => {
  const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
    data: { name: "Page project", prefix: "PGE" },
  });
  expect(projectRes.ok()).toBe(true);
  const { project } = (await projectRes.json()) as { project: { id: string } };
  await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });

  await page.goto(`${harness.cockpitUrl}/issues`);
  await page.getByRole("button", { name: "New Issue" }).click();
  await expect(page.getByTestId("new-issue-dialog")).toBeVisible();
  await expect(page.getByTestId("new-issue-project")).toHaveValue(project.id);
  await page.getByTestId("new-issue-title").fill("Made from the issues page");
  await page.getByTestId("new-issue-create").click();

  await expect(page).toHaveURL(/\/issues\/PGE-1$/, { timeout: 15_000 });
});
