// Adding a custom status to a project shows it, with the colour beside it.
//
// The palette used to sit inline beside the name: fourteen swatches are wider
// than a phone's dialog, so the name was squeezed to nothing and each row read
// as a strip of colours and a bin. The status was added; nothing on screen said
// which one, and there was no sign of where it would be saved.

import { execSync } from "node:child_process";
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

interface ProjectRow {
  id: string;
  name: string;
  customStatuses?: { name: string; color?: string }[];
}

test("a custom status is visible, colour and all, and saves with the project", async ({ page, harness }) => {
  test.setTimeout(90_000);
  await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
  const created = await page.request.post(`${harness.cockpitUrl}/api/projects`, {
    data: { name: "Statuses", prefix: "STS" },
  });
  expect(created.ok()).toBe(true);
  const project = ((await created.json()) as { project: ProjectRow }).project;

  // A phone, where the row used to lose its name.
  await page.setViewportSize({ width: 393, height: 760 });
  await page.goto(`${harness.cockpitUrl}/settings/projects`);
  await page.getByTestId(`edit-project-${project.id}`).click();

  const input = page.getByPlaceholder("Add a custom status, e.g. Blocked");
  for (const name of ["Blocked", "Triage"]) {
    await input.fill(name);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }

  // Both statuses are on screen by name, not just as colour strips.
  await expect(page.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(page.getByText("Triage", { exact: true })).toBeVisible();
  // And the page still fits the screen.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByTestId("custom-status-colour-Blocked-bg-red-500").click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const res = await page.request.get(`${harness.cockpitUrl}/api/projects`);
      const data = (await res.json()) as { projects: ProjectRow[] };
      return data.projects.find((p) => p.id === project.id)?.customStatuses ?? [];
    })
    .toEqual([{ name: "Blocked", color: "bg-red-500" }, { name: "Triage" }]);
});
