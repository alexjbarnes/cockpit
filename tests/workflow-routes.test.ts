// The workflow routes: a project's workflow, read and changed, and reading and
// steering an issue's place in it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({
  validateSession: (token: string) => token === "valid",
}));

const { engineRef } = vi.hoisted(() => ({ engineRef: { current: null as unknown } }));
vi.mock("@/server/singleton", () => ({
  getWorkflowEngine: () => engineRef.current,
}));

import { setDefaults } from "@/server/defaults";
import { buildIssue, buildProject, getIssue, getProject, saveIssue, saveProject } from "@/server/issue-storage";
import { loadWorkflowRuns, saveWorkflowRun, setProjectWorkflow, workflowForProject } from "@/server/workflow-storage";
import type { Issue, Project } from "@/types";

let dir: string;
let prevConfigDir: string | undefined;

function fakeEngine() {
  return {
    kick: vi.fn(),
    discard: vi.fn(),
    forget: vi.fn(),
    liveRun: vi.fn((_key: string): { id: string } | undefined => undefined),
    retry: vi.fn((key: string) => ({ key, status: "Refine Ready" })),
    stopRun: vi.fn((key: string) => ({ id: "run-1", issueKey: key, status: "stopped" })),
    activity: vi.fn(() => ({ enabled: true, paused: false, slots: { used: 0, max: 2 }, running: [], queued: [], attention: [] })),
  };
}

let engine: ReturnType<typeof fakeEngine>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-wfroutes-"));
  mkdirSync(path.join(dir, "repo"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
  setDefaults({ issuesEnabled: true, workflowsEnabled: true });
  engine = fakeEngine();
  engineRef.current = engine;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function req(url: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { ...(init.auth === false ? {} : { cookie: "cockpit_session=valid" }), "content-type": "application/json" },
  });
}

const id = (value: string) => ({ params: Promise.resolve({ id: value }) });
const key = (value: string) => ({ params: Promise.resolve({ key: value }) });

const RULES = {
  "Refine Ready": { kind: "queue", to: "Refining" },
  Refining: { kind: "agent", skill: "plan-issue", next: ["Plan Review"] },
};

function skill(name: string): void {
  const where = path.join(dir, "repo", ".claude", "skills", name);
  mkdirSync(where, { recursive: true });
  writeFileSync(path.join(where, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}.\n---\nDo it.\n`);
}

function makeProject(over: Partial<Project> = {}): Project {
  const project = { ...buildProject({ name: "Cockpit", prefix: "CK", repoPath: path.join(dir, "repo") }), ...over };
  saveProject(project);
  return project;
}

function makeIssue(project: Project, status: string, over: Partial<Issue> = {}): Issue {
  const issue = { ...buildIssue({ projectId: project.id, title: "Widget" }, { kind: "user" }), ...over, status };
  saveIssue(issue);
  return issue;
}

describe("/api/workflows", () => {
  it("lists every project that is not archived, with its workflow or none", async () => {
    const { GET } = await import("@/app/api/workflows/route");
    const project = makeProject();
    setProjectWorkflow(project, { statuses: RULES });
    makeProject({ id: "p2", prefix: "BR", name: "Bare", repoPath: undefined });
    makeProject({ id: "p3", prefix: "OLD", name: "Old", archived: true });
    const body = await (await GET(req("/api/workflows"))).json();
    expect(body.projects).toMatchObject([
      { id: project.id, name: "Cockpit", prefix: "CK", repoPath: path.join(dir, "repo"), workflow: { enabled: true, statuses: RULES } },
      { id: "p2", name: "Bare", repoPath: null, workflow: null },
    ]);
    expect((await GET(req("/api/workflows", { auth: false }))).status).toBe(401);
  });
});

describe("/api/projects/[id]/workflow", () => {
  it("answers with the workflow, the project's statuses in board order, its skills and what is in the way", async () => {
    const { GET } = await import("@/app/api/projects/[id]/workflow/route");
    skill("plan-issue");
    const project = makeProject({ customStatuses: [{ name: "Validation" }], statusOrder: ["Validation"], baseBranch: "next" });
    const none = await (await GET(req(`/api/projects/${project.id}/workflow`), id(project.id))).json();
    expect(none).toMatchObject({
      project: { id: project.id, name: "Cockpit", prefix: "CK", baseBranch: "next" },
      workflow: null,
      skills: [{ name: "plan-issue", description: "Does plan-issue.", path: ".claude/skills/plan-issue/SKILL.md" }],
      problems: [],
    });
    expect(none.statuses.slice(0, 3)).toEqual(["Validation", "Backlog", "Needs Detail"]);

    setProjectWorkflow(project, { statuses: { ...RULES, Validation: { kind: "agent", skill: "validate-issue", next: ["Done"] } } });
    const some = await (await GET(req(`/api/projects/${project.id}/workflow`), id(project.id))).json();
    expect(some.workflow.statuses.Refining).toMatchObject({ skill: "plan-issue" });
    expect(some.problems).toEqual([expect.stringContaining('"Validation" runs the skill "validate-issue", which is not in the repo')]);

    expect((await GET(req("/api/projects/nope/workflow"), id("nope"))).status).toBe(404);
    expect((await GET(req(`/api/projects/${project.id}/workflow`, { auth: false }), id(project.id))).status).toBe(401);
  });

  it("says when the project has nowhere to read skills from", async () => {
    const { GET } = await import("@/app/api/projects/[id]/workflow/route");
    const bare = makeProject({ repoPath: undefined });
    expect((await (await GET(req(`/api/projects/${bare.id}/workflow`), id(bare.id))).json()).problems[0]).toContain("no repo path");
    const lost = makeProject({ id: "p2", prefix: "LO", name: "Lost", repoPath: path.join(dir, "gone") });
    const body = await (await GET(req(`/api/projects/${lost.id}/workflow`), id(lost.id))).json();
    expect(body.problems[0]).toContain("does not exist");
    expect(body.skills).toEqual([]);
  });

  it("creates the workflow, changes it, adds the statuses it names and wakes the engine", async () => {
    const { PUT } = await import("@/app/api/projects/[id]/workflow/route");
    const project = makeProject();
    const put = (body: unknown) => PUT(req(`/api/projects/${project.id}/workflow`, { method: "PUT", body }), id(project.id));

    const made = await put({ statuses: { ...RULES, Triage: { kind: "human", next: ["Backlog"] } }, maxParallel: 3, createdAt: 1 });
    expect(made.status).toBe(200);
    const body = await made.json();
    expect(body.workflow).toMatchObject({ projectId: project.id, enabled: true, maxParallel: 3 });
    expect(body.workflow.createdAt).not.toBe(1);
    expect(body.addedStatuses).toEqual(["Triage"]);
    // The view that comes back already has the status on the board.
    expect(body.statuses).toContain("Triage");
    expect(getProject(project.id)?.customStatuses).toEqual([{ name: "Triage" }]);
    expect(engine.kick).toHaveBeenCalledTimes(1);

    // Merged by name unless it is said to be the whole thing.
    const merged = await (await put({ enabled: false, statuses: { Triage: null } })).json();
    expect(merged.workflow.enabled).toBe(false);
    expect(Object.keys(merged.workflow.statuses)).toEqual(["Refine Ready", "Refining"]);
    const replaced = await (await put({ replace: true, statuses: { "Code Review": { kind: "human" } } })).json();
    expect(Object.keys(replaced.workflow.statuses)).toEqual(["Code Review"]);

    const refused = await put({ statuses: { "Refine Ready": { kind: "queue", to: "Backlog" } } });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/no agent works in "Backlog"/);
    expect((await PUT(req(`/api/projects/${project.id}/workflow`, { method: "PUT" }), id(project.id))).status).toBe(400);
    expect((await PUT(req("/api/projects/nope/workflow", { method: "PUT", body: {} }), id("nope"))).status).toBe(404);
    expect((await PUT(req(`/api/projects/${project.id}/workflow`, { method: "PUT", body: {}, auth: false }), id(project.id))).status).toBe(
      401,
    );
  });

  it("removes the workflow, having the engine stop its runs first", async () => {
    const { DELETE } = await import("@/app/api/projects/[id]/workflow/route");
    const project = makeProject();
    setProjectWorkflow(project, { statuses: RULES });
    expect((await DELETE(req(`/api/projects/${project.id}/workflow`, { method: "DELETE" }), id(project.id))).status).toBe(200);
    expect(engine.forget).toHaveBeenCalledWith(project.id);
    expect(workflowForProject(project)).toBeUndefined();
    expect((await DELETE(req("/api/projects/nope/workflow", { method: "DELETE" }), id("nope"))).status).toBe(404);
    expect((await DELETE(req(`/api/projects/${project.id}/workflow`, { method: "DELETE", auth: false }), id(project.id))).status).toBe(401);
  });
});

describe("a project with a workflow", () => {
  it("keeps the statuses its workflow names", async () => {
    const { PUT } = await import("@/app/api/projects/[id]/route");
    const project = makeProject();
    setProjectWorkflow(project, { statuses: { Triage: { kind: "human", next: ["Backlog"] } } });
    const put = (body: unknown) => PUT(req(`/api/projects/${project.id}`, { method: "PUT", body }), id(project.id));

    const removed = await put({ customStatuses: [] });
    expect(removed.status).toBe(400);
    expect((await removed.json()).error).toMatch(/workflow uses the status "Triage"/);
    const hidden = await put({ disabledStatuses: ["Backlog"] });
    expect(hidden.status).toBe(400);
    // Anything else about it is still its own to change, and may be what an agent was waiting for.
    expect((await put({ baseBranch: "next" })).status).toBe(200);
    expect(getProject(project.id)).toMatchObject({ baseBranch: "next", customStatuses: [{ name: "Triage" }] });
    expect(engine.kick).toHaveBeenCalled();
  });

  it("takes its workflow with it when it is deleted", async () => {
    const { DELETE } = await import("@/app/api/projects/[id]/route");
    const project = makeProject();
    setProjectWorkflow(project, { statuses: RULES });
    expect((await DELETE(req(`/api/projects/${project.id}`, { method: "DELETE" }), id(project.id))).status).toBe(200);
    expect(engine.forget).toHaveBeenCalledWith(project.id);
    expect(workflowForProject(project)).toBeUndefined();
    expect((await DELETE(req("/api/projects/nope", { method: "DELETE" }), id("nope"))).status).toBe(404);
  });
});

describe("/api/workflows/activity", () => {
  it("answers with what the engine reports", async () => {
    const { GET } = await import("@/app/api/workflows/activity/route");
    expect(await (await GET(req("/api/workflows/activity"))).json()).toMatchObject({ enabled: true, slots: { used: 0, max: 2 } });
    expect((await GET(req("/api/workflows/activity", { auth: false }))).status).toBe(401);
    engineRef.current = null;
    expect((await GET(req("/api/workflows/activity"))).status).toBe(503);
  });
});

describe("/api/issues/[key]/workflow", () => {
  it("says what happens at each status, what is running on the issue and what has run", async () => {
    const { GET } = await import("@/app/api/issues/[key]/workflow/route");
    skill("plan-issue");
    const project = makeProject();
    setProjectWorkflow(project, {
      statuses: { ...RULES, "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Done"] } },
    });
    const issue = makeIssue(project, "Refining", { attention: { workStatus: "Refining", reason: "It broke", at: 5 } });
    saveWorkflowRun({
      id: "run-1",
      workStatus: "Refining",
      skill: "plan-issue",
      issueKey: issue.key,
      projectId: project.id,
      sessionId: "sess",
      status: "failure",
      startedAt: 1,
      from: "Refine Ready",
      toolsUsed: [{ name: "Read", input: "", output: "", timestamp: 1 }],
      messageCount: 2,
      cwd: "/repo",
    });
    engine.liveRun.mockReturnValue({ id: "run-2" });

    const body = await (await GET(req(`/api/issues/${issue.key}/workflow`), key(issue.key))).json();
    expect(body).toMatchObject({
      workflow: {
        enabled: true,
        statuses: { "Refine Ready": { kind: "queue", to: "Refining" }, Refining: { kind: "agent", skill: "plan-issue" } },
      },
      active: true,
      liveRunId: "run-2",
      attention: { reason: "It broke" },
      idle: false,
      // One agent's skill is in the repo; the other's is not.
      missingSkills: ["Implementation Ready"],
      runs: [{ id: "run-1", status: "failure", toolCount: 1 }],
    });
    expect(body.order.slice(0, 4)).toEqual(["Backlog", "Needs Detail", "Refine Ready", "Refining"]);
    expect(body.runs[0].toolsUsed).toBeUndefined();
  });

  it("says when an issue sits where an agent works with nothing working on it", async () => {
    const { GET } = await import("@/app/api/issues/[key]/workflow/route");
    const project = makeProject();
    setProjectWorkflow(project, {
      statuses: { ...RULES, "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Done"] } },
    });
    const idle = async (status: string, over: Partial<Issue> = {}) => {
      const issue = makeIssue(project, status, over);
      return (await (await GET(req(`/api/issues/${issue.key}/workflow`), key(issue.key))).json()).idle;
    };
    expect(await idle("Refining")).toBe(true);
    // Waiting in its queue, held, or where the agent's status is its own queue: not idle.
    expect(await idle("Refine Ready")).toBe(false);
    expect(await idle("Refining", { attention: { workStatus: "Refining", reason: "x", at: 1 } })).toBe(false);
    expect(await idle("Implementation Ready")).toBe(false);
    expect(await idle("Backlog")).toBe(false);
    engine.liveRun.mockReturnValue({ id: "run-9" });
    expect(await idle("Refining")).toBe(false);
  });

  it("says so when the project has no workflow, has no repo, or nothing is live", async () => {
    const { GET } = await import("@/app/api/issues/[key]/workflow/route");
    const bare = makeProject({ repoPath: undefined });
    const loose = makeIssue(bare, "Backlog");
    expect(await (await GET(req(`/api/issues/${loose.key}/workflow`), key(loose.key))).json()).toEqual({ workflow: null });

    setProjectWorkflow(bare, { statuses: RULES });
    const issue = makeIssue(bare, "Done");
    setDefaults({ workflowsEnabled: false });
    engineRef.current = null;
    expect(await (await GET(req(`/api/issues/${issue.key}/workflow`), key(issue.key))).json()).toMatchObject({
      active: false,
      liveRunId: null,
      attention: null,
      idle: false,
      // With no repo there is nothing to compare against: the page says that instead.
      missingSkills: [],
      runs: [],
    });
    expect((await GET(req("/api/issues/NOPE-1/workflow"), key("NOPE-1"))).status).toBe(404);
    expect((await GET(req(`/api/issues/${issue.key}/workflow`, { auth: false }), key(issue.key))).status).toBe(401);
  });
});

describe("/api/issues/[key]/run", () => {
  it("retries and stops through the engine, and passes on its refusals", async () => {
    const { POST } = await import("@/app/api/issues/[key]/run/route");
    expect(
      await (await POST(req("/api/issues/CK-1/run", { method: "POST", body: { action: "retry" } }), key("CK-1"))).json(),
    ).toMatchObject({
      issue: { key: "CK-1" },
    });
    expect(await (await POST(req("/api/issues/CK-1/run", { method: "POST", body: { action: "stop" } }), key("CK-1"))).json()).toMatchObject(
      {
        run: { status: "stopped" },
      },
    );
    engine.retry.mockImplementationOnce(() => {
      throw new Error("A run is already working on CK-1");
    });
    const refused = await POST(req("/api/issues/CK-1/run", { method: "POST", body: { action: "retry" } }), key("CK-1"));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("A run is already working on CK-1");
    expect((await POST(req("/api/issues/CK-1/run", { method: "POST", body: { action: "dance" } }), key("CK-1"))).status).toBe(400);
    expect((await POST(req("/api/issues/CK-1/run", { method: "POST" }), key("CK-1"))).status).toBe(400);
    expect((await POST(req("/api/issues/CK-1/run", { method: "POST", body: { action: "stop" }, auth: false }), key("CK-1"))).status).toBe(
      401,
    );
    engineRef.current = null;
    expect((await POST(req("/api/issues/CK-1/run", { method: "POST", body: { action: "stop" } }), key("CK-1"))).status).toBe(503);
  });
});

describe("deleting an issue", () => {
  it("stops the run working on it and removes its run history", async () => {
    const { DELETE } = await import("@/app/api/issues/[key]/route");
    const project = makeProject();
    const issue = makeIssue(project, "Refining");
    saveWorkflowRun({
      id: "run-1",
      workStatus: "Refining",
      skill: "plan-issue",
      issueKey: issue.key,
      projectId: project.id,
      sessionId: "sess",
      status: "running",
      startedAt: 1,
      from: "Refine Ready",
      toolsUsed: [],
      messageCount: 0,
      cwd: "/repo",
    });
    engine.liveRun.mockReturnValue({ id: "run-1" });
    engine.stopRun.mockImplementationOnce(() => {
      throw new Error("ended already");
    });

    expect((await DELETE(req(`/api/issues/${issue.key}`, { method: "DELETE" }), key(issue.key))).status).toBe(200);
    expect(engine.stopRun).toHaveBeenCalledWith(issue.key);
    // Its worktree is cleared while the issue can still say where it is.
    expect(engine.discard).toHaveBeenCalledWith(issue.key);
    expect(getIssue(issue.key)).toBeUndefined();
    expect(loadWorkflowRuns(issue.key)).toEqual([]);
  });
});
