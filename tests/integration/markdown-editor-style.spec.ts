// A markdown file is edited as prose, not as source code: the app's own font,
// a page's padding and no line-number gutter. The preview beside it uses the
// same typography, so the two modes should not look like different products.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test.use({
  harnessOptions: {
    prepare: ({ claudeDir }) => {
      const dir = path.join(claudeDir, "skills", "probe");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        "---\ndescription: Probe\n---\n\n# Probe skill\n\nSome text with **bold** and a [link](https://example.com).\n",
      );
    },
  },
});

test("a markdown editor uses document styling, not code styling", async ({ page, harness }) => {
  await page.goto(`${harness.cockpitUrl}/skills/probe?scope=user`);
  const scroller = page.locator(".cm-scroller").first();
  await expect(scroller).toBeVisible({ timeout: 20_000 });

  const style = await scroller.evaluate((el) => {
    const content = el.querySelector(".cm-content");
    const gutters = el.querySelector(".cm-gutters") as HTMLElement | null;
    return {
      fontFamily: getComputedStyle(el).fontFamily,
      fontSize: getComputedStyle(el).fontSize,
      padding: content ? getComputedStyle(content).padding : null,
      gutters: gutters ? getComputedStyle(gutters).display : "missing",
    };
  });

  expect(style.fontFamily.toLowerCase()).not.toContain("monospace");
  expect(style.fontSize).toBe("14px");
  expect(style.padding).toBe("16px 20px");
  expect(style.gutters).toBe("none");

  // The theme reads the app's colour variables, so switching the class
  // switches the text without reconfiguring CodeMirror.
  const lightColor = await scroller.evaluate((el) => getComputedStyle(el).color);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const darkColor = await scroller.evaluate((el) => getComputedStyle(el).color);
  expect(darkColor).not.toBe(lightColor);
});
