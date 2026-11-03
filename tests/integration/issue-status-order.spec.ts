// A project's stored status order drives the sections the issue list shows.
// The order is set through the same project storage the MCP tool writes, and
// the list reads it through resolveProjectStatuses.

import { expect, test } from "./fixtures";

test("a project's section order is the order the issue list renders", async ({ page, harness }) => {
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
  expect(patched.ok()).toBe(true);

  const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
    data: { name: "Order project", prefix: "ORD" },
  });
  expect(projectRes.ok()).toBe(true);
  const { project } = (await projectRes.json()) as { project: { id: string } };

  for (const [title, status] of [
    ["Backlog row", "Backlog"],
    ["Accepted row", "Accepted"],
  ]) {
    const res = await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title } });
    expect(res.ok()).toBe(true);
    const { issue } = (await res.json()) as { issue: { key: string } };
    if (status !== "Backlog") {
      const moved = await page.request.put(`${harness.cockpitUrl}/api/issues/${issue.key}`, { data: { status } });
      expect(moved.ok()).toBe(true);
    }
  }

  // Accepted above Backlog: the reverse of the canonical lifecycle order.
  const ordered = await page.request.put(`${harness.cockpitUrl}/api/projects/${project.id}`, {
    data: { statusOrder: ["Accepted", "Backlog"] },
  });
  expect(ordered.ok()).toBe(true);

  await page.goto(`${harness.cockpitUrl}/issues`);
  const projectSelect = page.locator("select").first();
  await expect(projectSelect.locator(`option[value="${project.id}"]`)).toHaveCount(1, { timeout: 20_000 });
  await projectSelect.selectOption(project.id);

  await expect(page.getByTestId("issue-group-Accepted")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("issue-group-Backlog")).toBeVisible();
  const order = await page.locator('[data-testid^="issue-group-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(order).toEqual(["issue-group-Accepted", "issue-group-Backlog"]);
});
