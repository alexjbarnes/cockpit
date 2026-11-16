// An issue's plan, reviewed from the issue.
//
// The plan is its own versioned thing beside the issue: an agent writes it
// through the cockpit tools, a person opens it on the issue page, marks it up
// and sends it back or approves it, and the issue moves on. The description
// stays the requirement throughout. Every link in that has to be live: the
// tool the agent calls, the page section, the modal, the review route and the
// status move.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import { expect, test } from "./fixtures";
import type { Harness } from "./harness";

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

const REQUIREMENT = "We need a greeting file.";
const PLAN_V1 = "# Add a greeting\n\n1. Create hello.txt\n2. Write the word hello into it\n";
const PLAN_V2 = "# Add a greeting\n\n1. Create hello.txt in the docs folder\n2. Write the word hello into it\n3. Add a test for it\n";

/** Set ISSUE_PLAN_SHOTS to a folder to keep a picture of each step. */
const SHOTS = process.env.ISSUE_PLAN_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

interface StoredIssue {
  key: string;
  status: string;
  description: string;
  comments: { body: string }[];
  activity: { kind: string; planVersion?: number; planOutcome?: string; actor: { kind: string } }[];
}

async function seedIssue(page: Page, harness: Harness, status: string): Promise<string> {
  await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { issuesEnabled: true } });
  const projectRes = await page.request.post(`${harness.cockpitUrl}/api/projects`, { data: { name: "Greeter", prefix: "GR" } });
  expect(projectRes.ok()).toBe(true);
  const { project } = await projectRes.json();
  const created = await page.request.post(`${harness.cockpitUrl}/api/issues`, {
    data: { projectId: project.id, title: "Add a greeting", description: REQUIREMENT },
  });
  expect(created.ok()).toBe(true);
  const { issue } = await created.json();
  const moved = await page.request.put(`${harness.cockpitUrl}/api/issues/${issue.key}`, { data: { status } });
  expect(moved.ok()).toBe(true);
  return issue.key as string;
}

async function readIssue(page: Page, harness: Harness, key: string): Promise<StoredIssue> {
  const res = await page.request.get(`${harness.cockpitUrl}/api/issues/${key}`);
  return (await res.json()).issue as StoredIssue;
}

async function writePlan(page: Page, harness: Harness, key: string, content: string): Promise<void> {
  const res = await page.request.post(`${harness.cockpitUrl}/api/issues/${key}/plan`, { data: { content } });
  expect(res.ok()).toBe(true);
}

test("an agent's plan is reviewed on the issue, sent back, revised and approved", async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const workDir = mkdtempSync(path.join(tmpdir(), "cockpit-it-issueplan-"));
  mkdirSync(path.join(workDir, ".git"), { recursive: true });
  harness.trustWorkDir(workDir);

  try {
    const key = await seedIssue(page, harness, "Refining");

    // The agent's half: an unattended run writes the plan through the tool
    // and hands the issue to a person.
    harness.mock.setScript([
      { events: toolUseResponse("mcp__cockpit-config__set_issue_plan", { key, content: PLAN_V1 }) },
      { events: toolUseResponse("mcp__cockpit-config__update_issue", { key, status: "Plan Review" }) },
      { events: textResponse("Planned.") },
    ]);
    const jobRes = await page.request.post(`${harness.cockpitUrl}/api/jobs`, {
      data: {
        name: "planner",
        prompt: `Plan ${key}.`,
        cwd: workDir,
        schedules: [{ type: "simple", frequency: "daily", time: "09:00" }],
        enabled: false,
        runtime: "pty",
        inboxOutput: true,
        bypassPermissions: true,
      },
    });
    const { job } = await jobRes.json();
    const trigger = await page.request.post(`${harness.cockpitUrl}/api/jobs/${job.id}/trigger`, { timeout: 120_000 });
    const { run } = await trigger.json();
    expect(run.status, run.error).toBe("success");

    const planned = await readIssue(page, harness, key);
    expect(planned.status).toBe("Plan Review");
    expect(planned.description).toBe(REQUIREMENT);
    expect(planned.activity.find((a) => a.kind === "plan_written")).toMatchObject({ planVersion: 1, actor: { kind: "job" } });

    // The person's half. The issue says a plan is waiting and opens it.
    await page.goto(`${harness.cockpitUrl}/issues/${key}`);
    await expect(page.getByTestId("issue-plan-state")).toHaveText("Waiting for your review");

    // Activity and Attachments fold away until asked for; the plan and the
    // comments are what the page is for.
    await expect(page.getByTestId("issue-activity-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("wrote plan version 1")).toHaveCount(0);
    await page.getByTestId("issue-activity-toggle").click();
    await expect(page.getByTestId("issue-activity-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("wrote plan version 1")).toBeVisible();
    await page.getByTestId("issue-activity-toggle").click();
    await shot(page, "desktop-1-issue");
    await page.getByTestId("issue-plan-open").click();
    const modal = page.getByTestId("issue-plan-modal");
    await expect(modal).toBeVisible();
    const doc = page.getByTestId("plan-document");
    await expect(doc).toContainText("Write the word hello into it");

    await doc.getByText("Create hello.txt").click({ clickCount: 3 });
    await expect(page.getByTestId("plan-toolbar")).toBeVisible();
    await page.getByTestId("plan-act-comment").click();
    await page.getByTestId("plan-composer-input").fill("Say which folder the file goes in.");
    await page.getByTestId("plan-composer-save").click();
    // The modal is wide enough on a desktop for the notes to sit beside the plan.
    const notes = page.getByTestId("plan-notes");
    await expect(notes).toContainText("Say which folder the file goes in.");
    await shot(page, "desktop-2-review");

    // The markup is stored, not held in the page: it is there after a reload.
    await page.waitForTimeout(800);
    await page.reload();
    await page.getByTestId("issue-plan-open").click();
    await expect(notes).toContainText("Say which folder the file goes in.", { timeout: 20_000 });

    await page.getByTestId("plan-send-feedback").click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("issue-plan-state")).toHaveText("Changes requested");

    const sentBack = await readIssue(page, harness, key);
    expect(sentBack.status).toBe("Refine Ready");
    expect(sentBack.description).toBe(REQUIREMENT);
    expect(sentBack.comments.at(-1)?.body).toContain("Plan version 1: changes requested");
    expect(sentBack.comments.at(-1)?.body).toContain("Say which folder the file goes in.");
    expect(sentBack.activity.find((a) => a.kind === "plan_reviewed")).toMatchObject({ planVersion: 1, planOutcome: "changes_requested" });
    // The feedback is on the page as a comment, where the thread is read.
    await expect(page.getByText("Plan version 1: changes requested")).toBeVisible();

    // The next version arrives while the page is open elsewhere; coming back
    // to it shows the new one without a reload.
    await writePlan(page, harness, key, PLAN_V2);
    await page.request.put(`${harness.cockpitUrl}/api/issues/${key}`, { data: { status: "Plan Review" } });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByTestId("issue-plan-state")).toHaveText("Waiting for your review", { timeout: 15_000 });
    await page.getByTestId("issue-plan-open").click();
    await expect(page.getByTestId("plan-version-select")).toHaveValue("2");

    // What changed since last time is on the screen without asking.
    await expect(page.getByTestId("plan-change-summary")).toContainText("since version 1");
    await expect(page.getByTestId("plan-changed-rail").first()).toBeVisible();
    await shot(page, "desktop-3-revised");
    await page.getByTestId("plan-view-changes").click();
    await expect(page.getByTestId("plan-diff")).toBeVisible();

    // The round before is still there, with its note and what was sent.
    await page.getByTestId("plan-version-select").selectOption("1");
    await expect(page.getByTestId("plan-outcome")).toContainText("Changes requested");
    await page.getByTestId("plan-sent-toggle").click();
    await expect(page.getByTestId("plan-sent")).toContainText("Say which folder the file goes in.");

    // Escape leaves the modal, and the issue page is underneath, untouched.
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(page.getByTestId("issue-plan-open")).toBeVisible();

    await page.getByTestId("issue-plan-open").click();
    await page.getByTestId("plan-approve").click();
    await page.getByTestId("plan-approve-approve").click();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("issue-plan-state")).toHaveText("Approved");

    const approved = await readIssue(page, harness, key);
    expect(approved.status).toBe("Implementation Ready");
    expect(approved.description).toBe(REQUIREMENT);

    // An agent picking the issue up next reads the requirement, the approved
    // plan and nothing it has to guess at, in one call.
    const planRes = await page.request.get(`${harness.cockpitUrl}/api/issues/${key}/plan`);
    const plan = (await planRes.json()) as { versions: { n: number; review?: { outcome: string } }[]; reviewable: number | null };
    expect(plan.versions.map((v) => [v.n, v.review?.outcome])).toEqual([
      [1, "changes_requested"],
      [2, "approved"],
    ]);
    expect(plan.reviewable).toBeNull();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("a review of a plan that has since been replaced is refused, and says so", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const key = await seedIssue(page, harness, "Plan Review");
  await writePlan(page, harness, key, PLAN_V1);

  await page.goto(`${harness.cockpitUrl}/issues/${key}`);
  await page.getByTestId("issue-plan-open").click();
  await expect(page.getByTestId("plan-document")).toContainText("Create hello.txt");

  // The agent writes again behind the open modal.
  await writePlan(page, harness, key, PLAN_V2);

  await page.getByTestId("plan-approve").click();
  await page.getByTestId("plan-approve-approve").click();
  await expect(page.getByTestId("issue-plan-error")).toContainText("version 2 replaced it");
  // Nothing was approved, and the modal now shows the plan as it is.
  await expect(page.getByTestId("plan-version-select")).toHaveValue("2");
  expect((await readIssue(page, harness, key)).status).toBe("Plan Review");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a person writes a plan, marks it up by tapping and sends it back", async ({ page, harness }) => {
    const key = await seedIssue(page, harness, "Plan Review");

    await page.goto(`${harness.cockpitUrl}/issues/${key}`);
    await expect(page.getByTestId("issue-plan")).toContainText("No plan yet");
    await writePlan(page, harness, key, PLAN_V1);
    await page.reload();

    await page.getByTestId("issue-plan-open").tap();
    const modal = page.getByTestId("issue-plan-modal");
    await expect(modal).toBeVisible();
    // The modal is the whole screen on a phone.
    const box = await modal.boundingBox();
    expect(box?.width).toBe(390);
    expect(box?.height).toBe(844);

    await page.getByTestId("plan-tap-toggle").tap();
    await page.getByTestId("plan-document").getByText("Write the word hello into it").tap();
    await expect(page.getByTestId("plan-toolbar")).toBeVisible();
    await page.getByTestId("plan-act-comment").tap();
    await page.getByTestId("plan-label-tests").tap();
    await page.getByTestId("plan-composer-save").tap();
    await expect(page.getByTestId("plan-notes-count")).toHaveText("1");

    await shot(page, "phone-1-review");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByTestId("plan-send-feedback").tap();
    await expect(modal).toBeHidden({ timeout: 15_000 });
    await shot(page, "phone-2-issue");
    const issue = await readIssue(page, harness, key);
    expect(issue.status).toBe("Refine Ready");
    expect(issue.comments.at(-1)?.body).toContain("Needs tests");
  });
});
