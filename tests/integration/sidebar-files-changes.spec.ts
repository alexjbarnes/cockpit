// The sidebar's Files & changes panel: one section with a Changes/Files switch,
// both views drawn by the same tree. Changes opens a diff, Files opens a file,
// and the panel follows edits on disk without losing the chosen view.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";
import { openSidebarFiles, openSidebarPanel } from "./sidebar-files";

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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", ...args], { cwd, stdio: "ignore" });
}

function write(root: string, relativePath: string, content: string): void {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function openSession(page: Page, harness: Harness, cwd: string) {
  harness.trustWorkDir(cwd);
  const res = await page.request.post(`${harness.cockpitUrl}/api/sessions`, { data: { cwd, runtime: "pty" } });
  expect(res.ok()).toBe(true);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(cwd)}`);
  await expect(page.getByTestId("message-input")).toBeVisible({ timeout: 20_000 });
  // The eager PTY spawn settles; the sidebar's watcher starts with it.
  await page.waitForTimeout(5000);
  return sessionId;
}

test("the sidebar shows changes and files in one panel, remembers the view and follows edits", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-files-changes-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    write(repo, ".gitignore", ".env\n");
    write(repo, "README.md", "# Read me\n");
    write(repo, "src/app.ts", "export const value = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    write(repo, "src/app.ts", "export const value = 2;\n");
    write(repo, ".env", "SECRET=1\n");

    await openSession(page, harness, repo);

    await openSidebarPanel(page);
    const panel = page.getByTestId("sidebar-section-files-changes");
    const switchGroup = page.getByTestId("sidebar-files-changes-switch");

    // Changes is the view a fresh panel opens on.
    await expect(switchGroup.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");
    const changesTree = page.getByTestId("sidebar-files-changes-tree-changes");
    const appRow = changesTree.getByRole("treeitem", { name: "app.ts" });
    await expect(appRow).toBeVisible({ timeout: 20_000 });
    await expect(appRow).toContainText("+1");
    await expect(panel.getByText("1 changed")).toBeVisible();

    // The legend explains the status glyphs in the tree.
    await page.getByTestId("sidebar-changes-legend").click();
    const legend = page.getByTestId("sidebar-changes-legend-dialog");
    await expect(legend).toBeVisible();
    await expect(legend.getByText("Modified")).toBeVisible();
    await expect(legend.getByText("Untracked")).toBeVisible();
    await expect(legend.getByText("Ignored")).toBeVisible();
    await expect(legend.getByText("Folder")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(legend).toBeHidden();

    // A changed row opens its diff.
    await appRow.click();
    await expect(page.locator('[data-tab-id^="diff::"]')).toHaveCount(1, { timeout: 15_000 });

    // The same panel in Files mode lists tracked files, and a row opens the
    // file itself rather than a diff.
    await switchGroup.getByRole("button", { name: "Files" }).click();
    const filesTree = page.getByTestId("sidebar-files-changes-tree-files");
    const readmeRow = filesTree.getByRole("treeitem", { name: "README.md" });
    await expect(readmeRow).toBeVisible({ timeout: 20_000 });
    // A git-ignored file is still listed, muted, rather than disappearing.
    await expect(filesTree.getByRole("treeitem", { name: ".env" })).toBeVisible();
    await readmeRow.click();
    await expect(page.locator('[data-tab-id^="file::"]')).toHaveCount(1, { timeout: 15_000 });

    // The Open File dialog uses the same tree, so picking a file there looks
    // like the sidebar rather than a separate flat list.
    await page.getByTitle("Open file").click();
    const pickerTree = page.getByTestId("file-picker-tree");
    const ignoreRow = pickerTree.getByRole("treeitem", { name: ".gitignore" });
    await expect(ignoreRow).toBeVisible({ timeout: 20_000 });
    await ignoreRow.click();
    await expect(page.getByTestId("file-picker-tree")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-tab-id^="file::"]')).toHaveCount(2, { timeout: 15_000 });

    // A file created on disk appears in both views: the status count and the
    // file listing refresh on fs_changed.
    write(repo, "fresh.txt", "new\n");
    await switchGroup.getByRole("button", { name: "Changes" }).click();
    await expect(panel.getByText("2 changed")).toBeVisible({ timeout: 20_000 });
    await switchGroup.getByRole("button", { name: "Files" }).click();
    await expect(filesTree.getByRole("treeitem", { name: "fresh.txt" })).toBeVisible({ timeout: 20_000 });

    // The chosen view survives a reload. The file tab opened above is still the
    // active one, so the chat composer is hidden; the sidebar is the witness
    // that the session page is back.
    await page.reload();
    await page.getByTestId("sidebar-section-files-changes").waitFor({ state: "visible", timeout: 20_000 });
    await openSidebarPanel(page);
    await expect(page.getByTestId("sidebar-files-changes-switch").getByRole("button", { name: "Files" })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 15_000 },
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("on a phone, opening a file or diff from the panel closes the sidebar drawer", async ({ page, harness }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 393, height: 760 });
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-files-changes-phone-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    write(repo, "README.md", "# Read me\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");

    await openSession(page, harness, repo);

    await page.getByTitle("Toggle sidebar (Ctrl+B)").click();
    await openSidebarFiles(page);
    const tree = page.getByTestId("sidebar-files-changes-tree-files");
    const row = tree.getByRole("treeitem", { name: "README.md" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.locator('[data-tab-id^="file::"]')).toHaveCount(1, { timeout: 15_000 });

    const section = page.getByTestId("sidebar-section-files-changes");
    await expect.poll(async () => (await section.boundingBox())?.x ?? 0, { timeout: 10_000 }).toBeLessThan(0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a folder that is not a git repository still gets the file tree", async ({ page, harness }) => {
  test.setTimeout(180_000);
  const folder = mkdtempSync(path.join(tmpdir(), "cockpit-it-files-changes-plain-"));
  try {
    write(folder, "notes.txt", "hello\n");

    await openSession(page, harness, folder);

    await openSidebarPanel(page);
    await expect(page.getByTestId("sidebar-section-files-changes").getByText("Not a git repository")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("sidebar-files-changes-switch").getByRole("button", { name: "Files" }).click();
    await expect(page.getByTestId("sidebar-files-changes-tree-files").getByRole("treeitem", { name: "notes.txt" })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
