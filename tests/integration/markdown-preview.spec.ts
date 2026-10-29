// A Markdown file's preview is rendered as Markdown.
//
// MarkdownRender asked for Tailwind's `prose` classes, but the typography
// plugin that defines them was never installed, so every rule matched nothing:
// headings came out body-sized, list markers were removed by Tailwind's reset,
// and inline code was plain text. The preview was a wall of paragraphs.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const MARKDOWN = `# Productisation plan

## The flow

A paragraph with \`FetchJob.tsx\` inline.

1. Shared core, two panels
2. One panel, two platforms

- Bullet one
- Bullet two
`;

test("a Markdown preview styles headings, lists and code", async ({ page, harness }) => {
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-md-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  writeFileSync(path.join(workDir, "PLAN.md"), MARKDOWN);
  harness.trustWorkDir(workDir);

  try {
    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: workDir, runtime: "pty" },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = (await created.json()) as { sessionId: string };
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(workDir)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();

    await page.getByText("Session Files", { exact: true }).click();
    await page.getByText("PLAN.md", { exact: true }).first().click();
    await page.getByTitle("Show preview").click();

    const preview = page.locator(".message-prose").last();
    await expect(preview.getByRole("heading", { level: 1, name: "Productisation plan" })).toBeVisible();
    await expect(preview.getByRole("heading", { level: 2, name: "The flow" })).toBeVisible();
    await expect(preview.locator("ol > li")).toHaveCount(2);
    await expect(preview.locator("ul > li")).toHaveCount(2);

    const styles = await preview.evaluate((el) => {
      const size = (sel: string) => Number.parseFloat(getComputedStyle(el.querySelector(sel) as Element).fontSize);
      const list = el.querySelector("ol") as Element;
      const code = el.querySelector("p code") as Element;
      const heading = el.querySelector("h1") as Element;
      return {
        h1: size("h1"),
        p: size("p"),
        headingWeight: Number.parseInt(getComputedStyle(heading).fontWeight, 10),
        listStyle: getComputedStyle(list).listStyleType,
        codeFont: getComputedStyle(code).fontFamily,
      };
    });

    // A heading reads as one: larger and heavier than the body text.
    expect(styles.h1).toBeGreaterThan(styles.p * 1.5);
    expect(styles.headingWeight).toBeGreaterThanOrEqual(600);
    // Tailwind's reset removes list markers unless typography puts them back.
    expect(styles.listStyle).not.toBe("none");
    expect(styles.codeFont.toLowerCase()).toMatch(/mono|menlo|consolas/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
