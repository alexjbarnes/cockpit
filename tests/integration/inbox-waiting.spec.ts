// The Inbox's Waiting on you side: the workflow issues that want a decision,
// from the mocked activity view and the real issues. No CLI involved.

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
  slots: { used: 0, max: 3 },
  running: [row("GR-3", "Implementation")],
  queued: [],
  waiting: [row("GR-1", "Plan Review")],
  attention: [{ ...row("GR-2", "Refining"), reason: "It broke", at: 1 }],
};

async function seed(page: Page, harness: Harness, issuesEnabled = true): Promise<void> {
  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled, workflowsEnabled: true } });
  expect(patched.ok()).toBe(true);
  const { project } = await (
    await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Greeter", prefix: "GR" } })
  ).json();
  for (const n of [1, 2, 3]) {
    await page.request.post(`${harness.cockpitUrl}/api/issues`, { data: { projectId: project.id, title: `Issue GR-${n}` } });
  }
  await page.route("**/api/workflows/activity", (route) => route.fulfill({ json: ACTIVITY }));
}

test("lists the issues waiting on you, each opening its issue", async ({ page, harness }) => {
  await seed(page, harness);
  await page.goto(`${harness.cockpitUrl}/inbox/waiting`);

  const waiting = page.getByTestId("inbox-waiting");
  await expect(waiting).toContainText("Issue GR-2");
  await expect(waiting).toContainText("Issue GR-1");
  // The running issue is not waiting on you.
  await expect(waiting).not.toContainText("Issue GR-3");
  await expect(page.getByTestId("inbox-switch").getByRole("button", { name: "Waiting on you" })).toHaveAttribute("aria-pressed", "true");

  await waiting.getByText("Issue GR-2").click();
  await expect(page).toHaveURL(/\/issues\/GR-2$/);
});

test("the switch goes back to the messages", async ({ page, harness }) => {
  await seed(page, harness);
  await page.goto(`${harness.cockpitUrl}/inbox/waiting`);
  await page.getByTestId("inbox-switch").getByRole("button", { name: "Inbox", exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test("says so when nothing is waiting, and goes back to the Inbox when the tracker is off", async ({ page, harness }) => {
  await seed(page, harness);
  await page.route("**/api/workflows/activity", (route) => route.fulfill({ json: { ...ACTIVITY, waiting: [], attention: [] } }));
  await page.goto(`${harness.cockpitUrl}/inbox/waiting`);
  await expect(page.getByTestId("inbox-waiting-empty")).toHaveText("Nothing is waiting on you.");

  const patched = await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: false } });
  expect(patched.ok()).toBe(true);
  await page.goto(`${harness.cockpitUrl}/inbox/waiting`);
  await expect(page).toHaveURL(/\/inbox$/);
});
