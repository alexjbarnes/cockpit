// Dragging issues: reorder inside a status, move one into another status, and
// the session header's way into its own project's issues. The drag is driven
// with real pointer events (mouse down, hold past the activation delay, move in
// steps, up) because dnd-kit listens for a stream of moves, not for a drop.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

interface StoredIssue {
  key: string;
  status: string;
  order?: number;
}

function storedIssues(harness: Harness, projectId: string): StoredIssue[] {
  const file = path.join(harness.configDir, "issues", `${projectId}.json`);
  return (JSON.parse(readFileSync(file, "utf-8")) as { issues: StoredIssue[] }).issues;
}

function inStatus(harness: Harness, projectId: string, status: string): string[] {
  return storedIssues(harness, projectId)
    .filter((issue) => issue.status === status)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((issue) => issue.key);
}

test("a row dragged inside its status keeps the new order, and a row dropped in another status moves", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const repoPath = mkdtempSync(path.join(tmpdir(), "cockpit-it-issues-"));
  try {
    const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    expect(patched.ok()).toBe(true);

    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Drag project", prefix: "DRG", repoPath },
    });
    expect(projectRes.ok()).toBe(true);
    const { project } = (await projectRes.json()) as { project: { id: string } };

    for (const title of ["First", "Second", "Third"]) {
      const res = await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title } });
      expect(res.ok()).toBe(true);
    }
    expect(inStatus(harness, project.id, "Backlog")).toEqual(["DRG-1", "DRG-2", "DRG-3"]);

    await page.goto(`${harness.cockpitUrl}/issues`);
    await expect(page.getByTestId("issue-group-Backlog")).toBeVisible({ timeout: 20_000 });

    // The third row's handle up to the first row's position: down, hold past the
    // activation delay without moving, then a stream of moves, then release.
    const handles = page.locator('[data-testid="issue-group-Backlog"] button[aria-label="Drag to reorder"]');
    const from = await handles.nth(2).boundingBox();
    const first = await handles.nth(0).boundingBox();
    if (!from || !first) throw new Error("rows not measurable");

    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(250);
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x, y + ((first.y - y) * i) / 10);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(1000);

    expect(inStatus(harness, project.id, "Backlog"), "the third row is now first").toEqual(["DRG-3", "DRG-1", "DRG-2"]);

    // Into another status: the empty group only exists as a drop target while
    // the drag is in flight, which is the point of rendering them at all.
    const second = await handles.nth(1).boundingBox();
    if (!second) throw new Error("row not measurable");
    const sx = second.x + second.width / 2;
    const sy = second.y + second.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.waitForTimeout(250); // past the activation delay, no movement yet

    // The empty group exists only now, and may be below the fold: bring it in
    // while the pointer is held, then move onto it.
    const doneGroup = page.getByTestId("issue-group-Done");
    await expect(doneGroup).toBeVisible();
    await doneGroup.scrollIntoViewIfNeeded();
    const done = await doneGroup.boundingBox();
    if (!done) throw new Error("no Done group");
    const ty = done.y + 30;
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(sx, sy + ((ty - sy) * i) / 10);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(1000);

    expect(inStatus(harness, project.id, "Done"), "moved into a status that had no issues").toContain("DRG-1");

    // Reload: the order is the stored one, not a client-side artefact.
    await page.reload();
    await expect(page.getByTestId("issue-group-Backlog")).toBeVisible({ timeout: 20_000 });
    const titles = await page.locator('[data-testid="issue-group-Backlog"] [role="button"]').allInnerTexts();
    expect(titles[0]).toContain("Third");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("the session header opens its project's issues", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const repoPath = mkdtempSync(path.join(tmpdir(), "cockpit-it-issues-"));
  try {
    const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    expect(patched.ok()).toBe(true);

    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Session project", prefix: "SES", repoPath },
    });
    const { project } = (await projectRes.json()) as { project: { id: string } };
    const issueRes = await page.request.post(`${harness.cockpitUrl}/api/issues`, {
      data: { projectId: project.id, title: "Belongs to this session" },
    });
    expect(issueRes.ok()).toBe(true);

    // A session working in that repository.
    harness.trustWorkDir(repoPath);
    const sessionRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: repoPath, runtime: "pty" } });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repoPath)}`);

    const button = page.getByTestId("session-issues");
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();

    const modal = page.getByTestId("session-issues-modal");
    await expect(modal).toBeVisible();
    await expect(page.getByTestId("session-issues-project")).toHaveValue(project.id);
    await expect(modal).toContainText("Belongs to this session");

    // Not every page: the button is for the session you are in.
    await page.goto(`${harness.cockpitUrl}/reviews`);
    await expect(page.getByTestId("session-issues")).toHaveCount(0);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
