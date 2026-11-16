// The Workflows side of Issues: what the workflows are waiting on you for and
// what they are working on, built from the activity view and the issues
// themselves. The activity is mocked, so no CLI is involved.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

const row = (issueKey: string, status = "Refining") => ({
  issueKey,
  title: `Issue ${issueKey}`,
  projectId: "p",
  status,
  skill: "refine-issue",
});

const ACTIVITY = {
  enabled: true,
  paused: false,
  slots: { used: 1, max: 3 },
  running: [row("GR-3", "Implementation")],
  queued: [row("GR-4", "Refine Ready")],
  waiting: [row("GR-1", "Plan Review")],
  attention: [{ ...row("GR-2", "Refining"), reason: "It broke", at: 1 }],
};

async function seed(page: Page, harness: Harness, issuesEnabled = true): Promise<void> {
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled, workflowsEnabled: true } });
  expect(patched.ok()).toBe(true);
  const { project } = await (
    await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Greeter", prefix: "GR" } })
  ).json();
  for (const n of [1, 2, 3, 4]) {
    await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title: `Issue GR-${n}` } });
  }
}

async function mockActivity(page: Page, activity: unknown): Promise<void> {
  await page.route("**/api/workflows/activity", (route) => route.fulfill({ json: activity }));
}

test("lists what is waiting on you and what is active, each row opening its issue", async ({ page, harness }) => {
  await seed(page, harness);
  await mockActivity(page, ACTIVITY);
  await page.goto(`${harness.cockpitUrl}/workflows`);

  // Waiting on you: the held issue first, then the one waiting for a decision.
  const waiting = page.getByTestId("workflows-waiting");
  await expect(waiting).toContainText("Issue GR-2");
  await expect(waiting).toContainText("Issue GR-1");
  const waitingText = (await waiting.textContent()) ?? "";
  expect(waitingText.indexOf("GR-2")).toBeLessThan(waitingText.indexOf("GR-1"));
  await expect(waiting.getByTestId("issue-flow-GR-2")).toHaveAttribute("data-flow", "attention");
  await expect(waiting.getByTestId("issue-flow-GR-1")).toHaveAttribute("data-flow", "yours");

  // Active: the running one, then the queued one.
  const active = page.getByTestId("workflows-active");
  await expect(active).toContainText("Issue GR-3");
  await expect(active).toContainText("Issue GR-4");
  const activeText = (await active.textContent()) ?? "";
  expect(activeText.indexOf("GR-3")).toBeLessThan(activeText.indexOf("GR-4"));

  // The row opens the issue.
  await waiting.getByText("Issue GR-1").click();
  await expect(page).toHaveURL(/\/issues\/GR-1$/);
});

test("its settings are one button away, and the switch goes back to the list", async ({ page, harness }) => {
  await seed(page, harness);
  await mockActivity(page, ACTIVITY);
  await page.goto(`${harness.cockpitUrl}/workflows`);

  await expect(page.getByTestId("issues-workflows-switch").getByRole("button", { name: "Workflows" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByTestId("issues-workflows-switch").getByRole("button", { name: "Issues" }).click();
  await expect(page).toHaveURL(/\/issues$/);

  await page.goto(`${harness.cockpitUrl}/workflows`);
  await page.getByTestId("workflows-settings").click();
  await expect(page).toHaveURL(/\/settings\/workflows$/);
});

test("says so when nothing is waiting or running", async ({ page, harness }) => {
  await seed(page, harness);
  await mockActivity(page, { ...ACTIVITY, running: [], queued: [], waiting: [], attention: [] });
  await page.goto(`${harness.cockpitUrl}/workflows`);
  await expect(page.getByTestId("workflows-waiting-empty")).toHaveText("Nothing is waiting on you.");
  await expect(page.getByTestId("workflows-active-empty")).toHaveText("Nothing is running or queued.");
});

test("sends you home when the issue tracker is off", async ({ page, harness }) => {
  await seed(page, harness, false);
  await page.goto(`${harness.cockpitUrl}/workflows`);
  await expect(page).toHaveURL(new RegExp(`${harness.cockpitUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/$`));
});
