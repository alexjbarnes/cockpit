// Workflows as a person meets them: saying in Settings what happens at each of
// a project's statuses, and following an issue through it from the issue page,
// with real sessions doing the agents' work. On a desktop and on a phone.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { textResponse, toolUseResponse } from "../mock-api/builder";
import type { TurnScript } from "../mock-api/types";
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

const UPDATE = "mcp__cockpit-config__update_issue";
const SET_PLAN = "mcp__cockpit-config__set_issue_plan";
const PLAN = "# Add a greeting\n\n1. Create hello.txt\n2. Write the word hello into it\n";

/** Set WORKFLOW_SHOTS to a folder to keep a picture of each step. */
const SHOTS = process.env.WORKFLOW_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Planning and building each have a queue in front; a person reviews the plan and then the work. */
const RULES = {
  "Refine Ready": { kind: "queue", to: "Refining" },
  Refining: { kind: "agent", skill: "plan-issue", maxRetries: 0, next: ["Plan Review"] },
  "Plan Review": {
    kind: "human",
    review: "plan",
    next: [
      { status: "Implementation Ready", label: "Approve", role: "approve" },
      { status: "Refine Ready", label: "Send back", role: "sendBack" },
    ],
  },
  "Implementation Ready": { kind: "queue", to: "Implementation" },
  Implementation: { kind: "agent", skill: "implement-issue", maxRetries: 0, next: ["Code Review"] },
  "Code Review": {
    kind: "human",
    next: [
      { status: "Done", label: "Accept" },
      { status: "Implementation Ready", label: "Send back" },
    ],
  },
};

function writeSkill(repo: string, name: string, description: string): void {
  mkdirSync(path.join(repo, ".claude", "skills", name), { recursive: true });
  writeFileSync(path.join(repo, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nDo it.\n`);
}

function callId(events: ReturnType<typeof toolUseResponse>): string {
  for (const e of events) {
    const block = (e.data as { content_block?: { type?: string; id?: string } }).content_block;
    if (block?.type === "tool_use" && block.id) return block.id;
  }
  throw new Error("no tool call in these events");
}

/** The opening of the prompt an agent working in `status` on `key` is sent, as it is in a request body. */
const opening = (status: string, key: string) => `the \\"${status}\\" status of a workflow on issue ${key},`;

/** One agent's conversation on one issue: its tool calls in order, then a last word. */
function runTurns(
  status: string,
  key: string,
  calls: { name: string; input: Record<string, unknown> }[],
  last: string,
  delayMs = 0,
): TurnScript[] {
  const turns = calls.map((c) => toolUseResponse(c.name, c.input));
  const script: TurnScript[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    script.push({ match: callId(turns[i]), events: i === turns.length - 1 ? textResponse(last) : turns[i + 1] });
  }
  script.push({ match: opening(status, key), events: turns[0] ?? textResponse(last), ...(delayMs ? { delayMs } : {}) });
  return script;
}

const TITLE: TurnScript = { match: '"json_schema"', events: textResponse('{"title":"Run"}') };

async function factory(page: Page, harness: Harness, repo: string): Promise<{ projectId: string; key: string }> {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeSkill(repo, "plan-issue", "Write the plan for an issue.");
  writeSkill(repo, "implement-issue", "Build what the plan says.");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", "commit", "-q", "-m", "init"], { cwd: repo });
  harness.trustWorkDir(repo);
  const api = harness.cockpitUrl;
  await page.request.patch(`${api}/api/defaults`, { data: { issuesEnabled: true, workflowsEnabled: true, workflowMaxParallel: 2 } });
  const { project } = await (
    await page.request.post(`${api}/api/projects`, { data: { name: "Greeter", prefix: "GR", repoPath: repo } })
  ).json();
  const saved = await page.request.put(`${api}/api/projects/${project.id}/workflow`, { data: { statuses: RULES } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { issue } = await (
    await page.request.post(`${api}/api/issues`, {
      data: { projectId: project.id, title: "Add a greeting", description: "We need a greeting file." },
    })
  ).json();
  return { projectId: project.id, key: issue.key };
}

async function issueStatus(page: Page, harness: Harness, key: string): Promise<string> {
  return (await (await page.request.get(`${harness.cockpitUrl}/api/issues/${key}`)).json()).issue.status as string;
}

async function followIssue(page: Page, harness: Harness, key: string, label: string): Promise<void> {
  const workflow = page.getByTestId("issue-workflow");
  await page.goto(`${harness.cockpitUrl}/issues/${key}`);
  await expect(workflow).toBeVisible();
  // A plan is only ever written by an agent: there is nothing to write one with.
  await expect(page.getByTestId("issue-plan-none")).toBeVisible();
  await expect(page.getByTestId("issue-plan-write")).toHaveCount(0);
  // One bar for each status where something happens to the issue, none for a queue.
  const track = page.getByTestId("workflow-track");
  await expect(track.locator("li")).toHaveCount(4);
  await expect(page.getByTestId("workflow-stop-Refining")).toHaveAttribute("data-position", "ahead");
  await expect(page.getByTestId("workflow-stop-Refine Ready")).toHaveCount(0);
  await shot(page, `${label}-1-not-started`);

  // One button starts it: the issue goes into the first queue.
  await expect(page.getByTestId("workflow-start")).toHaveText("Move to Refine Ready");
  await page.getByTestId("workflow-start").click();
  const running = page.getByTestId("workflow-running");
  await expect(running).toBeVisible({ timeout: 20_000 });
  await expect(running).toContainText("An agent is running plan-issue");
  await expect(page.getByTestId("workflow-stop-Refining")).toHaveAttribute("data-position", "current");
  // Peek opens the session over the issue, rather than leaving it.
  await page.evaluate(() => {
    const w = window as unknown as { __wsSent?: string[]; __wsHooked?: boolean };
    w.__wsSent = [];
    if (w.__wsHooked) return;
    w.__wsHooked = true;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        w.__wsSent?.push(String(data));
      } catch {
        // a frame we cannot read is not what this is looking for
      }
      return send.call(this, data);
    };
  });
  await page.getByTestId("workflow-peek").click();
  const peek = page.getByTestId("session-peek");
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("plan-issue");
  // A peek counts as looking at the session: the server is told while the
  // modal is open, so a turn ending now raises no banner or push.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __wsSent?: string[] }).__wsSent?.some(
          (f) => f.includes('"session:set_peeking"') && f.includes('"peeking":true'),
        ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __wsSent?: string[] }).__wsSent?.some(
          (f) => f.includes('"session:set_peeking"') && f.includes('"peeking":false'),
        ),
      ),
    )
    .toBe(true);
  await shot(page, `${label}-2-running`);

  // The page follows the run without being touched: when the plan is
  // written, the status that is the person's is on the screen.
  const yours = page.getByTestId("workflow-yours");
  await expect(yours).toBeVisible({ timeout: 60_000 });
  await expect(yours).toContainText("Plan Review is yours");
  await expect(page.getByTestId("workflow-stop-Refining")).toHaveAttribute("data-position", "done");
  await expect(page.getByTestId("workflow-stop-Plan Review")).toHaveAttribute("data-position", "current");
  await expect(page.getByTestId("issue-plan-state")).toHaveText("Waiting for your review");
  await shot(page, `${label}-3-yours`);

  // Pressing a bar says what that status is; pressing it again goes back.
  const caption = page.getByTestId("workflow-track-caption");
  await page.getByTestId("workflow-stop-Implementation").click();
  await expect(caption).toContainText("Implementation");
  await expect(caption).toContainText("3 of 4. Still to come. An agent runs implement-issue.");
  await shot(page, `${label}-3b-stop-picked`);
  await page.getByTestId("workflow-stop-Implementation").click();
  await expect(caption).not.toContainText("Still to come");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("a project's workflow is set up in Settings: what happens at each status, with a skill from its repo", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = harness.cockpitUrl;
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-set-"));
  writeSkill(repo, "plan-issue", "Write the plan for an issue.");

  try {
    await page.request.patch(`${api}/api/defaults`, { data: { issuesEnabled: true } });
    const { project } = await (
      await page.request.post(`${api}/api/projects`, { data: { name: "Greeter", prefix: "GR", repoPath: repo } })
    ).json();
    await page.request.post(`${api}/api/projects`, { data: { name: "Website", prefix: "WS" } });
    const stored = async () =>
      (await (await page.request.get(`${api}/api/projects/${project.id}/workflow`)).json()) as {
        workflow: { maxParallel: number; statuses: Record<string, Record<string, unknown>> } | null;
        statuses: string[];
      };

    // One switch turns workflows on, and each project is listed with its own.
    await page.goto(`${api}/settings/workflows`);
    await page.getByTestId("workflows-enabled").click();
    await expect(page.getByTestId("workflows-enabled")).toHaveAttribute("aria-checked", "true");
    // The box can be emptied on the way to another number.
    const total = page.getByTestId("workflows-max-parallel");
    await total.click();
    await total.press("End");
    await total.press("Backspace");
    await expect(total).toHaveValue("");
    await page.keyboard.type("4");
    await expect(total).toHaveValue("4");
    await expect.poll(async () => (await (await page.request.get(`${api}/api/defaults`)).json()).workflowMaxParallel).toBe(4);
    await expect(page.getByTestId("workflow-GR")).toContainText("No workflow yet");
    // A project with nowhere to read skills from says so, and has nothing to set up.
    await expect(page.getByTestId("workflow-WS")).toContainText("No repo path");
    await expect(page.getByTestId("workflow-setup-WS")).toHaveCount(0);
    await shot(page, "settings-1-list-empty");

    // Its page is the project's own statuses, in board order, with nothing happening at any yet.
    await page.getByTestId("workflow-setup-GR").click();
    await expect(page.getByTestId("workflow-title")).toHaveText("Greeter's workflow", { timeout: 15_000 });
    await expect(page.getByTestId("workflow-empty")).toBeVisible();
    await expect(page.getByTestId("status-row-Backlog")).toHaveAttribute("data-kind", "none");
    await expect(page.getByTestId("status-row-Refining")).toContainText("Nothing happens here");
    await expect(page.getByTestId("workflow-remove")).toHaveCount(0);
    await expect(page.getByTestId("workflow-save")).toBeHidden();
    await shot(page, "settings-2-nothing-yet");

    // A status opens as one question, and then only what the answer needs.
    await page.getByTestId("status-row-Refining").click();
    const editor = page.getByTestId("status-editor");
    await expect(editor).toBeVisible();
    await expect(page.getByTestId("status-kind-none")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("rule-skill")).toHaveCount(0);
    await page.getByTestId("status-kind-agent").click();
    // The skill is picked from the ones in the repo, in a dropdown like every other in the app.
    const skill = page.getByTestId("rule-skill");
    expect(await skill.evaluate((el) => el.tagName)).toBe("SELECT");
    await expect(page.getByTestId("rule-problem")).toContainText("Choose the skill");
    await skill.selectOption("plan-issue");
    await expect(page.getByTestId("rule-skill-info")).toContainText("Write the plan for an issue.");
    await expect(page.getByTestId("rule-skill-info")).toContainText(".claude/skills/plan-issue/SKILL.md");
    // Where the issue can go is a status and nothing more.
    const next = page.getByTestId("rule-next-0-status");
    expect(await next.evaluate((el) => el.tagName)).toBe("SELECT");
    await next.selectOption("Plan Review");
    await expect(page.getByTestId("rule-problem")).toHaveCount(0);
    await page.getByTestId("rule-thinking-high").click();
    await shot(page, "settings-3-agent");
    // What is rarely changed is one tap further in.
    await expect(page.getByTestId("rule-minutes")).toBeHidden();
    await page.getByTestId("rule-more").click();
    await page.getByTestId("rule-minutes").fill("30");
    await page.getByTestId("rule-permission").getByRole("button", { name: "Only what I list" }).click();
    await page.getByTestId("rule-tool-input").fill("Read");
    await page.getByTestId("rule-tool-input").press("Enter");
    await shot(page, "settings-4-agent-more");
    await page.getByTestId("status-done").click();
    await expect(editor).toBeHidden();
    await expect(page.getByTestId("status-row-Refining")).toContainText("An agent works on it");
    await expect(page.getByTestId("status-row-Refining")).toContainText("Runs plan-issue");

    // A queue only says where its issues are worked, and offers the status that has an agent.
    await page.getByTestId("status-row-Refine Ready").click();
    await page.getByTestId("status-kind-queue").click();
    await expect(page.getByTestId("rule-to")).toHaveValue("Refining");
    await shot(page, "settings-5-queue");
    await page.getByTestId("status-done").click();
    await expect(page.getByTestId("status-row-Refine Ready")).toContainText("then move to");

    // A status that waits for the person: a plan review asks only where each answer sends the issue.
    await page.getByTestId("status-row-Plan Review").click();
    await page.getByTestId("status-kind-human").click();
    await page.getByTestId("rule-review").getByRole("button", { name: "Review the plan" }).click();
    await page.getByTestId("rule-approve-status").selectOption("Implementation Ready");
    await page.getByTestId("rule-sendback-status").selectOption("Refine Ready");
    await shot(page, "settings-6-yours");
    await page.getByTestId("status-done").click();

    // A status the project does not have yet can be named in the same control.
    await page.getByTestId("status-row-Implementation Ready").click();
    await page.getByTestId("status-kind-agent").click();
    await page.getByTestId("rule-skill").selectOption("plan-issue");
    await page.getByTestId("rule-next-0-status").selectOption({ label: "New status…" });
    await page.getByTestId("rule-next-0-status-new").fill("Validation");
    await page.getByTestId("rule-next-0-status-new").press("Enter");
    await expect(page.getByTestId("rule-next-0-status")).toHaveValue("Validation");
    await page.getByTestId("status-done").click();
    // Done is where an issue comes to rest: nothing can be queued or worked there.
    await page.getByTestId("status-row-Done").click();
    await expect(page.getByTestId("status-kind-agent")).toBeDisabled();
    await expect(page.getByTestId("status-kind-queue")).toBeDisabled();
    await page.getByTestId("status-done").click();

    // A number that must be set can still be emptied while it is typed, and
    // what is not a number in range leaves the last good one in place.
    const atOnce = page.getByTestId("workflow-max-parallel");
    await atOnce.click();
    await atOnce.press("End");
    await atOnce.press("Backspace");
    await expect(atOnce).toHaveValue("");
    await atOnce.press("Tab");
    await expect(atOnce).toHaveValue("2");
    await atOnce.fill("999");
    await atOnce.press("Tab");
    await expect(atOnce).toHaveValue("2");
    await atOnce.click();
    await atOnce.press("End");
    await atOnce.press("Backspace");
    await page.keyboard.type("3");
    await expect(atOnce).toHaveValue("3");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "settings-7-path");
    await page.getByTestId("workflow-save").click();
    await expect(page.getByTestId("workflow-save")).toBeHidden({ timeout: 15_000 });

    const first = await stored();
    expect(first.workflow).toMatchObject({ maxParallel: 3 });
    expect(first.workflow?.statuses).toMatchObject({
      "Refine Ready": { kind: "queue", to: "Refining" },
      Refining: {
        kind: "agent",
        skill: "plan-issue",
        next: ["Plan Review"],
        maxDurationMinutes: 30,
        thinkingLevel: "high",
        permission: "allowlist",
        allowedTools: ["Read"],
      },
      "Plan Review": { kind: "human", review: "plan" },
      "Implementation Ready": { kind: "agent", skill: "plan-issue", next: ["Validation"] },
    });
    // The status that was named is on the project's board now, and on this page.
    expect(first.statuses).toContain("Validation");
    await expect(page.getByTestId("status-row-Validation")).toContainText("Nothing happens here");
    await expect(page.getByTestId("workflow-remove")).toBeVisible();

    // A workflow that does not hold together is refused, in the save bar, and nothing is stored.
    await page.getByTestId("status-row-Refining").click();
    await page.getByTestId("status-kind-none").click();
    await page.getByTestId("status-done").click();
    // The queue that fed it says so before anything is saved.
    await expect(page.getByTestId("status-row-Refine Ready")).toContainText('No agent works in "Refining" yet');
    await page.getByTestId("workflow-save").click();
    await expect(page.getByTestId("workflow-save-message")).toContainText('no agent works in "Refining"');
    expect((await stored()).workflow?.statuses.Refining).toMatchObject({ skill: "plan-issue" });
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("status-row-Refining")).toContainText("Runs plan-issue");

    // A skill the workflow names that is not in the repo: the status says nothing can start, and where to add it.
    await page.request.put(`${api}/api/projects/${project.id}/workflow`, {
      data: { statuses: { "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Validation"] } } },
    });
    await page.reload();
    await expect(page.getByTestId("status-missing-Implementation Ready")).toContainText("No skill called implement-issue in this repo");
    await page.getByTestId("status-row-Implementation Ready").click();
    await expect(page.getByTestId("rule-skill")).toHaveValue("implement-issue");
    await expect(page.getByTestId("rule-skill-missing")).toContainText(".claude/skills/implement-issue/SKILL.md");
    await shot(page, "settings-8-skill-missing");
    await page.getByTestId("status-done").click();

    // The list shows the project's workflow as where an agent works or the person decides.
    await page.goto(`${api}/settings/workflows`);
    await expect(page.getByTestId("workflow-GR")).toContainText("Refining");
    await expect(page.getByTestId("workflow-GR")).toContainText("Plan Review");
    await expect(page.getByTestId("workflow-GR")).not.toContainText("Refine Ready");
    await shot(page, "settings-9-list");
    // The project's own settings no longer choose a workflow: it has its own.
    await page.goto(`${api}/settings/projects`);
    await page.getByTestId(`edit-project-${project.id}`).click();
    await expect(page.getByTestId("project-base-branch")).toBeVisible();
    await expect(page.getByTestId("project-workflow")).toHaveCount(0);

    // And it can be removed, which leaves the project and its statuses as they are.
    await page.goto(`${api}/settings/workflows/${project.id}`);
    await page.getByTestId("workflow-remove").click();
    await page.getByTestId("workflow-remove-confirm").click();
    await expect(page.getByTestId("workflow-GR")).toContainText("No workflow yet", { timeout: 15_000 });
    expect((await stored()).workflow).toBeNull();
    expect((await stored()).statuses).toContain("Validation");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a project with nothing set can copy another project's workflow, as unsaved changes", async ({ page, harness }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = harness.cockpitUrl;
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-copy-"));
  writeSkill(repo, "plan-issue", "Write the plan for an issue.");

  try {
    await page.request.patch(`${api}/api/defaults`, { data: { issuesEnabled: true } });
    const made = async (name: string, prefix: string) =>
      (await (await page.request.post(`${api}/api/projects`, { data: { name, prefix, repoPath: repo } })).json()).project as { id: string };
    const source = await made("Greeter", "GR");
    const target = await made("Rover", "RV");
    const saved = await page.request.put(`${api}/api/projects/${source.id}/workflow`, {
      data: {
        statuses: { Waiting: { kind: "queue", to: "Refining" }, Refining: { kind: "agent", skill: "plan-issue", next: ["Plan Review"] } },
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);

    await page.goto(`${api}/settings/workflows/${target.id}`);
    await expect(page.getByTestId("workflow-empty")).toBeVisible();
    await page.getByTestId("workflow-copy").selectOption({ label: "Greeter" });
    // On the page to be read, not yet running anything.
    await expect(page.getByTestId("status-row-Refining")).toContainText("Runs plan-issue");
    await expect(page.getByTestId("status-row-Waiting")).toContainText("A queue");
    await expect(page.getByTestId("workflow-save-message")).toHaveText("Unsaved changes");
    const before = await (await page.request.get(`${api}/api/projects/${target.id}/workflow`)).json();
    expect(before.workflow).toBeNull();

    await page.getByTestId("workflow-save").click();
    await expect(page.getByTestId("workflow-save")).toBeHidden({ timeout: 15_000 });
    const after = await (await page.request.get(`${api}/api/projects/${target.id}/workflow`)).json();
    expect(Object.keys(after.workflow.statuses).sort()).toEqual(["Refining", "Waiting"]);
    // The status the other project had made its own is added to this one's board.
    expect(after.statuses).toContain("Waiting");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an issue is followed through its workflow from its page: started, planned, approved, held and retried", async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-ui-"));

  try {
    const { key } = await factory(page, harness, repo);
    harness.mock.setScript([
      TITLE,
      ...runTurns(
        "Refining",
        key,
        [
          { name: SET_PLAN, input: { key, content: PLAN } },
          { name: UPDATE, input: { key, status: "Plan Review" } },
        ],
        "Planned.",
        5000,
      ),
      // The build never moves the issue: asked once, it still does not.
      { match: `stopped without moving ${key} on`, events: textResponse("I cannot do more.") },
      { match: opening("Implementation", key), events: textResponse("I looked at it."), delayMs: 3000 },
      { events: textResponse("Nothing to do.") },
    ]);

    await followIssue(page, harness, key, "desktop");

    // The list says whose move it is, and the bar above it counts it.
    await page.goto(`${harness.cockpitUrl}/issues`);
    await expect(page.getByTestId(`issue-flow-${key}`)).toHaveAttribute("data-flow", "yours");
    // The status's own heading says what happens there.
    await expect(page.getByTestId("status-stage-Plan Review")).toHaveText("Yours");
    // The Workflows side of Issues lists it as waiting on you.
    await page.goto(`${harness.cockpitUrl}/workflows`);
    const waiting = page.getByTestId("workflows-waiting");
    await expect(waiting).toContainText("Add a greeting");
    await expect(waiting.getByTestId(`issue-flow-${key}`)).toHaveAttribute("data-flow", "yours");
    await shot(page, "desktop-4-workflows");
    await waiting.getByText("Add a greeting").click();
    await expect(page).toHaveURL(new RegExp(`/issues/${key}$`));

    // Approving the plan is the move: the next agent starts by itself.
    await page.getByTestId("issue-plan-open").click();
    await page.getByTestId("plan-approve").click();
    await page.getByTestId("plan-approve-approve").click();
    await expect(page.getByTestId("workflow-running")).toContainText("An agent is running implement-issue", { timeout: 30_000 });
    await expect(page.getByTestId("workflow-stop-Implementation")).toHaveAttribute("data-position", "current");

    // The build stalls and the issue is held, with the reason and a way on.
    const held = page.getByTestId("workflow-attention");
    await expect(held).toBeVisible({ timeout: 90_000 });
    await expect(held).toContainText("Held at Implementation");
    await expect(held).toContainText("without moving");
    await shot(page, "desktop-5-held");
    // Back in the queue it came from, which says what it is waiting for.
    expect(await issueStatus(page, harness, key)).toBe("Implementation Ready");
    // Held in its queue, it is still drawn at the status it waits for.
    await expect(page.getByTestId("workflow-stop-Implementation")).toHaveAttribute("data-position", "current");

    await page.getByTestId("workflow-runs-toggle").click();
    await expect(page.getByTestId("workflow-runs")).toContainText("Refining");
    await expect(page.getByTestId("workflow-runs")).toContainText("plan-issue");
    await expect(page.getByTestId("workflow-runs")).toContainText("Failed");
    await shot(page, "desktop-6-runs");

    await page.getByTestId("workflow-retry").click();
    await expect(page.getByTestId("workflow-running")).toContainText("An agent is running implement-issue", { timeout: 30_000 });
    await expect(held).toBeHidden();

    // A run can be stopped from the page, which holds the issue again.
    await page.getByTestId("workflow-stop").click();
    await expect(held).toContainText("Stopped by you", { timeout: 20_000 });
    expect(await issueStatus(page, harness, key)).toBe("Implementation Ready");

    // Put by hand straight where the agent works, nothing picks it up: the page says so and offers to queue it.
    await page.request.put(`${harness.cockpitUrl}/api/issues/${key}`, { data: { status: "Implementation" } });
    await page.reload();
    await expect(page.getByTestId("workflow-idle")).toContainText("Nothing is working on this");
    await expect(page.getByTestId("workflow-queue")).toBeVisible();
    await expect(page.getByTestId("workflow-running")).toHaveCount(0);
    await shot(page, "desktop-7-idle");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("an issue is started and followed to the status that is the person's, and moved on with one tap", async ({ page, harness }) => {
    test.setTimeout(180_000);
    // Dark, as it is most often used on a phone.
    await page.addInitScript(() => localStorage.setItem("cockpit-theme", "dark"));
    const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-phone-"));

    try {
      const { projectId, key } = await factory(page, harness, repo);
      harness.mock.setScript([
        TITLE,
        ...runTurns(
          "Refining",
          key,
          [
            { name: SET_PLAN, input: { key, content: PLAN } },
            { name: UPDATE, input: { key, status: "Plan Review" } },
          ],
          "Planned.",
          5000,
        ),
        ...runTurns("Implementation", key, [{ name: UPDATE, input: { key, status: "Code Review" } }], "Built."),
        { events: textResponse("Nothing to do.") },
      ]);

      await followIssue(page, harness, key, "phone");

      // A status that is theirs offers its choices as buttons, plan or no plan.
      await page.getByTestId("workflow-move-Implementation Ready").tap();
      const yours = page.getByTestId("workflow-yours");
      await expect(yours).toContainText("Code Review is yours", { timeout: 60_000 });
      // On a phone one line under the bars says where it is.
      await expect(page.getByTestId("workflow-track-caption")).toContainText("Code Review");
      await expect(page.getByTestId("workflow-track-caption")).toContainText("4 of 4");
      await shot(page, "phone-4-review");
      await page.getByTestId("workflow-move-Done").tap();
      await expect.poll(() => issueStatus(page, harness, key)).toBe("Done");
      await expect(yours).toBeHidden();

      await page.goto(`${harness.cockpitUrl}/settings/workflows`);
      await expect(page.getByTestId("workflow-GR")).toContainText("Refining");
      await shot(page, "phone-5-list");
      await page.getByTestId("workflow-GR").tap();
      await expect(page.getByTestId("workflow-title")).toHaveText("Greeter's workflow");
      await expect(page.getByTestId("status-row-Refining")).toContainText("Runs plan-issue");
      await expect(page.getByTestId("status-row-Plan Review")).toContainText("Waits for you");
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, "phone-6-path");
      const noSideways = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await noSideways()).toBeLessThanOrEqual(1);
      expect(projectId).toBeTruthy();

      // A status an agent works in.
      await page.getByTestId("status-row-Refining").tap();
      await expect(page.getByTestId("rule-skill")).toHaveValue("plan-issue");
      await expect(page.getByTestId("rule-next-0-status")).toHaveValue("Plan Review");
      await shot(page, "phone-7-agent");
      await page.getByTestId("status-done").tap();
      // A status of the person's, where the plan is reviewed: two plain answers.
      await page.getByTestId("status-row-Plan Review").tap();
      await expect(page.getByTestId("rule-approve-status")).toHaveValue("Implementation Ready");
      await expect(page.getByTestId("rule-sendback-status")).toHaveValue("Refine Ready");
      await shot(page, "phone-8-yours");
      await page.getByTestId("status-done").tap();
      expect(await noSideways()).toBeLessThanOrEqual(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("on a phone the running agent's text gets the row, with the buttons under it", async ({ page, harness }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 393, height: 760 });
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-workflow-running-phone-"));
  try {
    const { key } = await factory(page, harness, repo);

    // The running row without starting an agent: the card reads this endpoint.
    await page.route(`**/api/issues/${key}/workflow`, (route) =>
      route.fulfill({
        json: {
          workflow: { enabled: true, statuses: RULES },
          order: ["Refine Ready", "Refining", "Plan Review", "Implementation Ready", "Implementation", "Code Review"],
          active: true,
          liveRunId: "run-1",
          attention: null,
          idle: false,
          missingSkills: [],
          runs: [
            {
              id: "run-1",
              skill: "implement-issue",
              status: "running",
              startedAt: Date.now() - 6000,
              completedAt: null,
              sessionId: "session-1",
              cwd: repo,
              model: "mock:claude-sonnet-4-6",
              toolCount: 0,
            },
          ],
        },
      }),
    );

    await page.goto(`${harness.cockpitUrl}/issues/${key}`);
    await expect(page.getByTestId("workflow-running")).toBeVisible({ timeout: 20_000 });

    const text = await page.getByTestId("workflow-running-text").boundingBox();
    const peek = await page.getByTestId("workflow-peek").boundingBox();
    if (!text || !peek) throw new Error("the running row is not measurable");
    // Sharing the row with the two buttons left the text one word wide.
    expect(text.width).toBeGreaterThan(240);
    // The actions are under it, not beside it.
    expect(peek.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
