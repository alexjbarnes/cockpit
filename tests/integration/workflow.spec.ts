// Workflows, end to end: an issue moved to a queue is picked up by a real CLI
// session that is told which issue it has and which of the repo's skills to
// run, the session ends its work by moving the issue, and a person is who it
// waits for next.
//
// Unit tests cover the engine's rules against a stand-in session manager.
// What only a real run can show is that the whole chain is live: the engine
// starts when the server does, a status change reaches it, the session it
// spawns can reach the cockpit tools as a workflow's run, the move it is
// allowed lands, the move it is not allowed is refused in words it can read,
// several agents really do work at the same time, and a session of the user's
// can set a project's workflow up through the same tools.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const SET_WORKFLOW = "mcp__cockpit-config__update_workflow";

interface StoredIssue {
  key: string;
  status: string;
  description: string;
  attention?: { reason: string; workStatus: string };
  activity: { kind: string; field?: string; to?: string; actor: { kind: string; skill?: string; sessionId?: string } }[];
}

interface StoredRun {
  id: string;
  status: string;
  workStatus: string;
  skill: string;
  sessionId: string;
  startedAt: number;
  completedAt?: number;
  from: string;
  to?: string;
  error?: string;
}

const PLAN_RULE = { kind: "agent", skill: "plan-issue", maxRetries: 0, next: ["Plan Review", "Needs Detail"] };

/** Issues queue in Refine Ready, are planned in Refining, and then wait for a person. */
const RULES = {
  "Refine Ready": { kind: "queue", to: "Refining" },
  Refining: PLAN_RULE,
  "Plan Review": {
    kind: "human",
    review: "plan",
    next: [
      { status: "Implementation Ready", label: "Approve", role: "approve" },
      { status: "Refine Ready", label: "Send back", role: "sendBack" },
    ],
  },
};

/**
 * A repo with the skill committed in it, a project that works there and, unless
 * told otherwise, that project's workflow. Workflows start paused, so a test
 * can line its issues up before any run begins.
 */
async function factory(page: Page, harness: Harness, repo: string, settings: Record<string, unknown> = {}, rules: unknown = RULES) {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  // The skill an agent runs comes from the repo, and an issue's own worktree
  // is cut from a commit, so it is committed, not just written.
  mkdirSync(path.join(repo, ".claude", "skills", "plan-issue"), { recursive: true });
  writeFileSync(
    path.join(repo, ".claude", "skills", "plan-issue", "SKILL.md"),
    "---\nname: plan-issue\ndescription: Write the plan for an issue.\n---\n\nWrite the plan for the issue you are given.\n",
  );
  writeFileSync(path.join(repo, "README.md"), "# greeter\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=it@example.com", "-c", "user.name=it", "commit", "-q", "-m", "init"], { cwd: repo });
  harness.trustWorkDir(repo);
  const api = harness.cockpitUrl;
  await page.request.patch(`${api}/api/defaults`, {
    data: { issuesEnabled: true, workflowsEnabled: true, workflowsPaused: true, workflowMaxParallel: 3, ...settings },
  });
  const projectRes = await page.request.post(`${api}/api/projects`, { data: { name: "Greeter", prefix: "GR", repoPath: repo } });
  const { project } = await projectRes.json();
  if (rules) {
    const saved = await page.request.put(`${api}/api/projects/${project.id}/workflow`, { data: { maxParallel: 5, statuses: rules } });
    expect(saved.ok(), await saved.text()).toBe(true);
  }
  return { project } as { project: { id: string } };
}

/** Change one status of the project's workflow, leaving the rest. */
async function setRule(page: Page, harness: Harness, projectId: string, status: string, rule: unknown): Promise<void> {
  const res = await page.request.put(`${harness.cockpitUrl}/api/projects/${projectId}/workflow`, {
    data: { statuses: { [status]: rule } },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

async function addIssue(page: Page, harness: Harness, projectId: string, title: string, status = "Refine Ready"): Promise<string> {
  const created = await page.request.post(`${harness.cockpitUrl}/api/issues`, {
    data: { projectId, title, description: "We need a greeting file." },
  });
  const { issue } = await created.json();
  const moved = await page.request.put(`${harness.cockpitUrl}/api/issues/${issue.key}`, { data: { status } });
  expect(moved.ok()).toBe(true);
  return issue.key as string;
}

async function readIssue(page: Page, harness: Harness, key: string): Promise<StoredIssue> {
  return (await (await page.request.get(`${harness.cockpitUrl}/api/issues/${key}`)).json()).issue as StoredIssue;
}

async function readRuns(page: Page, harness: Harness, key: string): Promise<StoredRun[]> {
  return (await (await page.request.get(`${harness.cockpitUrl}/api/issues/${key}/workflow`)).json()).runs as StoredRun[];
}

async function unpause(page: Page, harness: Harness): Promise<void> {
  await page.request.patch(`${harness.cockpitUrl}/api/defaults`, { data: { workflowsPaused: false } });
}

/** The id the mock gives a tool call, which is in every later request of that
 *  conversation: it is how a script tells "the turn after this call" apart. */
function callId(events: ReturnType<typeof toolUseResponse>): string {
  for (const e of events) {
    const id = (e.data as { content_block?: { type?: string; id?: string } }).content_block;
    if (id?.type === "tool_use" && id.id) return id.id;
  }
  throw new Error("no tool call in these events");
}

/** A conversation for one issue: the tool calls in order, then a last word.
 *  Matched on the issue's own prompt, so several can be in flight at once. */
function conversation(
  key: string,
  calls: { name: string; input: Record<string, unknown> }[],
  last: string,
  delayMs = 0,
  opening = `workflow on issue ${key},`,
): TurnScript[] {
  const turns = calls.map((c) => toolUseResponse(c.name, c.input));
  const script: TurnScript[] = [];
  // Latest first: a request holds every earlier call's id, and the first match wins.
  for (let i = turns.length - 1; i >= 0; i--) {
    script.push({ match: callId(turns[i]), events: i === turns.length - 1 ? textResponse(last) : turns[i + 1] });
  }
  script.push({ match: opening, events: turns[0] ?? textResponse(last), ...(delayMs ? { delayMs } : {}) });
  return script;
}

const TITLE: TurnScript = { match: '"json_schema"', events: textResponse('{"title":"Run"}') };

function bodies(harness: Harness): string[] {
  return harness.mock
    .getRequests()
    .filter((r) => r.url.split("?")[0] === "/v1/messages")
    .map((r) => r.body);
}

test("an issue moved to a queue is planned by a session running the repo's skill, handed to a person and approved", async ({
  page,
  harness,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-run-"));

  try {
    const { project } = await factory(page, harness, repo);
    const key = await addIssue(page, harness, project.id, "Add a greeting", "Backlog");
    harness.mock.setScript([
      TITLE,
      ...conversation(
        key,
        [
          // The move the workflow does not list is refused, in words.
          { name: UPDATE, input: { key, status: "Done" } },
          { name: SET_PLAN, input: { key, content: PLAN } },
          { name: UPDATE, input: { key, status: "Plan Review" } },
        ],
        "Planned.",
      ),
      { events: textResponse("Nothing to do.") },
    ]);
    await unpause(page, harness);

    // Nothing happens until a person moves it into the queue.
    await page.waitForTimeout(1500);
    expect(await readRuns(page, harness, key)).toHaveLength(0);
    await page.request.put(`${harness.cockpitUrl}/api/issues/${key}`, { data: { status: "Refine Ready" } });
    // The move is made through a route, as the issue page makes it, and the
    // engine hears it at once: it does not wait for its next sweep, a minute off.
    await expect.poll(async () => (await readRuns(page, harness, key)).length, { timeout: 10_000 }).toBe(1);

    await expect.poll(async () => (await readIssue(page, harness, key)).status, { timeout: 90_000 }).toBe("Plan Review");
    await expect.poll(async () => (await readRuns(page, harness, key))[0]?.status, { timeout: 30_000 }).toBe("success");

    const [run] = await readRuns(page, harness, key);
    expect(run).toMatchObject({ workStatus: "Refining", skill: "plan-issue", from: "Refine Ready", to: "Plan Review" });
    const issue = await readIssue(page, harness, key);
    expect(issue.description).toBe("We need a greeting file.");
    const moves = issue.activity.filter((a) => a.field === "status").map((a) => [a.to, a.actor.kind, a.actor.skill]);
    expect(moves).toEqual([
      ["Refine Ready", "user", undefined],
      // Taken out of the queue by the engine in the run's name, then moved on by the run's own session.
      ["Refining", "workflow", "plan-issue"],
      ["Plan Review", "workflow", "plan-issue"],
    ]);
    expect(issue.activity.find((a) => a.kind === "plan_written")?.actor).toMatchObject({ kind: "workflow", sessionId: run.sessionId });

    // The session was told which issue it had, which skill to run and how its work ends.
    const sent = bodies(harness).join("\n");
    expect(sent).toContain(`status of a workflow on issue ${key}, in Cockpit`);
    expect(sent).toContain(`skill on ${key}, with the Skill tool`);
    expect(sent).toContain(".claude/skills/plan-issue/SKILL.md");
    // It tried a status it may not use, and was told which it can.
    expect(sent).toContain("cannot move it to");
    expect(sent).toContain("It can move it to:");

    // A person is who it waits for next: the inbox says so, and the run's session
    // is not in the session list.
    const inbox = await (await page.request.get(`${harness.cockpitUrl}/api/inbox`)).json();
    const titles = ((inbox.messages ?? inbox) as { title: string }[]).map((m) => m.title);
    expect(titles).toContain(`${key} is waiting for you: Plan Review`);
    const listed = await (await page.request.get(`${harness.cockpitUrl}/api/sessions`)).text();
    expect(listed).not.toContain(run.sessionId);

    // They approve the plan on the issue, and it goes where the workflow says.
    await page.goto(`${harness.cockpitUrl}/issues/${key}`);
    await page.getByTestId("issue-plan-open").click();
    await expect(page.getByTestId("plan-document")).toContainText("Create hello.txt");
    await page.getByTestId("plan-approve").click();
    await page.getByTestId("plan-approve-approve").click();
    await expect(page.getByTestId("issue-plan-state")).toHaveText("Approved", { timeout: 15_000 });
    expect((await readIssue(page, harness, key)).status).toBe("Implementation Ready");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("three issues with room for two: two run together and the third starts when one ends", async ({ page, harness }) => {
  test.setTimeout(240_000);
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-par-"));

  try {
    const { project } = await factory(page, harness, repo, { workflowMaxParallel: 2 });
    const keys = [
      await addIssue(page, harness, project.id, "First"),
      await addIssue(page, harness, project.id, "Second"),
      await addIssue(page, harness, project.id, "Third"),
    ];
    harness.mock.setScript([
      TITLE,
      // Each first turn is held, so the runs are in flight together for long enough to see.
      ...keys.flatMap((key) => conversation(key, [{ name: UPDATE, input: { key, status: "Plan Review" } }], `Planned ${key}.`, 8000)),
      { events: textResponse("Nothing to do.") },
    ]);
    await unpause(page, harness);

    const activity = async () => (await page.request.get(`${harness.cockpitUrl}/api/workflows/activity`)).json();
    await expect
      .poll(async () => {
        const a = await activity();
        return [a.slots.used, a.running.length, a.queued.length];
      })
      .toEqual([2, 2, 1]);
    const first = await activity();
    // Oldest first when nothing ranks them, and the one left waiting is the newest.
    expect(first.running.map((r: { issueKey: string }) => r.issueKey).sort()).toEqual([keys[0], keys[1]]);
    expect(first.queued[0]).toMatchObject({ issueKey: keys[2], status: "Refine Ready", skill: "plan-issue" });

    for (const key of keys) {
      await expect.poll(async () => (await readIssue(page, harness, key)).status, { timeout: 120_000 }).toBe("Plan Review");
    }
    await expect
      .poll(async () => {
        const a = await activity();
        return [a.slots.used, a.queued.length];
      })
      .toEqual([0, 0]);

    const runs = (await Promise.all(keys.map((key) => readRuns(page, harness, key)))).map((r) => r[0]);
    for (const run of runs) expect(run.status, run.error).toBe("success");
    const [a, b, c] = runs;
    // The first two overlapped; the third began only once a slot was free.
    expect(Math.max(a.startedAt, b.startedAt)).toBeLessThan(Math.min(a.completedAt as number, b.completedAt as number));
    expect(c.startedAt).toBeGreaterThanOrEqual(Math.min(a.completedAt as number, b.completedAt as number));

    // Each session was given its own issue and no other.
    for (const key of keys) {
      const own = bodies(harness).filter((body) => body.includes(`workflow on issue ${key},`));
      expect(own.length).toBeGreaterThan(0);
      for (const other of keys.filter((k) => k !== key)) {
        expect(own.some((body) => body.includes(`workflow on issue ${other},`))).toBe(false);
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a session that stops without moving its issue is asked once, then the issue is held until retried", async ({ page, harness }) => {
  test.setTimeout(240_000);
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-fail-"));

  try {
    const { project } = await factory(page, harness, repo);
    const key = await addIssue(page, harness, project.id, "Stubborn");
    harness.mock.setScript([
      TITLE,
      { match: `stopped without moving ${key} on`, events: textResponse("There is nothing more I can do.") },
      { match: `workflow on issue ${key},`, events: textResponse("I had a look around.") },
      { events: textResponse("Nothing to do.") },
    ]);
    await unpause(page, harness);

    await expect
      .poll(async () => (await readIssue(page, harness, key)).attention?.reason, { timeout: 120_000 })
      .toContain("without moving");
    const held = await readIssue(page, harness, key);
    // Back where it says what it is waiting for, and out of the queue.
    expect(held.status).toBe("Refine Ready");
    expect((await readRuns(page, harness, key)).map((r) => r.status)).toEqual(["failure"]);
    // It was told what it had left undone before the run was given up on.
    expect(bodies(harness).some((body) => body.includes(`stopped without moving ${key} on`))).toBe(true);
    const activity = await (await page.request.get(`${harness.cockpitUrl}/api/workflows/activity`)).json();
    expect(activity.attention).toMatchObject([{ issueKey: key, status: "Refine Ready", skill: "plan-issue" }]);
    expect(activity.queued).toEqual([]);
    const inbox = await (await page.request.get(`${harness.cockpitUrl}/api/inbox`)).json();
    expect(((inbox.messages ?? inbox) as { title: string }[]).map((m) => m.title)).toContain(`${key} needs you: Refining`);

    // Held means held: nothing starts on its own.
    await page.waitForTimeout(2000);
    expect(await readRuns(page, harness, key)).toHaveLength(1);

    const retried = await page.request.post(`${harness.cockpitUrl}/api/issues/${key}/run`, { data: { action: "retry" } });
    expect(retried.ok()).toBe(true);
    await expect.poll(async () => (await readRuns(page, harness, key)).length, { timeout: 60_000 }).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("two issues are worked in their own worktrees, each with its own port, and a finished issue's worktree is removed", async ({
  page,
  harness,
}) => {
  test.setTimeout(240_000);
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-tree-"));

  try {
    const { project } = await factory(page, harness, repo);
    await setRule(page, harness, project.id, "Refining", { ...PLAN_RULE, workspace: "worktree" });

    const keys = [await addIssue(page, harness, project.id, "First"), await addIssue(page, harness, project.id, "Second")];
    const tree = (key: string) => path.join(harness.configDir, "worktrees", `${path.basename(repo)}-${key}`);
    for (const key of keys) harness.trustWorkDir(tree(key));
    harness.mock.setScript([
      TITLE,
      ...keys.flatMap((key) =>
        conversation(
          key,
          [
            // The run's own shell is where the port has to be, and where the work lands.
            {
              name: "Bash",
              input: { command: `echo "$COCKPIT_RUN_PORT $COCKPIT_ISSUE_KEY $(git rev-parse --abbrev-ref HEAD)" > made-by-${key}.txt` },
            },
            { name: UPDATE, input: { key, status: "Plan Review" } },
          ],
          `Planned ${key}.`,
          4000,
        ),
      ),
      { events: textResponse("Nothing to do.") },
    ]);
    await unpause(page, harness);

    for (const key of keys) {
      await expect.poll(async () => (await readIssue(page, harness, key)).status, { timeout: 120_000 }).toBe("Plan Review");
    }
    const made = keys.map((key) =>
      readFileSync(path.join(tree(key), `made-by-${key}.txt`), "utf-8")
        .trim()
        .split(" "),
    );
    made.forEach(([port, issueKey, branch], i) => {
      expect(Number(port)).toBeGreaterThanOrEqual(42_000);
      expect(issueKey).toBe(keys[i]);
      expect(branch).toBe(`issue/${keys[i]}`);
    });
    expect(made[0][0]).not.toBe(made[1][0]);
    // Each worked in its own checkout: neither's file is in the other's, nor in the project folder.
    expect(existsSync(path.join(tree(keys[0]), `made-by-${keys[1]}.txt`))).toBe(false);
    expect(existsSync(path.join(repo, `made-by-${keys[0]}.txt`))).toBe(false);
    // The session was told where it was and what was kept for it.
    const sent = bodies(harness).join("\n");
    expect(sent).toContain(`own git worktree, on the branch issue/${keys[0]}`);
    expect(sent).toContain(`Port ${made[0][0]} is kept for this run`);

    // Finishing an issue takes its worktree away, and leaves the other's.
    await page.request.put(`${harness.cockpitUrl}/api/issues/${keys[0]}`, { data: { status: "Done" } });
    await expect.poll(() => existsSync(tree(keys[0])), { timeout: 30_000 }).toBe(false);
    expect(existsSync(tree(keys[1]))).toBe(true);
    expect(execFileSync("git", ["branch", "--list", `issue/${keys[0]}`], { cwd: repo, encoding: "utf-8" })).toContain(`issue/${keys[0]}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a plan sent back is revised in the session that wrote it", async ({ page, harness }) => {
  test.setTimeout(240_000);
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-again-"));

  try {
    const { project } = await factory(page, harness, repo);
    await setRule(page, harness, project.id, "Refining", { ...PLAN_RULE, continueSession: true });
    const key = await addIssue(page, harness, project.id, "Add a greeting");
    const revised = `${PLAN}3. Add a test for it\n`;
    harness.mock.setScript([
      TITLE,
      // The second time round is told apart by how it is opened. Listed first:
      // that conversation holds the whole of the first one too.
      ...conversation(
        key,
        [
          { name: SET_PLAN, input: { key, content: revised } },
          { name: UPDATE, input: { key, status: "Plan Review" } },
        ],
        "Revised.",
        0,
        `${key} has come back to`,
      ),
      ...conversation(
        key,
        [
          { name: SET_PLAN, input: { key, content: PLAN } },
          { name: UPDATE, input: { key, status: "Plan Review" } },
        ],
        "Planned.",
      ),
      { events: textResponse("Nothing to do.") },
    ]);
    await unpause(page, harness);
    await expect.poll(async () => (await readIssue(page, harness, key)).status, { timeout: 90_000 }).toBe("Plan Review");
    await expect.poll(async () => (await readRuns(page, harness, key))[0]?.status, { timeout: 30_000 }).toBe("success");

    // The reviewer sends it back with a note.
    const review = await page.request.post(`${harness.cockpitUrl}/api/issues/${key}/plan/review`, {
      data: {
        version: 1,
        action: "request_changes",
        annotations: [{ id: "n1", kind: "note", quote: "", prefix: "", suffix: "", body: "SEND-BACK-MARKER: add a test.", createdAt: 1 }],
      },
    });
    expect(review.ok()).toBe(true);

    await expect.poll(async () => (await readRuns(page, harness, key)).length, { timeout: 60_000 }).toBe(2);
    await expect.poll(async () => (await readRuns(page, harness, key))[1]?.status, { timeout: 90_000 }).toBe("success");
    const [first, second] = await readRuns(page, harness, key);
    expect(second.sessionId).toBe(first.sessionId);
    expect((await readIssue(page, harness, key)).status).toBe("Plan Review");

    const plan = await (await page.request.get(`${harness.cockpitUrl}/api/issues/${key}/plan`)).json();
    expect(plan.versions.map((v: { n: number }) => v.n)).toEqual([1, 2]);
    expect(plan.versions[1].content).toContain("Add a test for it");

    // The model was told it had been here before, in a conversation that
    // still held what it did the first time.
    const again = bodies(harness).find((body) => body.includes(`${key} has come back to`));
    expect(again, "the second run was opened as a continuation").toBeTruthy();
    expect(again).toContain("status of a workflow on issue");
    expect(again).toContain("carrying on in the session that worked on it before");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a session sets a project's workflow up through the cockpit tools, and an issue then runs through it", async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const repo = mkdtempSync(path.join(tmpdir(), "cockpit-it-wf-mcp-"));

  try {
    // A project with its skill in the repo and no workflow at all.
    const { project } = await factory(page, harness, repo, { workflowsPaused: false }, null);
    const before = await (await page.request.get(`${harness.cockpitUrl}/api/projects/${project.id}/workflow`)).json();
    expect(before.workflow).toBeNull();
    expect(before.skills.map((s: { name: string }) => s.name)).toEqual(["plan-issue"]);

    const key = await addIssue(page, harness, project.id, "Add a greeting", "Backlog");
    const setUp = toolUseResponse(SET_WORKFLOW, { project: "GR", maxParallel: 2, statuses: RULES });
    const ASK = "Set up the workflow for the Greeter project";
    harness.mock.setScript([
      TITLE,
      // The user's session: one tool call, then a word.
      { match: callId(setUp), events: textResponse("The workflow is set up.") },
      { match: ASK, events: setUp },
      // The run the workflow then starts.
      ...conversation(
        key,
        [
          { name: SET_PLAN, input: { key, content: PLAN } },
          { name: UPDATE, input: { key, status: "Plan Review" } },
        ],
        "Planned.",
      ),
      { events: textResponse("Nothing to do.") },
    ]);

    const created = await page.request.post(`${harness.cockpitUrl}/api/sessions`, {
      data: { cwd: repo, runtime: "pty", name: "Set up", bypassPermissions: true },
    });
    expect(created.ok()).toBe(true);
    const { sessionId } = await created.json();
    await page.goto(`${harness.cockpitUrl}/sessions/${sessionId}?cwd=${encodeURIComponent(repo)}`);
    await expect(page.getByTestId("message-input")).toBeVisible();
    // The PTY needs a moment before it takes input (see hello.spec.ts).
    await page.waitForTimeout(5000);
    await page.getByTestId("message-input").fill(`${ASK}.`);
    await page.getByTestId("btn-send").click();

    // The session's tool call made the workflow, as the session.
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${harness.cockpitUrl}/api/projects/${project.id}/workflow`)).json()).workflow?.maxParallel,
        {
          timeout: 60_000,
        },
      )
      .toBe(2);
    const after = await (await page.request.get(`${harness.cockpitUrl}/api/projects/${project.id}/workflow`)).json();
    expect(after.workflow.statuses.Refining).toMatchObject({ kind: "agent", skill: "plan-issue", next: ["Plan Review", "Needs Detail"] });
    expect(after.problems).toEqual([]);

    // And it works: an issue put in its queue is planned by an agent running the skill.
    await page.request.put(`${harness.cockpitUrl}/api/issues/${key}`, { data: { status: "Refine Ready" } });
    await expect.poll(async () => (await readIssue(page, harness, key)).status, { timeout: 120_000 }).toBe("Plan Review");
    await expect.poll(async () => (await readRuns(page, harness, key))[0]?.status, { timeout: 30_000 }).toBe("success");
    expect((await readRuns(page, harness, key))[0]).toMatchObject({ workStatus: "Refining", skill: "plan-issue", to: "Plan Review" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
