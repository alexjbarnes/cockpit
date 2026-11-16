// A project's workflow and its run records: what counts as a workflow, how it
// is fitted to the project's statuses, how the engine's units of work are read
// out of it, and how runs are kept.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDefaults } from "@/server/defaults";
import { applyProjectUpdate, buildProject, getProject, saveProject } from "@/server/issue-storage";
import {
  agentWork,
  assertProjectKeepsWorkflowStatuses,
  deleteWorkflow,
  deleteWorkflowRuns,
  getWorkflowSessionIds,
  loadUnfinishedRuns,
  loadWorkflowRuns,
  loadWorkflows,
  projectRunsWorkflow,
  resetWorkRuns,
  ruleAt,
  runsOf,
  saveWorkflowRun,
  setProjectWorkflow,
  shapeWorkflow,
  WORKFLOW_MAX_RUNS_PER_ISSUE,
  waitingStatuses,
  workAt,
  workflowForProject,
  workflowStatuses,
  workRunCount,
} from "@/server/workflow-storage";
import type { Project, WorkflowRun } from "@/types";

let dir: string;
let prevConfigDir: string | undefined;
let project: Project;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-workflows-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
  project = buildProject({ name: "Cockpit", prefix: "CK" });
  saveProject(project);
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

const PLAN = { kind: "agent", skill: "plan-issue", next: ["Plan Review", "Needs Detail"] };
const GATE = {
  kind: "human",
  review: "plan",
  next: [
    { status: "Implementation Ready", label: "Approve", role: "approve" },
    { status: "Refine Ready", label: "Send back", role: "sendBack" },
  ],
};
const RULES = { "Refine Ready": { kind: "queue", to: "Refining" }, Refining: PLAN, "Plan Review": GATE };

const shape = (statuses: unknown, over: Record<string, unknown> = {}) => shapeWorkflow(project, { statuses, ...over }).workflow;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "r1",
    workStatus: "Refining",
    skill: "plan-issue",
    issueKey: "CK-1",
    projectId: "p1",
    sessionId: "sess-1",
    status: "success",
    startedAt: 100,
    from: "Refine Ready",
    toolsUsed: [],
    messageCount: 0,
    cwd: "/repo",
    ...over,
  };
}

describe("what counts as a workflow", () => {
  it("keeps each rule to what its kind uses, with the defaults filled in", () => {
    const w = shape({
      "Refine Ready": { kind: "queue", to: "Refining", skill: "ignored" },
      Refining: {
        ...PLAN,
        model: " opus ",
        contextSize: "1m",
        thinkingLevel: "high",
        runtime: "pty",
        allowedTools: ["Read", " "],
        mcpServers: ["graphene"],
        mcpToolFilters: { graphene: ["read"] },
        sandbox: true,
        maxDurationMinutes: 30,
        maxRetries: 2,
        maxParallel: 3,
        workspace: "worktree",
        continueSession: true,
        notifyProviders: ["phone"],
        review: "plan",
      },
      "Plan Review": { ...GATE, skill: "nope", notifyProviders: ["phone"] },
      "Code Review": { kind: "human", next: ["Accepted", { status: "Implementation Ready", label: "Send back", role: "sendBack" }] },
    });
    expect(w).toMatchObject({ projectId: project.id, enabled: true, maxParallel: 2 });
    expect(w.statuses["Refine Ready"]).toEqual({ kind: "queue", to: "Refining" });
    expect(w.statuses.Refining).toEqual({
      kind: "agent",
      skill: "plan-issue",
      next: ["Plan Review", "Needs Detail"],
      model: "opus",
      contextSize: "1m",
      thinkingLevel: "high",
      runtime: "pty",
      permission: "bypass",
      allowedTools: ["Read"],
      mcpServers: ["graphene"],
      mcpToolFilters: { graphene: ["read"] },
      sandbox: true,
      maxDurationMinutes: 30,
      maxRetries: 2,
      maxParallel: 3,
      workspace: "worktree",
      continueSession: true,
      notifyProviders: ["phone"],
    });
    expect(w.statuses["Plan Review"]).toEqual({ ...GATE, notifyProviders: ["phone"] });
    // A bare status is a button called that, and a role means nothing off a plan review.
    expect(w.statuses["Code Review"]).toEqual({
      kind: "human",
      next: [
        { status: "Accepted", label: "Accepted" },
        { status: "Implementation Ready", label: "Send back" },
      ],
    });
  });

  it("takes an agent's next as names or as objects with a status", () => {
    const w = shape({ Refining: { kind: "agent", skill: "plan-issue", next: [{ status: "Plan Review" }, "Needs Detail"] } });
    expect(ruleAt(w, "Refining")).toMatchObject({ next: ["Plan Review", "Needs Detail"] });
  });

  it("allows a person's status with nothing to choose, and an empty workflow", () => {
    expect(shape({ "Code Review": { kind: "human" } }).statuses["Code Review"]).toEqual({ kind: "human", next: [] });
    expect(shape({}).statuses).toEqual({});
    expect(shapeWorkflow(project, {}).workflow.statuses).toEqual({});
  });

  it.each([
    ["a rule that is not an object", { Refining: "agent" }, /rule is an object/],
    ["an unknown kind", { Refining: { kind: "robot" } }, /kind must be/],
    ["a queue with nowhere to go", { "Refine Ready": { kind: "queue" } }, /to \(the status an agent works it in\) is required/],
    [
      "a queue for a status no agent works in",
      { "Refine Ready": { kind: "queue", to: "Plan Review" }, "Plan Review": GATE },
      /no agent works in "Plan Review"/,
    ],
    ["a queue for a status with no rule", { "Refine Ready": { kind: "queue", to: "Refining" } }, /no agent works in "Refining"/],
    ["a queue for itself", { "Refine Ready": { kind: "queue", to: "Refine Ready" } }, /sends issues to itself/],
    ["an agent with no skill", { Refining: { kind: "agent", next: ["Done"] } }, /skill is required/],
    ["a skill that is not a folder name", { Refining: { ...PLAN, skill: "../etc" } }, /not a skill name/],
    ["an agent with nowhere to send the issue", { Refining: { ...PLAN, next: [] } }, /at least one status/],
    ["an agent whose next is not a list", { Refining: { ...PLAN, next: "Done" } }, /next must be a list/],
    ["an agent whose next holds something else", { Refining: { ...PLAN, next: [5] } }, /must be a status name/],
    ["an agent that moves the issue to its own status", { Refining: { ...PLAN, next: ["Refining"] } }, /cannot move an issue to itself/],
    ["an agent that lists a status twice", { Refining: { ...PLAN, next: ["Done", "Done"] } }, /lists the status "Done" twice/],
    [
      "an agent that sends the issue back to its own queue",
      { "Refine Ready": { kind: "queue", to: "Refining" }, Refining: { ...PLAN, next: ["Refine Ready"] } },
      /its own queue/,
    ],
    ["an agent at Done", { Done: { ...PLAN, next: ["Backlog"] } }, /comes to rest/],
    ["a queue at Cancelled", { Cancelled: { kind: "queue", to: "Refining" }, Refining: PLAN }, /comes to rest/],
    ["a bad permission", { Refining: { ...PLAN, permission: "yolo" } }, /permission must be one of/],
    ["a bad thinking level", { Refining: { ...PLAN, thinkingLevel: "galaxy" } }, /thinkingLevel must be one of/],
    ["a bad runtime", { Refining: { ...PLAN, runtime: "telnet" } }, /runtime must be/],
    ["a bad workspace", { Refining: { ...PLAN, workspace: "moon" } }, /workspace must be/],
    ["a model that is not text", { Refining: { ...PLAN, model: 5 } }, /model must be text/],
    ["tools that are not a list of names", { Refining: { ...PLAN, allowedTools: "Read" } }, /allowedTools must be a list of names/],
    ["tool filters that are not a map", { Refining: { ...PLAN, mcpToolFilters: ["x"] } }, /must map a server to its tools/],
    ["tool filters with a bad list", { Refining: { ...PLAN, mcpToolFilters: { graphene: "read" } } }, /must be a list of tool names/],
    ["too many minutes", { Refining: { ...PLAN, maxDurationMinutes: 99999 } }, /maxDurationMinutes must be a whole number/],
    ["too many retries", { Refining: { ...PLAN, maxRetries: 9 } }, /maxRetries must be a whole number/],
    ["a fraction of a run", { Refining: { ...PLAN, maxParallel: 1.5 } }, /maxParallel must be a whole number/],
    ["a review of something else", { "Plan Review": { kind: "human", review: "code" } }, /review must be "plan"/],
    ["a person's next that is not a list", { "Plan Review": { kind: "human", next: "Done" } }, /next must be a list/],
    ["a choice that is neither", { "Plan Review": { kind: "human", next: [5] } }, /must be a status and a label/],
    ["a choice with a bad role", { "Plan Review": { kind: "human", next: [{ status: "Done", role: "maybe" }] } }, /role must be/],
    ["a choice of its own status", { "Plan Review": { kind: "human", next: ["Plan Review"] } }, /cannot move an issue to itself/],
    ["a plan review without its two answers", { "Plan Review": { kind: "human", review: "plan", next: ["Done"] } }, /exactly two choices/],
    [
      "two plan reviews",
      { "Plan Review": GATE, "Code Review": { ...GATE, next: [GATE.next[0], { ...GATE.next[1], status: "Backlog" }] } },
      /one plan review/,
    ],
    ["a status with no name", { " ": PLAN }, /status name is required/],
    ["the same status in two spellings", { refining: PLAN, Refining: PLAN }, /given twice/],
  ])("refuses %s", (_name, statuses, message) => {
    expect(() => shape(statuses)).toThrow(message);
  });

  it("refuses statuses that are not an object, a bad switch and a bad limit", () => {
    expect(() => shape([])).toThrow(/keyed by status name/);
    expect(() => shape(null)).toThrow(/keyed by status name/);
    expect(() => shapeWorkflow(project, { enabled: "yes" as never })).toThrow(/enabled must be/);
    expect(() => shapeWorkflow(project, { maxParallel: 0 })).toThrow(/maxParallel must be a whole number from 1 to 50/);
  });
});

describe("changing a workflow", () => {
  it("merges the statuses named into the ones it has, and clears with null or kind none", () => {
    const first = setProjectWorkflow(project, { statuses: RULES, maxParallel: 4 }).workflow;
    const second = setProjectWorkflow(project, {
      statuses: { "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Code Review"] }, "Plan Review": null },
    }).workflow;
    expect(Object.keys(second.statuses).sort()).toEqual(["Implementation Ready", "Refine Ready", "Refining"]);
    expect(second).toMatchObject({ maxParallel: 4, createdAt: first.createdAt });
    const third = setProjectWorkflow(project, { statuses: { "Implementation Ready": { kind: "none" } }, enabled: false }).workflow;
    expect(Object.keys(third.statuses).sort()).toEqual(["Refine Ready", "Refining"]);
    expect(third.enabled).toBe(false);
    // Clearing what the project never had is nothing to do, and adds nothing.
    expect(setProjectWorkflow(project, { statuses: { "No Such Status": null } }).added).toEqual([]);
    expect(getProject(project.id)?.customStatuses).toBeUndefined();
  });

  it("checks the result as a whole, so a queue cannot be left pointing at nothing", () => {
    setProjectWorkflow(project, { statuses: RULES });
    expect(() => setProjectWorkflow(project, { statuses: { Refining: null } })).toThrow(/no agent works in "Refining"/);
    expect(workflowForProject(project)?.statuses.Refining).toBeDefined();
  });

  it("replaces the whole workflow when asked to", () => {
    setProjectWorkflow(project, { statuses: RULES });
    const replaced = setProjectWorkflow(project, { replace: true, statuses: { "Code Review": { kind: "human" } } }).workflow;
    expect(Object.keys(replaced.statuses)).toEqual(["Code Review"]);
    // Without statuses there is nothing to replace with, so it is left as it is.
    expect(Object.keys(setProjectWorkflow(project, { replace: true, enabled: false }).workflow.statuses)).toEqual(["Code Review"]);
  });

  it("keeps one workflow per project, and removes it", () => {
    const other = buildProject({ name: "Other", prefix: "OT" });
    saveProject(other);
    setProjectWorkflow(project, { statuses: RULES });
    setProjectWorkflow(project, { enabled: false });
    setProjectWorkflow(other, { statuses: {} });
    expect(
      loadWorkflows()
        .map((w) => w.projectId)
        .sort(),
    ).toEqual([other.id, project.id].sort());
    expect(workflowForProject(undefined)).toBeUndefined();
    expect(deleteWorkflow(project.id)).toBe(true);
    expect(deleteWorkflow(project.id)).toBe(false);
    expect(workflowForProject(project)).toBeUndefined();
    expect(workflowForProject(other)).toBeDefined();
  });
});

describe("fitting the project's statuses", () => {
  it("uses the project's own spelling of a status, whatever case it was given in", () => {
    const w = shape({ "refine ready": { kind: "queue", to: "REFINING" }, refining: { ...PLAN, next: ["plan review"] } });
    expect(Object.keys(w.statuses)).toEqual(["Refine Ready", "Refining"]);
    expect(w.statuses["Refine Ready"]).toEqual({ kind: "queue", to: "Refining" });
    expect(w.statuses.Refining).toMatchObject({ next: ["Plan Review"] });
  });

  it("adds a status the project lacks to its board, once, and says so", () => {
    const saved = setProjectWorkflow(project, {
      statuses: {
        "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Validation"] },
        validation: { kind: "agent", skill: "validate-issue", next: ["Code Review", "Triage"] },
      },
    });
    expect(saved.added).toEqual(["Validation", "Triage"]);
    expect(Object.keys(saved.workflow.statuses)).toEqual(["Implementation Ready", "Validation"]);
    expect(getProject(project.id)?.customStatuses).toEqual([{ name: "Validation" }, { name: "Triage" }]);
    // Saving again finds them there.
    const again = setProjectWorkflow(getProject(project.id) as Project, { enabled: true });
    expect(again.added).toEqual([]);
    expect(getProject(project.id)?.customStatuses).toHaveLength(2);
  });

  it("shows again a built-in status the project had hidden", () => {
    saveProject(applyProjectUpdate(project, { disabledStatuses: ["Refining", "Accepted"] }));
    const saved = setProjectWorkflow(getProject(project.id) as Project, { statuses: RULES });
    expect(saved.shown).toEqual(["Refining"]);
    expect(getProject(project.id)?.disabledStatuses).toEqual(["Accepted"]);
  });

  it("refuses a change to the project that takes away a status its workflow names", () => {
    const withCustom = setProjectWorkflow(project, { statuses: { Triage: { kind: "human", next: ["Backlog"] } } });
    expect(withCustom.added).toEqual(["Triage"]);
    const now = getProject(project.id) as Project;
    expect(() => assertProjectKeepsWorkflowStatuses(now)).not.toThrow();
    expect(() => assertProjectKeepsWorkflowStatuses(applyProjectUpdate(now, { customStatuses: [] }))).toThrow(
      /Cockpit's workflow uses the status "Triage"/,
    );
    expect(() => assertProjectKeepsWorkflowStatuses(applyProjectUpdate(now, { disabledStatuses: ["Backlog"] }))).toThrow(/"Backlog"/);
    // A project with no workflow keeps nothing.
    const bare = buildProject({ name: "Bare", prefix: "B" });
    saveProject(bare);
    expect(() => assertProjectKeepsWorkflowStatuses(applyProjectUpdate(bare, { disabledStatuses: ["Backlog"] }))).not.toThrow();
  });
});

describe("reading the work out of a workflow", () => {
  it("gives each agent's status with the queues that feed it", () => {
    const w = shape({
      ...RULES,
      Urgent: { kind: "queue", to: "Refining" },
      "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Code Review"] },
    });
    const work = agentWork(w);
    expect(work.map((x) => [x.workStatus, x.queues, x.rule.skill])).toEqual([
      ["Refining", ["Refine Ready", "Urgent"], "plan-issue"],
      ["Implementation Ready", [], "implement-issue"],
    ]);
    // Where its issues wait: its queues, or itself when nothing feeds it.
    expect(waitingStatuses(work[0])).toEqual(["Refine Ready", "Urgent"]);
    expect(waitingStatuses(work[1])).toEqual(["Implementation Ready"]);
    expect(workAt(w, "Refine Ready")?.workStatus).toBe("Refining");
    expect(workAt(w, "Urgent")?.workStatus).toBe("Refining");
    expect(workAt(w, "Refining")?.workStatus).toBe("Refining");
    expect(workAt(w, "Plan Review")).toBeUndefined();
    expect(workAt(w, "Backlog")).toBeUndefined();
    expect(ruleAt(w, "Plan Review")?.kind).toBe("human");
    expect(ruleAt(w, "Backlog")).toBeUndefined();
    // A status is looked up by its own name only.
    expect(ruleAt(w, "toString")).toBeUndefined();
    expect(workflowStatuses(w).sort()).toEqual(
      ["Code Review", "Implementation Ready", "Needs Detail", "Plan Review", "Refine Ready", "Refining", "Urgent"].sort(),
    );
  });

  it("says a project's issues are the engine's only when everything is on", () => {
    setProjectWorkflow(project, { statuses: RULES });
    const bare = buildProject({ name: "Bare", prefix: "B" });
    saveProject(bare);

    setDefaults({ issuesEnabled: true, workflowsEnabled: false });
    expect(projectRunsWorkflow(project.id)).toBe(false);
    setDefaults({ workflowsEnabled: true });
    expect(projectRunsWorkflow(project.id)).toBe(true);
    expect(projectRunsWorkflow(bare.id)).toBe(false);
    expect(projectRunsWorkflow("nope")).toBe(false);
    setProjectWorkflow(project, { enabled: false });
    expect(projectRunsWorkflow(project.id)).toBe(false);
    setProjectWorkflow(project, { enabled: true });
    setDefaults({ issuesEnabled: false });
    expect(projectRunsWorkflow(project.id)).toBe(false);
  });
});

describe("what an earlier build left behind", () => {
  it("ignores shared workflows made of stages, and a file that is not one", () => {
    writeFileSync(
      path.join(dir, "workflows.json"),
      JSON.stringify({
        workflows: [{ id: "w1", name: "Factory", enabled: true, maxParallel: 2, stages: [] }, null, { projectId: project.id }],
      }),
    );
    expect(loadWorkflows()).toEqual([]);
    expect(workflowForProject(project)).toBeUndefined();
    // The first save writes only what is a workflow now.
    setProjectWorkflow(project, { statuses: RULES });
    expect(loadWorkflows()).toHaveLength(1);
    writeFileSync(path.join(dir, "workflows.json"), "{broken");
    expect(loadWorkflows()).toEqual([]);
    writeFileSync(path.join(dir, "workflows.json"), JSON.stringify({ workflows: "none" }));
    expect(loadWorkflows()).toEqual([]);
  });

  it("drops a project's pointer at a shared workflow when the project is next saved", () => {
    mkdirSync(path.join(dir, "issues"), { recursive: true });
    saveProject({ ...project, workflowId: "w1" } as Project);
    expect(getProject(project.id)).not.toHaveProperty("workflowId");
  });
});

describe("a project's base branch", () => {
  it("is set and cleared through the project's own update", () => {
    const set = applyProjectUpdate(project, { baseBranch: " next " });
    expect(set).toMatchObject({ baseBranch: "next" });
    expect(applyProjectUpdate(set, { baseBranch: "next" })).toBe(set);
    expect(applyProjectUpdate(set, { baseBranch: " " }).baseBranch).toBeUndefined();
    expect(() => applyProjectUpdate(project, { baseBranch: 5 as unknown as string })).toThrow(/baseBranch/);
  });
});

describe("runs", () => {
  it("are kept per issue, updated in place and capped", () => {
    expect(loadWorkflowRuns("CK-1")).toEqual([]);
    saveWorkflowRun(run({ status: "running" }));
    saveWorkflowRun(run({ id: "r2", issueKey: "CK-2" }));
    saveWorkflowRun(run({ status: "success", to: "Plan Review" }));
    expect(loadWorkflowRuns("ck-1")).toMatchObject([{ id: "r1", status: "success", to: "Plan Review" }]);
    expect(loadWorkflowRuns("CK-2")).toHaveLength(1);

    for (let i = 0; i < WORKFLOW_MAX_RUNS_PER_ISSUE + 5; i++) saveWorkflowRun(run({ id: `x${i}`, issueKey: "CK-3", startedAt: i }));
    const kept = loadWorkflowRuns("CK-3");
    expect(kept).toHaveLength(WORKFLOW_MAX_RUNS_PER_ISSUE);
    expect(kept[0].id).toBe("x5");
  });

  it("count per status and skill since the count was last started over", () => {
    saveWorkflowRun(run({ id: "a", startedAt: 10 }));
    saveWorkflowRun(run({ id: "b", startedAt: 20 }));
    saveWorkflowRun(run({ id: "c", startedAt: 30, workStatus: "Implementation" }));
    // The same status with another skill on it is different work.
    saveWorkflowRun(run({ id: "e", startedAt: 35, skill: "plan-better" }));
    expect(workRunCount("CK-1", "Refining", "plan-issue")).toBe(2);
    expect(workRunCount("CK-1", "Implementation", "plan-issue")).toBe(1);
    expect(workRunCount("CK-1", "Refining", "plan-better")).toBe(1);
    expect(runsOf("CK-1", "Refining", "plan-issue").map((r) => r.id)).toEqual(["a", "b"]);
    resetWorkRuns("CK-1", "Refining", "plan-issue", 25);
    expect(workRunCount("CK-1", "Refining", "plan-issue")).toBe(0);
    expect(workRunCount("CK-1", "Refining", "plan-better")).toBe(1);
    saveWorkflowRun(run({ id: "d", startedAt: 40 }));
    expect(workRunCount("CK-1", "Refining", "plan-issue")).toBe(1);
    // The reset survives the saves that follow it.
    expect(loadWorkflowRuns("CK-1")).toHaveLength(5);
    resetWorkRuns("CK-9", "Refining", "plan-issue");
    expect(workRunCount("CK-9", "Refining", "plan-issue")).toBe(0);
  });

  it("can be found unfinished, listed by session and deleted", () => {
    expect(loadUnfinishedRuns()).toEqual([]);
    expect(getWorkflowSessionIds().size).toBe(0);
    saveWorkflowRun(run({ id: "a", status: "running", sessionId: "sa" }));
    saveWorkflowRun(run({ id: "b", issueKey: "CK-2", status: "success", sessionId: "sb" }));
    saveWorkflowRun(run({ id: "c", issueKey: "CK-2", status: "running", sessionId: "" }));
    writeFileSync(path.join(dir, "workflow-runs", "notes.txt"), "not a run file");
    writeFileSync(path.join(dir, "workflow-runs", "CK-7.json"), "{broken");
    expect(
      loadUnfinishedRuns()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["a", "c"]);
    expect([...getWorkflowSessionIds()].sort()).toEqual(["sa", "sb"]);
    deleteWorkflowRuns("CK-1");
    expect(loadWorkflowRuns("CK-1")).toEqual([]);
    deleteWorkflowRuns("../etc");
    expect(loadWorkflowRuns("../etc")).toEqual([]);
    expect(() => saveWorkflowRun(run({ issueKey: "../etc" }))).toThrow(/Not an issue key/);
  });
});
