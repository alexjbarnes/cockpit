import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let repoDir: string;

test.beforeEach(async () => {

  repoDir = mkdtempSync(join(tmpdir(), "cockpit-test-"));
  execSync("git init", { cwd: repoDir });
  execSync("git config user.email test@test.com", { cwd: repoDir });
  execSync("git config user.name Test", { cwd: repoDir });

  const lines: string[] = [];
  for (let i = 1; i <= 100; i++) {
    lines.push(`line ${i}: original content`);
  }
  writeFileSync(join(repoDir, "example.txt"), lines.join("\n") + "\n");
  execSync("git add example.txt", { cwd: repoDir });
  execSync('git commit -m "initial"', { cwd: repoDir });

  lines[9] = "line 10: MODIFIED content";
  lines[79] = "line 80: MODIFIED content";
  writeFileSync(join(repoDir, "example.txt"), lines.join("\n") + "\n");
});

test.afterEach(() => {
  if (repoDir) {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

/** Wait for the diff to render inside the shadow DOM */
async function waitForDiffRender(page: import("@playwright/test").Page, timeout = 20_000) {
  await page.waitForFunction(() => {
    const container = document.querySelector("diffs-container");
    const sr = container?.shadowRoot;
    return sr && sr.querySelector("pre") !== null;
  }, undefined, { timeout });
}

test("diff shows only changed hunks with expand buttons", async ({ page }) => {
  await page.goto(`/changes?cwd=${encodeURIComponent(repoDir)}`);
  await waitForDiffRender(page);

  // FileDiff renders inside shadow DOM - query via evaluate
  const result = await page.evaluate(() => {
    const container = document.querySelector("diffs-container");
    const sr = container?.shadowRoot;
    if (!sr) return { separators: 0, expandButtons: 0, hasModified: false };
    return {
      separators: sr.querySelectorAll("[data-separator]").length,
      expandButtons: sr.querySelectorAll("[data-expand-button]").length,
      hasModified: (sr.textContent || "").includes("MODIFIED"),
    };
  });

  // Should have separators between hunks and at start/end
  expect(result.separators).toBeGreaterThanOrEqual(1);
  // Should have expand buttons (the key feature)
  expect(result.expandButtons).toBeGreaterThanOrEqual(1);
  // Should show the modified content
  expect(result.hasModified).toBe(true);
});

test("file diff headers are sticky", async ({ page }) => {
  await page.goto(`/changes?cwd=${encodeURIComponent(repoDir)}`);

  const header = page.locator("[data-testid='sticky-diff-header']");
  await header.waitFor({ timeout: 20_000 });
  await expect(header).toBeVisible();
  await expect(header).toContainText("example.txt");

  const position = await header.evaluate((el) => {
    return window.getComputedStyle(el).position;
  });
  expect(position).toBe("sticky");
});

test("file diff header contains viewed checkbox and collapse button", async ({ page }) => {
  await page.goto(`/changes?cwd=${encodeURIComponent(repoDir)}`);

  const header = page.locator("[data-testid='sticky-diff-header']");
  await header.waitFor({ timeout: 20_000 });

  const checkbox = header.locator("[role='checkbox']");
  await expect(checkbox).toBeVisible();
  expect(await checkbox.getAttribute("aria-checked")).toBe("false");

  const collapseBtn = header.locator("button[title='Collapse']");
  await expect(collapseBtn).toBeVisible();

  // Click collapse - the diffs-container should disappear
  await collapseBtn.click();
  await expect(page.locator("diffs-container")).not.toBeVisible();

  // The collapsed row contains the filename
  const collapsedRow = page.locator(".p-4 button:has-text('example.txt')");
  await expect(collapsedRow).toBeVisible();

  // Click the collapsed row to expand again
  await collapsedRow.click();
  await header.waitFor({ timeout: 5_000 });
  await expect(page.locator("diffs-container")).toBeVisible();

  // Click viewed checkbox - marks as viewed and auto-collapses
  const checkboxAfter = header.locator("[role='checkbox']");
  await checkboxAfter.click();
  await expect(page.locator("diffs-container")).not.toBeVisible();
  await expect(collapsedRow).toBeVisible();
});

test("mobile viewport shows stacked diffs with sticky headers and expand buttons", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`/changes?cwd=${encodeURIComponent(repoDir)}`);

  // Sticky header should render on mobile
  const header = page.locator("[data-testid='sticky-diff-header']");
  await header.waitFor({ timeout: 20_000 });
  await expect(header).toBeVisible();
  await expect(header).toContainText("example.txt");

  const position = await header.evaluate((el) => {
    return window.getComputedStyle(el).position;
  });
  expect(position).toBe("sticky");

  // Expand buttons should exist inside shadow DOM on mobile
  await waitForDiffRender(page);
  const expandButtons = await page.evaluate(() => {
    const container = document.querySelector("diffs-container");
    const sr = container?.shadowRoot;
    return sr ? sr.querySelectorAll("[data-expand-button]").length : 0;
  });
  expect(expandButtons).toBeGreaterThanOrEqual(1);

  // Viewed checkbox should be present on mobile
  const checkbox = header.locator("[role='checkbox']");
  await expect(checkbox).toBeVisible();
});

test("sticky header stays visible when scrolling through long diff", async ({ page }) => {
  const lines: string[] = [];
  for (let i = 1; i <= 200; i++) {
    lines.push(`line ${i}: original content`);
  }
  writeFileSync(join(repoDir, "example.txt"), lines.join("\n") + "\n");
  execSync("git add example.txt", { cwd: repoDir });
  execSync('git commit --amend -m "initial bigger"', { cwd: repoDir });

  for (let i = 0; i < 200; i++) {
    lines[i] = `line ${i + 1}: ALL CHANGED content number ${i}`;
  }
  writeFileSync(join(repoDir, "example.txt"), lines.join("\n") + "\n");

  await page.goto(`/changes?cwd=${encodeURIComponent(repoDir)}`);
  const header = page.locator("[data-testid='sticky-diff-header']");
  await header.waitFor({ timeout: 20_000 });

  const scrollContainer = page.locator(".overflow-y-auto").first();
  await scrollContainer.evaluate((el) => {
    el.scrollTop = 500;
  });

  await page.waitForTimeout(200);
  await expect(header).toBeInViewport();
});
