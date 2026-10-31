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

    // And back down, onto the row it is dropped on: the index has to be the
    // hovered row's place with the moved row still in the list. Read off the
    // list without it, every downward drag landed one row short of the row it
    // was let go on.
    const back = await handles.nth(0).boundingBox();
    const third = await handles.nth(2).boundingBox();
    if (!back || !third) throw new Error("rows not measurable");
    const bx = back.x + back.width / 2;
    const by = back.y + back.height / 2;
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.waitForTimeout(250);
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(bx, by + ((third.y - by) * i) / 10);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(1000);

    expect(inStatus(harness, project.id, "Backlog"), "the first row is now last").toEqual(["DRG-1", "DRG-2", "DRG-3"]);

    // Into another status: the empty group only exists as a drop target while
    // the drag is in flight, which is the point of rendering them at all.
    // Which row is second depends on the drags above, so the assertion below
    // reads the key off the row being dragged rather than assuming one.
    const movedKey = await page.evaluate(() => {
      const handles = [...document.querySelectorAll('[data-testid="issue-group-Backlog"] button[aria-label="Drag to reorder"]')];
      return ((handles[1]?.parentElement?.textContent || "").match(/DRG-\d+/) || ["?"])[0];
    });
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

    expect(inStatus(harness, project.id, "Done"), "moved into a status that had no issues").toContain(movedKey);

    // Reload: the order is the stored one, not a client-side artefact. The
    // rendered rows are checked against the file, so this stays honest whatever
    // the drags above left behind.
    await page.reload();
    await expect(page.getByTestId("issue-group-Backlog")).toBeVisible({ timeout: 20_000 });
    const rendered = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="issue-group-Backlog"] [role="button"]')]
        .map((row) => ((row.textContent || "").match(/DRG-\d+/) || [])[0])
        .filter(Boolean),
    );
    expect(rendered).toEqual(inStatus(harness, project.id, "Backlog"));
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("the session header opens its project's issues", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const repoPath = mkdtempSync(path.join(tmpdir(), "cockpit-it-issues-"));
  try {
    // Capture what the row's copy button writes, without asking the browser
    // for the real clipboard.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            (window as Window & { __copiedKey?: string }).__copiedKey = text;
            return Promise.resolve();
          },
        },
      });
    });

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
    const { issue } = (await issueRes.json()) as { issue: { key: string } };

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

    // The row's copy button writes the key and leaves the list open.
    await page.getByTestId(`copy-issue-${issue.key}`).click();
    expect(await page.evaluate(() => (window as Window & { __copiedKey?: string }).__copiedKey)).toBe(issue.key);
    await expect(modal).toBeVisible();

    // Not every page: the button is for the session you are in.
    await page.goto(`${harness.cockpitUrl}/reviews`);
    await expect(page.getByTestId("session-issues")).toHaveCount(0);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("deleting an issue opened from a session comes back to that session", async ({ page, harness }) => {
  test.setTimeout(120_000);
  const repoPath = mkdtempSync(path.join(tmpdir(), "cockpit-it-issues-"));
  try {
    await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Return project", prefix: "RTN", repoPath },
    });
    const { project } = (await projectRes.json()) as { project: { id: string } };
    await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title: "Doomed issue" } });

    harness.trustWorkDir(repoPath);
    const sessionRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: repoPath, runtime: "pty" } });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repoPath)}`);
    await page.getByTestId("session-issues").click();
    await page.getByTestId("issue-list").getByRole("button", { name: /RTN-1/ }).first().click();

    // The issue page knows where it was opened from.
    await expect(page).toHaveURL(/\/issues\/RTN-1\?from=/, { timeout: 15_000 });

    await page.locator("button.text-destructive").first().click();
    await page.locator("button[class*='destructive']").last().click();

    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}\\?cwd=`), { timeout: 15_000 });
    // Back where it started, with the list it was opened from open again.
    await expect(page.getByTestId("session-issues-modal")).toBeVisible({ timeout: 15_000 });
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("on a phone, comments stay inside the issue page and the session's list keeps its place across a delete", async ({
  page,
  harness,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 393, height: 760 });
  const repoPath = mkdtempSync(path.join(tmpdir(), "cockpit-it-issues-place-"));
  try {
    await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
    const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
      data: { name: "Place project", prefix: "PLC", repoPath },
    });
    const { project } = (await projectRes.json()) as { project: { id: string } };
    // Comments the way agents write them: long paths and identifiers with no
    // break in them, which ran off the card on a phone.
    const comment =
      "**The sweep already keys on product id.** `MarkMissingBeansUnavailable` (`internal/repository/marketplace.go:812`) " +
      "matches on `b.shopify_product_id != ALL($2)`, and keys look like `{roaster_slug}/{bean_slug}/{image_id}{ext}`.";
    for (let i = 1; i <= 30; i++) {
      const res = await page.request.post(`${harness.cockpitUrl}/api/issues`, {
        data: { projectId: project.id, title: `Place issue ${i} with a title long enough to wrap` },
      });
      const { issue } = (await res.json()) as { issue: { key: string } };
      await page.request.post(`${harness.cockpitUrl}/api/issues/${issue.key}/comments`, { data: { body: comment } });
    }

    harness.trustWorkDir(repoPath);
    const sessionRes = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd: repoPath, runtime: "pty" } });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repoPath)}`);
    await page.getByTestId("session-issues").click();
    const list = page.getByTestId("session-issues-list");
    await expect(list.getByRole("button", { name: /\bPLC-1\b/ }).first()).toBeVisible({ timeout: 15_000 });

    // Well down the list, then open a row that is on screen.
    await list.evaluate((el) => {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.6);
    });
    await page.waitForTimeout(400);
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(200);
    const key = await list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[role=button]")].find(
        (r) => r.getBoundingClientRect().top > top + 40 && /PLC-\d+/.test(r.textContent ?? ""),
      );
      return row?.textContent?.match(/PLC-\d+/)?.[0] ?? "";
    });
    await list
      .getByRole("button", { name: new RegExp(`\\b${key}\\b`) })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/issues/${key}\\?from=`), { timeout: 15_000 });
    await expect(page.getByText("Comments (1)")).toBeVisible({ timeout: 15_000 });

    // Nothing on the page is wider than the phone.
    const sideways = await page.evaluate(() =>
      Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ...[...document.querySelectorAll("div")]
          .filter((d) => getComputedStyle(d).overflowY === "auto")
          .map((d) => d.scrollWidth - d.clientWidth),
      ),
    );
    expect(sideways, "the issue page scrolls sideways").toBeLessThanOrEqual(1);

    await page.locator("button.text-destructive").first().click();
    await page.locator("button[class*='destructive']").last().click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}\\?`), { timeout: 15_000 });

    // The list it left, where it left it, without the issue just deleted.
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(list.getByRole("button", { name: new RegExp(`\\b${key}\\b`) })).toHaveCount(0);
    await expect.poll(() => list.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(before - 80);

    // Closing the list forgets the place: opened again, it starts at the top.
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("session-issues").click();
    await expect(list.getByRole("button", { name: /\bPLC-1\b/ }).first()).toBeVisible({ timeout: 15_000 });
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
