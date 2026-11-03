// A long line inside a fenced block wraps instead of hiding behind a
// horizontal scrollbar. Agent-written prose often arrives in a fence, and one
// unbroken line used to widen the block and push the whole page sideways.

import { expect, test } from "./fixtures";

const LONG_LINE = `Technical scope: ${"the service deploys from a single pipeline and production follows it. ".repeat(12)}`;

test("a long line in a fenced block wraps on a phone", async ({ page, harness }) => {
  await page.setViewportSize({ width: 393, height: 760 });
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
  expect(patched.ok()).toBe(true);

  const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
    data: { name: "Wrap project", prefix: "WRAP" },
  });
  expect(projectRes.ok()).toBe(true);
  const { project } = (await projectRes.json()) as { project: { id: string } };

  const issueRes = await page.request.post(`${harness.cockpitUrl}/api/issues`, {
    data: {
      projectId: project.id,
      title: "Long fenced line",
      description: "```\n" + LONG_LINE + "\n```",
    },
  });
  expect(issueRes.ok()).toBe(true);
  const { issue } = (await issueRes.json()) as { issue: { key: string } };

  await page.goto(`${harness.cockpitUrl}/issues/${encodeURIComponent(issue.key)}`);
  const pre = page.locator("pre").first();
  await expect(pre).toBeVisible({ timeout: 20_000 });

  const metrics = await pre.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    whiteSpace: getComputedStyle(el).whiteSpace,
  }));
  expect(metrics.whiteSpace).toBe("pre-wrap");
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  const pageOverflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(pageOverflows).toBe(false);
});
