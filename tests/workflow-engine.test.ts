// The workflow engine against real issue and workflow storage in a tmpdir,
// with the session manager stood in for: which issues it picks up, in what
// order and how many at once, how an agent's work ends, and what becomes of
// an issue whose run did not end well.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/transcript", () => ({
  countTranscriptMessages: vi.fn(() => 0),
}));

vi.mock("@/server/inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/inbox")>();
  return { ...actual, addInboxMessage: vi.fn() };
});

const { modelCheck } = vi.hoisted(() => ({ modelCheck: { result: { ok: true } as { ok: true } | { ok: false; reason: string } } }));
vi.mock("@/server/provider-catalog", () => ({
  checkJobModel: () => modelCheck.result,
}));

const { trusted } = vi.hoisted(() => ({ trusted: [] as string[] }));
vi.mock("@/server/workspace-trust", () => ({
  trustDirectory: (dir: string) => {
    trusted.push(dir);
    return true;
  },
}));

import { setDefaults } from "@/server/defaults";
import { addInboxMessage } from "@/server/inbox";
import { applyIssueUpdate, applyProjectUpdate, buildIssue, buildProject, getIssue, saveIssue, saveProject } from "@/server/issue-storage";
import { buildRunPrompt, WORKFLOW_MAX_WORK_RUNS, WorkflowEngine } from "@/server/workflow-engine";
import { agentWork, deleteWorkflow, loadWorkflowRuns, saveWorkflowRun, setProjectWorkflow } from "@/server/workflow-storage";
import type { Issue, IssueActor, Project, Workflow, WorkflowRun } from "@/types";

interface FakeSession {
  id: string;
  cwd: string;
  name: string;
  options: Record<string, unknown>;
  messages: string[];
  destroyed: boolean;
  status?: (status: string) => void;
  error?: (error: string) => void;
  event?: (event: Record<string, unknown>) => void;
  init?: (data: Record<string, unknown>) => void;
}

function makeSessions() {
  const sessions: FakeSession[] = [];
  const get = (id: string) => sessions.find((s) => s.id === id) as FakeSession;
  const hook =
    <K extends "status" | "error" | "event" | "init">(key: K) =>
    (id: string, cb: NonNullable<FakeSession[K]>) => {
      get(id)[key] = cb;
      return () => {
        get(id)[key] = undefined;
      };
    };
  return {
    sessions,
    get,
    createSession: vi.fn((cwd: string, name: string, options: Record<string, unknown>) => {
      const session: FakeSession = { id: `s${sessions.length + 1}`, cwd, name, options, messages: [], destroyed: false };
      sessions.push(session);
      return { id: session.id, runtime: (options.runtime as string) ?? "pty" };
    }),
    /** A session that was used before is brought back, when it is one of ours. */
    resumeForRun: vi.fn((id: string, _cwd: string, options: Record<string, unknown>) => {
      const session = sessions.find((s) => s.id === id);
      if (!session) return undefined;
      session.destroyed = false;
      session.options = { ...session.options, ...options, resumed: true };
      return { id: session.id, runtime: "pty" };
    }),
    destroySession: vi.fn((id: string) => {
      get(id).destroyed = true;
    }),
    sendMessage: vi.fn((id: string, text: string) => {
      get(id).messages.push(text);
      return true;
    }),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    respondToPermission: vi.fn(),
    mcpToggle: vi.fn((_id: string, _name: string, _on: boolean) => Promise.resolve()),
    hasRunningProcess: vi.fn(() => true),
    subscribe: hook("event"),
    onStatus: hook("status"),
    onError: hook("error"),
    onInit: hook("init"),
    onSystem: vi.fn(() => () => {}),
    /** The session says something and its turn ends. */
    endTurn(id: string, text = "Done.") {
      get(id).event?.({ type: "message_done", message: { content: text } });
      get(id).status?.("idle");
    },
  };
}

let dir: string;
let repo: string;
let prevConfigDir: string | undefined;
let sm: ReturnType<typeof makeSessions>;
let engine: WorkflowEngine;
let project: Project;
let workflow: Workflow;

const USER: IssueActor = { kind: "user" };

const PLAN = { kind: "agent", skill: "plan-issue", next: ["Plan Review", "Needs Detail"] };
const BUILD = { kind: "agent", skill: "implement-issue", next: ["Code Review"] };
const GATE = {
  kind: "human",
  review: "plan",
  next: [
    { status: "Implementation Ready", label: "Approve", role: "approve" },
    { status: "Refine Ready", label: "Send back", role: "sendBack" },
  ],
};
/** Planning has a queue in front of it; building is queued and worked in one status. */
const RULES: Record<string, Record<string, unknown>> = {
  "Refine Ready": { kind: "queue", to: "Refining" },
  Refining: PLAN,
  "Plan Review": GATE,
  "Implementation Ready": BUILD,
};

/** The rules with the planning agent changed. */
const plan = (over: Record<string, unknown>) => ({ ...RULES, Refining: { ...PLAN, ...over } });
function skill(name: string, where: string = repo): void {
  mkdirSync(path.join(where, ".claude", "skills", name), { recursive: true });
  writeFileSync(path.join(where, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Does ${name}.\n---\nDo it.\n`);
}

function setup(rules: Record<string, unknown> = RULES, over: Record<string, unknown> = {}): void {
  project = buildProject({ name: "Cockpit", prefix: "CK", repoPath: repo });
  saveProject(project);
  workflow = setProjectWorkflow(project, { maxParallel: 5, statuses: rules, ...over }).workflow;
}

function makeIssue(status: string, over: Partial<Issue> = {}, into: Project = project): Issue {
  const issue = {
    ...buildIssue({ projectId: into.id, title: over.title ?? "Widget", description: "We need a widget." }, USER),
    ...over,
    status,
  };
  saveIssue(issue);
  return issue;
}

function moveAs(key: string, status: string, actor: IssueActor): void {
  const issue = getIssue(key) as Issue;
  saveIssue(applyIssueUpdate(issue, { status }, actor));
}

/** The actor a run's own session writes as. */
function runActor(key: string): IssueActor {
  const run = loadWorkflowRuns(key).at(-1) as WorkflowRun;
  return { kind: "workflow", workStatus: run.workStatus, skill: run.skill, runId: run.id, sessionId: run.sessionId };
}

function oldRun(issue: Issue, id: string, over: Partial<WorkflowRun> = {}): void {
  saveWorkflowRun({
    id,
    workStatus: "Implementation Ready",
    skill: "implement-issue",
    issueKey: issue.key,
    projectId: project.id,
    sessionId: `o-${id}`,
    status: "success",
    startedAt: Date.now() - 1000,
    from: "Implementation Ready",
    to: "Code Review",
    toolsUsed: [],
    messageCount: 1,
    cwd: repo,
    ...over,
  });
}

/** Let the engine's deferred look for work happen. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  vi.clearAllMocks();
  trusted.length = 0;
  modelCheck.result = { ok: true };
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-engine-"));
  repo = path.join(dir, "repo");
  mkdirSync(repo);
  skill("plan-issue");
  skill("implement-issue");
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
  setDefaults({ issuesEnabled: true, workflowsEnabled: true, workflowsPaused: false, workflowMaxParallel: 3 });
  sm = makeSessions();
  engine = new WorkflowEngine(sm as never);
});

afterEach(() => {
  engine.stop();
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("picking up an issue", () => {
  it("gives an issue in a queue a session, moves it to where the agent works and names the skill in the prompt", () => {
    setup(plan({ model: "opus", contextSize: "1m", thinkingLevel: "high", maxDurationMinutes: 45 }));
    const issue = makeIssue("Refine Ready");
    engine.fill();

    expect(sm.sessions).toHaveLength(1);
    const session = sm.sessions[0];
    expect(session.cwd).toBe(repo);
    expect(trusted).toEqual([repo]);
    expect(session.name).toBe(`[${issue.key}] plan-issue`);
    expect(session.options).toMatchObject({
      bypassPermissions: true,
      sandbox: { enabled: false },
      workflowContext: { projectId: project.id, workStatus: "Refining", skill: "plan-issue", issueKey: issue.key },
    });
    expect(sm.setModel).toHaveBeenCalledWith("s1", "opus", "1m");
    expect(sm.setThinkingLevel).toHaveBeenCalledWith("s1", "high");

    const prompt = session.messages[0];
    expect(prompt).toContain(`workflow on issue ${issue.key},`);
    expect(prompt).toContain(`get_issue (key "${issue.key}")`);
    expect(prompt).toContain('run this repository\'s "plan-issue" skill');
    expect(prompt).toContain(".claude/skills/plan-issue/SKILL.md");
    expect(prompt).toContain('- "Plan Review"');
    expect(prompt).toContain('- "Needs Detail"');
    expect(prompt).not.toContain("Code Review");

    // The engine, not the agent, moved it out of the queue, in the run's name.
    const claimed = getIssue(issue.key) as Issue;
    expect(claimed.status).toBe("Refining");
    expect(claimed.activity.at(-1)).toMatchObject({
      field: "status",
      from: "Refine Ready",
      to: "Refining",
      actor: { kind: "workflow", workStatus: "Refining", skill: "plan-issue", sessionId: "s1" },
    });
    expect(loadWorkflowRuns(issue.key)).toMatchObject([
      { status: "running", workStatus: "Refining", skill: "plan-issue", sessionId: "s1", from: "Refine Ready", model: "opus", cwd: repo },
    ]);
    expect(engine.liveRun(issue.key)?.sessionId).toBe("s1");

    // Looking again does not start a second run on it.
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
  });

  it("works an issue where it is when the agent's status has no queue in front", () => {
    setup();
    const issue = makeIssue("Implementation Ready");
    engine.fill();
    expect(sm.sessions[0].name).toBe(`[${issue.key}] implement-issue`);
    expect(getIssue(issue.key)?.status).toBe("Implementation Ready");
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ workStatus: "Implementation Ready", from: "Implementation Ready" }]);
  });

  it("leaves alone an issue waiting for a person, at no rule, or in a project with no workflow", () => {
    setup();
    makeIssue("Plan Review");
    makeIssue("Backlog");
    const bare = buildProject({ name: "Bare", prefix: "BR", repoPath: repo });
    saveProject(bare);
    makeIssue("Refine Ready", {}, bare);
    engine.fill();
    expect(sm.sessions).toHaveLength(0);
  });

  it("does not start an agent on an issue put straight where the agent works, when that has a queue", () => {
    setup();
    const there = makeIssue("Refining");
    engine.fill();
    expect(sm.sessions).toHaveLength(0);
    expect(getIssue(there.key)?.attention).toBeUndefined();
    expect(engine.activity().queued).toEqual([]);
  });

  it.each([
    ["workflows are off", () => setDefaults({ workflowsEnabled: false })],
    ["the issue tracker is off", () => setDefaults({ issuesEnabled: false })],
    ["workflows are paused", () => setDefaults({ workflowsPaused: true })],
    ["the workflow is switched off", () => setProjectWorkflow(project, { enabled: false })],
    ["the project is archived", () => saveProject(applyProjectUpdate(project, { archived: true }))],
    ["the project's workflow is removed", () => deleteWorkflow(project.id)],
  ])("starts nothing while %s", (_name, change) => {
    setup();
    makeIssue("Refine Ready");
    change();
    engine.fill();
    expect(sm.sessions).toHaveLength(0);
  });

  it("holds an issue it cannot start, and says why", () => {
    setup();
    saveProject(applyProjectUpdate(project, { repoPath: path.join(dir, "gone") }));
    const noRepo = makeIssue("Refine Ready");
    engine.fill();
    expect(sm.sessions).toHaveLength(0);
    // Held where it waits: it never left the queue.
    expect(getIssue(noRepo.key)).toMatchObject({
      status: "Refine Ready",
      attention: { workStatus: "Refining", reason: expect.stringContaining("no repository folder") },
    });
    expect(addInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        title: `${noRepo.key} needs you: Refining`,
        priority: "warning",
        body: expect.stringContaining(`/issues/${noRepo.key}`),
      }),
    );
    // Held: it is not tried again on the next look.
    engine.fill();
    expect(addInboxMessage).toHaveBeenCalledTimes(1);

    // Retrying something held in its queue lets it go again.
    saveProject(applyProjectUpdate(project, { repoPath: repo }));
    expect(engine.retry(noRepo.key)).toMatchObject({ status: "Refine Ready" });
    engine.fill();
    expect(sm.sessions).toHaveLength(1);

    modelCheck.result = { ok: false, reason: "Model gone from the catalog" };
    const noModel = makeIssue("Refine Ready");
    engine.fill();
    expect(getIssue(noModel.key)?.attention?.reason).toBe("Model gone from the catalog");
    expect(sm.sessions).toHaveLength(1);
  });

  it("holds the issue when the session cannot be created", () => {
    setup();
    const issue = makeIssue("Refine Ready");
    sm.createSession.mockImplementationOnce(() => {
      throw new Error("no pty left");
    });
    engine.fill();
    expect(getIssue(issue.key)?.attention?.reason).toContain("could not be started: no pty left");
    expect(engine.liveRun(issue.key)).toBeUndefined();
  });

  it("stops the session and holds the issue when it cannot be moved to where the agent works", () => {
    setup({ Waiting: { kind: "queue", to: "Drafting" }, Drafting: { kind: "agent", skill: "plan-issue", next: ["Done"] } });
    // The status the agent works in is taken off the board behind the workflow's back.
    const fresh = applyProjectUpdate(project, { customStatuses: [{ name: "Waiting" }] });
    saveProject(fresh);
    const issue = makeIssue("Waiting");
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
    expect(sm.sessions[0].destroyed).toBe(true);
    expect(engine.liveRun(issue.key)).toBeUndefined();
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "stopped" }]);
    expect(getIssue(issue.key)).toMatchObject({
      status: "Waiting",
      attention: { reason: expect.stringContaining('could not be moved to "Drafting"') },
    });
  });
});

describe("a skill that is not there", () => {
  it("starts nothing, holds nothing and says which status is blocked", () => {
    setup(plan({ skill: "not-written-yet" }));
    const issue = makeIssue("Refine Ready");
    const other = makeIssue("Implementation Ready");
    engine.fill();
    // The other agent's skill is there, so its issue runs.
    expect(sm.sessions.map((s) => s.name)).toEqual([`[${other.key}] implement-issue`]);
    expect(getIssue(issue.key)).toMatchObject({ status: "Refine Ready" });
    expect(getIssue(issue.key)?.attention).toBeUndefined();
    expect(addInboxMessage).not.toHaveBeenCalled();
    const activity = engine.activity();
    expect(activity.blocked).toEqual([{ projectId: project.id, status: "Refining", skill: "not-written-yet" }]);
    expect(activity.queued).toEqual([]);
    expect(activity.statuses[project.id]).toEqual(
      expect.arrayContaining([
        { status: "Refine Ready", kind: "queue", to: "Refining", skill: "not-written-yet", missing: true },
        { status: "Refining", kind: "agent", skill: "not-written-yet", missing: true },
        { status: "Implementation Ready", kind: "agent", skill: "implement-issue" },
      ]),
    );

    // Written, it is picked up on the next look.
    skill("not-written-yet");
    engine.fill();
    expect(sm.sessions).toHaveLength(2);
  });
});

describe("how an agent's session is allowed to work", () => {
  it("answers from the rule's lists on an allowlist, and always allows the Skill tool and the cockpit tools", () => {
    setup(plan({ permission: "allowlist", allowedTools: ["Read", "Bash git"], mcpServers: ["graphene"], sandbox: true }));
    makeIssue("Refine Ready");
    engine.fill();
    const session = sm.sessions[0];
    expect(session.options).toMatchObject({ bypassPermissions: false, sandbox: { enabled: true } });
    expect(session.messages[0]).toContain("Allowed tools: Read, Bash git");
    expect(session.messages[0]).toContain("Allowed MCP servers: graphene");
    expect(session.messages[0]).toContain('A "Bash <program>" entry');
    expect(session.messages[0]).toContain("besides the Skill tool and the cockpit issue tools");

    const ask = (toolName: string, toolInput: string, requestId: string) =>
      session.event?.({ type: "permission_request", requestId, toolName, toolInput, rawToolInput: {} });
    ask("Read", "{}", "r1");
    ask("Bash", JSON.stringify({ command: "rm -rf /" }), "r2");
    ask("mcp__cockpit-config__update_issue", "{}", "r3");
    ask("mcp__cockpit-config__add_inbox_message", "{}", "r4");
    ask("mcp__graphene__read", "{}", "r5");
    ask("mcp__gmail__send_email", "{}", "r6");
    ask("Skill", JSON.stringify({ skill: "plan-issue" }), "r7");
    const answers = Object.fromEntries(sm.respondToPermission.mock.calls.map((c) => [c[1], c[2]]));
    expect(answers).toEqual({ r1: true, r2: false, r3: true, r4: true, r5: true, r6: false, r7: true });

    // The server a run ends through is never switched off with the rest.
    session.init?.({ mcpServers: [{ name: "cockpit-config" }, { name: "graphene" }, { name: "gmail" }] });
    expect(sm.mcpToggle.mock.calls.map((c) => c[1])).toEqual(["gmail"]);
  });

  it("leaves a prompt for the user when the rule asks", () => {
    setup(plan({ permission: "ask" }));
    makeIssue("Refine Ready");
    engine.fill();
    const session = sm.sessions[0];
    expect(session.options).toMatchObject({ bypassPermissions: false });
    expect(session.messages[0]).toContain("put to the user");
    session.event?.({ type: "permission_request", requestId: "r1", toolName: "Bash", toolInput: "{}" });
    expect(sm.respondToPermission).not.toHaveBeenCalled();
    session.init?.({ mcpServers: [{ name: "cockpit-config" }, { name: "gmail" }] });
    expect(sm.mcpToggle.mock.calls.map((c) => c[1])).toEqual(["gmail"]);
  });

  it("allows everything on bypass", () => {
    setup();
    makeIssue("Refine Ready");
    engine.fill();
    sm.sessions[0].event?.({
      type: "permission_request",
      requestId: "r1",
      toolName: "Bash",
      toolInput: "{}",
      rawToolInput: { command: "ls" },
    });
    expect(sm.respondToPermission).toHaveBeenCalledWith("s1", "r1", true, { command: "ls" }, undefined, undefined, "bypass");
    expect(sm.sessions[0].messages[0]).toContain("all tools and MCP servers are available");
  });

  it("writes an allowlist prompt with nothing listed", () => {
    setup(plan({ permission: "allowlist" }));
    const issue = makeIssue("Refine Ready");
    const prompt = buildRunPrompt(issue, project, agentWork(workflow)[0], repo);
    expect(prompt).toContain("only the tools and MCP servers listed below are allowed");
    expect(prompt).not.toContain("Allowed tools:");
  });

  it("tells the agent to ask in the issue rather than guess, and to take the cheapest route", () => {
    setup(plan({}));
    const issue = makeIssue("Refine Ready");
    const prompt = buildRunPrompt(issue, project, agentWork(workflow)[0], repo);
    expect(prompt).toContain("Choose the cheapest route to the goal");
    expect(prompt).toContain("do not guess");
    expect(prompt).toContain("a person must add detail");
    // The old wording was a blanket licence to assume, which is what let a
    // one-line issue become a plan built on guesses.
    expect(prompt).not.toContain("Make reasonable assumptions and proceed");
  });
});

describe("how an agent's work ends", () => {
  it("is over when its session has moved the issue on", () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.fill();
    moveAs(issue.key, "Plan Review", runActor(issue.key));
    sm.endTurn("s1", "Planned.");

    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "success", from: "Refine Ready", to: "Plan Review" }]);
    expect(sm.sessions[0].destroyed).toBe(true);
    expect(engine.liveRun(issue.key)).toBeUndefined();
    expect(getIssue(issue.key)?.attention).toBeUndefined();
  });

  it("is over even when a person sends the issue straight back before the session has stopped", async () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();
    moveAs(issue.key, "Plan Review", runActor(issue.key));
    // The reviewer is quick: back to the queue while the agent is still saying goodbye.
    moveAs(issue.key, "Refine Ready", USER);
    expect(sm.sessions[0].destroyed).toBe(false);
    sm.endTurn("s1", "Planned.");

    // Not nudged, not failed: its move was the end of its work.
    expect(sm.sessions[0].messages).toHaveLength(1);
    expect(loadWorkflowRuns(issue.key)[0]).toMatchObject({ status: "success", to: "Plan Review" });
    // And the issue, back in the queue, gets its next run.
    await settle();
    expect(sm.sessions).toHaveLength(2);
    expect(getIssue(issue.key)?.status).toBe("Refining");
  });

  it("asks once when the session stops without moving the issue, then counts it as failed", () => {
    setup(plan({ maxRetries: 0 }));
    const issue = makeIssue("Refine Ready");
    engine.fill();
    sm.endTurn("s1", "I think that is everything.");

    // Still going: it was told what it left undone.
    expect(engine.liveRun(issue.key)).toBeDefined();
    expect(sm.sessions[0].messages).toHaveLength(2);
    expect(sm.sessions[0].messages[1]).toContain(`stopped without moving ${issue.key} on`);
    expect(sm.sessions[0].messages[1]).toContain('one of: "Plan Review", "Needs Detail"');

    sm.endTurn("s1", "Nothing more to do.");
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "failure", error: expect.stringContaining("without moving") }]);
    const held = getIssue(issue.key) as Issue;
    // It goes back to the queue it came from, and is held.
    expect(held.status).toBe("Refine Ready");
    expect(held.attention).toMatchObject({ workStatus: "Refining", reason: expect.stringContaining("without moving") });
    expect(sm.sessions[0].destroyed).toBe(true);
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
  });

  it("takes the nudge: a session that then moves the issue has finished", () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.fill();
    sm.endTurn("s1");
    moveAs(issue.key, "Needs Detail", runActor(issue.key));
    sm.endTurn("s1", "Moved it.");
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "success", to: "Needs Detail" }]);
    expect(getIssue(issue.key)?.attention).toBeUndefined();
  });

  it("runs a failed run again, as often as the rule allows, before holding the issue", async () => {
    setup(plan({ maxRetries: 1 }));
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();
    expect(sm.sessions).toHaveLength(1);
    sm.get("s1").error?.("CLI crashed");
    await settle();

    // Back in the queue without a flag, and picked up again.
    expect(sm.sessions).toHaveLength(2);
    expect(getIssue(issue.key)).toMatchObject({ status: "Refining" });
    expect(addInboxMessage).not.toHaveBeenCalled();

    sm.get("s2").error?.("CLI crashed again");
    await settle();
    expect(sm.sessions).toHaveLength(2);
    const held = getIssue(issue.key) as Issue;
    expect(held.status).toBe("Refine Ready");
    expect(held.attention?.reason).toBe("CLI crashed again");
    expect(loadWorkflowRuns(issue.key).map((r) => r.status)).toEqual(["failure", "failure"]);
  });

  it("does not run again a run that used up its time", () => {
    vi.useFakeTimers();
    try {
      setup(plan({ maxDurationMinutes: 10, maxRetries: 3 }));
      const issue = makeIssue("Refine Ready");
      engine.fill();
      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "timeout" }]);
      expect(getIssue(issue.key)?.attention?.reason).toContain("Exceeded max duration of 10 minutes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds an issue whose session reported it could not do the work", () => {
    setup(plan({ maxRetries: 0 }));
    const issue = makeIssue("Refine Ready");
    engine.fill();
    sm.endTurn("s1");
    sm.endTurn("s1", 'Could not.\n\n```cockpit-error\n{"error":"No access","details":"git push was refused"}\n```');
    expect(getIssue(issue.key)?.attention?.reason).toContain("without moving");
    expect(loadWorkflowRuns(issue.key)[0].status).toBe("failure");
  });

  it("lets the outcome stand when the issue moved on but the turn ended badly", () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.fill();
    moveAs(issue.key, "Plan Review", runActor(issue.key));
    sm.endTurn("s1", 'Done, mostly.\n\n```cockpit-error\n{"error":"A lint warning"}\n```');
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "failure", to: "Plan Review", error: "A lint warning" }]);
    expect(getIssue(issue.key)).toMatchObject({ status: "Plan Review" });
    expect(getIssue(issue.key)?.attention).toBeUndefined();
  });

  it("ends quietly when the issue was deleted under it", async () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.fill();
    const { deleteIssue } = await import("@/server/issue-storage");
    deleteIssue(issue.key);
    sm.endTurn("s1");
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "failure", error: "The issue no longer exists" }]);
    expect(engine.liveRun(issue.key)).toBeUndefined();
  });

  it("stops handing an issue back and forth after a set number of runs, until someone retries it", () => {
    setup();
    const issue = makeIssue("Implementation Ready");
    for (let i = 0; i < WORKFLOW_MAX_WORK_RUNS; i++) oldRun(issue, `old${i}`, { startedAt: Date.now() - 1000 + i });
    engine.fill();
    expect(sm.sessions).toHaveLength(0);
    expect(getIssue(issue.key)?.attention?.reason).toContain(`${WORKFLOW_MAX_WORK_RUNS} times`);

    const retried = engine.retry(issue.key);
    expect(retried.attention).toBeUndefined();
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
  });

  it("counts a different skill put on the status as different work, starting clean", () => {
    setup();
    skill("build-it-properly");
    const issue = makeIssue("Implementation Ready");
    for (let i = 0; i < WORKFLOW_MAX_WORK_RUNS; i++) oldRun(issue, `old${i}`, { startedAt: Date.now() - 1000 + i });
    setProjectWorkflow(project, { statuses: { "Implementation Ready": { ...BUILD, skill: "build-it-properly", continueSession: true } } });
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
    expect(sm.sessions[0].name).toBe(`[${issue.key}] build-it-properly`);
    // Nor does it carry on in a session that ran the other skill.
    expect(sm.resumeForRun).not.toHaveBeenCalled();
  });
});

describe("where an agent works", () => {
  function gitRepo(): void {
    const run = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
    run("init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
  }
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await settle();
    expect(check()).toBe(true);
  };

  it("gives each issue its own worktree and port, keeps the worktree for later work and removes it when the issue is done", async () => {
    gitRepo();
    setup({
      ...RULES,
      Refining: { ...PLAN, workspace: "worktree" },
      "Implementation Ready": { ...BUILD, workspace: "worktree", next: ["Done"] },
    });
    const a = makeIssue("Refine Ready", { createdAt: 1 });
    const b = makeIssue("Refine Ready", { createdAt: 2 });
    engine.fill();
    // Being made: the slot is held, and it reads as waiting, not running.
    expect(sm.sessions).toHaveLength(0);
    expect(engine.activity()).toMatchObject({ slots: { used: 2 }, running: [], queued: [{ issueKey: a.key }, { issueKey: b.key }] });
    await until(() => sm.sessions.length === 2);

    const [first, second] = [...sm.sessions].sort((x, y) => x.name.localeCompare(y.name));
    const root = path.join(dir, "worktrees");
    expect(first.cwd).toBe(path.join(root, `repo-${a.key}`));
    expect(second.cwd).toBe(path.join(root, `repo-${b.key}`));
    expect(existsSync(path.join(first.cwd, "README.md"))).toBe(true);
    expect(getIssue(a.key)?.workspace).toMatchObject({ path: first.cwd, branch: `issue/${a.key}`, base: "HEAD" });
    expect(trusted).toEqual(expect.arrayContaining([first.cwd, second.cwd]));

    const env = (s: FakeSession) => s.options.runEnv as { COCKPIT_RUN_PORT: string; COCKPIT_ISSUE_KEY: string };
    expect(env(first).COCKPIT_ISSUE_KEY).toBe(a.key);
    expect(env(first).COCKPIT_RUN_PORT).not.toBe(env(second).COCKPIT_RUN_PORT);
    expect(first.messages[0]).toContain(`It is this issue's own git worktree, on the branch issue/${a.key}, started from HEAD.`);
    expect(first.messages[0]).toContain(`Port ${env(first).COCKPIT_RUN_PORT} is kept for this run`);
    expect(first.messages[0]).toContain("Do not make another worktree");

    // The next agent on the same issue works in the same place.
    moveAs(a.key, "Plan Review", runActor(a.key));
    sm.endTurn(first.id);
    moveAs(a.key, "Implementation Ready", USER);
    engine.fill();
    await until(() => sm.sessions.length === 3);
    const built = sm.sessions[2];
    expect(built.cwd).toBe(first.cwd);

    // Done while its session is still talking: the worktree waits for it.
    moveAs(a.key, "Done", runActor(a.key));
    expect(existsSync(first.cwd)).toBe(true);
    sm.endTurn(built.id, "Built.");
    await until(() => !existsSync(first.cwd));
    expect(getIssue(a.key)?.workspace).toBeUndefined();
    // The other issue's is untouched.
    expect(existsSync(second.cwd)).toBe(true);

    // Cancelled by hand with a run going: the run stops and the worktree goes.
    engine.start();
    moveAs(b.key, "Cancelled", USER);
    await until(() => !existsSync(second.cwd));
    expect(second.destroyed).toBe(true);
  });

  it("holds the issue when the skill is in the project's folder but not in the issue's worktree", async () => {
    gitRepo();
    // Written after the commit the worktree is cut from, and never committed.
    skill("review-issue");
    setup({ Waiting: { kind: "agent", skill: "review-issue", next: ["Done"], workspace: "worktree" } });
    const issue = makeIssue("Waiting");
    engine.fill();
    await until(() => !!getIssue(issue.key)?.attention);
    const reason = getIssue(issue.key)?.attention?.reason as string;
    expect(reason).toContain('There is no "review-issue" skill');
    expect(reason).toContain(`branch issue/${issue.key}`);
    expect(reason).toContain(".claude/skills/review-issue/SKILL.md");
    expect(sm.sessions).toHaveLength(0);
    expect(engine.activity().slots.used).toBe(0);
  });

  it("holds the issue when its worktree cannot be made, and frees the slot", async () => {
    setup(plan({ workspace: "worktree" }));
    const issue = makeIssue("Refine Ready");
    engine.fill();
    await until(() => !!getIssue(issue.key)?.attention);
    expect(getIssue(issue.key)?.attention?.reason).toContain("Its worktree could not be made");
    expect(getIssue(issue.key)?.attention?.reason).toContain("not a git repository");
    expect(sm.sessions).toHaveLength(0);
    expect(engine.activity().slots.used).toBe(0);
  });

  it("starts nothing for an issue that was moved away while its worktree was being made", async () => {
    gitRepo();
    setup(plan({ workspace: "worktree" }));
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();
    moveAs(issue.key, "Backlog", USER);
    for (let i = 0; i < 40; i++) await settle();
    expect(sm.sessions).toHaveLength(0);
    expect(engine.activity().slots.used).toBe(0);
  });

  it("starts nothing when the agent's rule was changed while the worktree was being made", async () => {
    gitRepo();
    setup(plan({ workspace: "worktree" }));
    const issue = makeIssue("Refine Ready");
    engine.fill();
    expect(engine.activity().slots.used).toBe(1);
    // A different skill now: the run that was being started is not this work
    // any more. The new skill is not written yet, so nothing else starts either.
    setProjectWorkflow(project, { statuses: { Refining: { ...PLAN, skill: "another-plan" } } });
    await until(() => engine.activity().slots.used === 0);
    for (let i = 0; i < 20; i++) await settle();
    expect(sm.sessions).toHaveLength(0);
    expect(getIssue(issue.key)).toMatchObject({ status: "Refine Ready" });
    expect(getIssue(issue.key)?.attention).toBeUndefined();
  });

  it("removes the worktree of an issue that is deleted", async () => {
    gitRepo();
    setup(plan({ workspace: "worktree" }));
    const issue = makeIssue("Refine Ready");
    engine.fill();
    await until(() => sm.sessions.length === 1);
    const where = sm.sessions[0].cwd;
    engine.stopRun(issue.key);
    engine.discard(issue.key);
    await until(() => !existsSync(where));
    engine.discard("CK-404");
  });
});

describe("an issue that comes back to an agent", () => {
  it("is carried on in the session that worked on it before, when the rule says so", () => {
    setup(plan({ continueSession: true }));
    const issue = makeIssue("Refine Ready");
    engine.fill();
    expect(sm.sessions[0].messages[0]).toContain('You are the agent for the "Refining" status');
    moveAs(issue.key, "Plan Review", runActor(issue.key));
    sm.endTurn("s1");
    expect(sm.sessions[0].destroyed).toBe(true);

    // The reviewer sends it back.
    moveAs(issue.key, "Refine Ready", USER);
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
    expect(sm.resumeForRun).toHaveBeenCalledWith(
      "s1",
      repo,
      expect.objectContaining({ workflowContext: expect.objectContaining({ issueKey: issue.key }) }),
    );
    const again = sm.sessions[0].messages.at(-1) as string;
    expect(again).toContain(`${issue.key} has come back to "Refining"`);
    expect(again).toContain("carrying on in the session that worked on it before");
    expect(again).toContain('- "Plan Review"');
    expect(loadWorkflowRuns(issue.key).map((r) => r.sessionId)).toEqual(["s1", "s1"]);

    moveAs(issue.key, "Plan Review", runActor(issue.key));
    sm.endTurn("s1");
    expect(loadWorkflowRuns(issue.key).map((r) => r.status)).toEqual(["success", "success"]);
  });

  it("starts fresh when the rule does not carry on, the last run failed, or the session is gone", () => {
    setup({ ...plan({ maxRetries: 0 }), "Implementation Ready": { ...BUILD, continueSession: true } });
    const plain = makeIssue("Refine Ready", { createdAt: 1 });
    engine.fill();
    moveAs(plain.key, "Plan Review", runActor(plain.key));
    sm.endTurn("s1");
    moveAs(plain.key, "Refine Ready", USER);
    engine.fill();
    expect(sm.sessions).toHaveLength(2);
    expect(sm.resumeForRun).not.toHaveBeenCalled();

    // An agent that carries on, with nothing good to carry on from.
    const built = makeIssue("Implementation Ready", { createdAt: 2 });
    engine.fill();
    expect(sm.sessions).toHaveLength(3);
    sm.get("s3").error?.("boom");
    sm.get("s3").error?.("boom");
    engine.retry(built.key);
    engine.fill();
    expect(sm.resumeForRun).not.toHaveBeenCalled();

    // And one whose earlier session can no longer be brought back.
    const lost = makeIssue("Implementation Ready", { createdAt: 3 });
    oldRun(lost, "old", { sessionId: "forgotten", startedAt: 1, to: undefined });
    const before = sm.sessions.length;
    engine.fill();
    expect(sm.resumeForRun).toHaveBeenCalledWith("forgotten", repo, expect.anything());
    expect(sm.sessions.length).toBe(before + 1);
    expect(sm.sessions.at(-1)?.messages[0]).toContain('You are the agent for the "Implementation Ready" status');
  });
});

describe("how many run at once", () => {
  it("fills the global limit, most urgent first, and starts the next when one ends", async () => {
    setup();
    setDefaults({ workflowMaxParallel: 2 });
    const low = makeIssue("Refine Ready", { title: "low", priority: 4, createdAt: 1 });
    const none = makeIssue("Refine Ready", { title: "none", createdAt: 2 });
    const urgent = makeIssue("Refine Ready", { title: "urgent", priority: 1, createdAt: 3 });
    const dragged = makeIssue("Refine Ready", { title: "dragged", priority: 1, createdAt: 4, order: 1000 });
    engine.start();
    await settle();

    expect(sm.sessions.map((s) => s.name)).toEqual([`[${dragged.key}] plan-issue`, `[${urgent.key}] plan-issue`]);
    expect(engine.activity()).toMatchObject({
      enabled: true,
      paused: false,
      slots: { used: 2, max: 2 },
      running: [{ issueKey: dragged.key, status: "Refining", skill: "plan-issue", sessionId: "s1" }, { issueKey: urgent.key }],
      queued: [{ issueKey: low.key, status: "Refine Ready", skill: "plan-issue" }, { issueKey: none.key }],
      attention: [],
    });

    moveAs(dragged.key, "Plan Review", runActor(dragged.key));
    sm.endTurn("s1");
    await settle();
    expect(sm.sessions.map((s) => s.name)).toEqual([
      `[${dragged.key}] plan-issue`,
      `[${urgent.key}] plan-issue`,
      `[${low.key}] plan-issue`,
    ]);
    expect(engine.activity().slots).toEqual({ used: 2, max: 2 });
  });

  it("keeps to the project's own limit, and lets another project past it", () => {
    setup(RULES, { maxParallel: 1 });
    const other = buildProject({ name: "Other", prefix: "OT", repoPath: repo });
    saveProject(other);
    setProjectWorkflow(other, { maxParallel: 1, statuses: RULES });
    makeIssue("Refine Ready", { createdAt: 1 });
    makeIssue("Implementation Ready", { createdAt: 2 });
    const elsewhere = makeIssue("Refine Ready", { createdAt: 3 }, other);
    engine.fill();
    expect(sm.sessions.map((s) => s.name)).toEqual(["[CK-1] plan-issue", `[${elsewhere.key}] plan-issue`]);
  });

  it("keeps to an agent's own limit, and lets another agent past it", () => {
    setup(plan({ maxParallel: 1 }));
    makeIssue("Refine Ready", { createdAt: 1 });
    makeIssue("Refine Ready", { createdAt: 2 });
    const built = makeIssue("Implementation Ready", { createdAt: 3 });
    setDefaults({ workflowMaxParallel: 10 });
    engine.fill();
    expect(sm.sessions.map((s) => s.name).sort()).toEqual([`[${built.key}] implement-issue`, "[CK-1] plan-issue"].sort());
  });
});

describe("a person stepping in", () => {
  it("is told when an issue reaches a status that waits for them", async () => {
    setup({ ...RULES, "Plan Review": { ...GATE, notifyProviders: ["phone"] } });
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();
    moveAs(issue.key, "Plan Review", runActor(issue.key));
    expect(addInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({ title: `${issue.key} is waiting for you: Plan Review`, priority: "info", notifyProviders: ["phone"] }),
    );
  });

  it("stops a run when they move its issue somewhere else, and does not hold the issue", async () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();
    moveAs(issue.key, "Cancelled", USER);

    expect(sm.sessions[0].destroyed).toBe(true);
    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ status: "stopped", error: expect.stringContaining('moved to "Cancelled"') }]);
    expect(engine.liveRun(issue.key)).toBeUndefined();
    expect(getIssue(issue.key)).toMatchObject({ status: "Cancelled" });
    expect(getIssue(issue.key)?.attention).toBeUndefined();
    // A late idle from the session that was stopped changes nothing.
    sm.endTurn("s1");
    expect(loadWorkflowRuns(issue.key)).toHaveLength(1);
  });

  it("clears a hold when they move the issue, and runs it again when they put it back in the queue", async () => {
    setup(plan({ maxRetries: 0 }));
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();
    sm.get("s1").error?.("boom");
    await settle();
    expect(getIssue(issue.key)?.attention).toBeDefined();

    moveAs(issue.key, "Backlog", USER);
    expect(getIssue(issue.key)?.attention).toBeUndefined();
    moveAs(issue.key, "Refine Ready", USER);
    await settle();
    expect(sm.sessions).toHaveLength(2);
  });

  it("starts the count of runs over when they send an issue back into the queue", async () => {
    setup();
    const issue = makeIssue("Plan Review");
    for (let i = 0; i < WORKFLOW_MAX_WORK_RUNS; i++) {
      oldRun(issue, `old${i}`, {
        workStatus: "Refining",
        skill: "plan-issue",
        from: "Refine Ready",
        to: "Plan Review",
        startedAt: Date.now() - 1000 + i,
      });
    }
    engine.start();
    await settle();
    // The fifth send-back is still a person asking for the work again.
    moveAs(issue.key, "Refine Ready", USER);
    await settle();
    expect(sm.sessions).toHaveLength(1);
    expect(getIssue(issue.key)?.attention).toBeUndefined();
  });

  it("can stop a run, which holds the issue, and retry it", async () => {
    setup();
    const issue = makeIssue("Refine Ready");
    engine.start();
    await settle();

    const stopped = engine.stopRun(issue.key);
    expect(stopped).toMatchObject({ status: "stopped", error: "Stopped by you" });
    expect(sm.sessions[0].destroyed).toBe(true);
    const held = getIssue(issue.key) as Issue;
    expect(held.status).toBe("Refine Ready");
    expect(held.attention).toMatchObject({ reason: "Stopped by you.", runId: stopped.id });
    expect(engine.activity().attention).toMatchObject([
      { issueKey: issue.key, status: "Refine Ready", skill: "plan-issue", reason: "Stopped by you." },
    ]);
    await settle();
    expect(sm.sessions).toHaveLength(1);
    expect(() => engine.stopRun(issue.key)).toThrow(/No run is working/);

    engine.retry(issue.key);
    await settle();
    expect(sm.sessions).toHaveLength(2);
    expect(() => engine.retry(issue.key)).toThrow(/already working/);
  });

  it("can queue an issue left where an agent works with nothing working on it", () => {
    setup();
    const stranded = makeIssue("Refining");
    const retried = engine.retry(stranded.key);
    expect(retried.status).toBe("Refine Ready");
    engine.fill();
    expect(sm.sessions).toHaveLength(1);
  });

  it("refuses to retry what no agent works on", () => {
    setup();
    expect(() => engine.retry("CK-99")).toThrow(/not found/i);
    expect(() => engine.retry(makeIssue("Plan Review").key)).toThrow(/not at a status an agent works on/);
    expect(() => engine.retry(makeIssue("Backlog").key)).toThrow(/not at a status an agent works on/);
  });

  it("stops the runs and lets go of what was held when the project's workflow is removed", async () => {
    setup(plan({ maxRetries: 0 }));
    const held = makeIssue("Refine Ready", { createdAt: 1 });
    engine.start();
    await settle();
    sm.get("s1").error?.("boom");
    await settle();
    const running = makeIssue("Implementation Ready", { createdAt: 2 });
    await settle();
    expect(getIssue(held.key)?.attention).toBeDefined();
    expect(engine.liveRun(running.key)).toBeDefined();

    engine.forget(project.id);
    deleteWorkflow(project.id);
    expect(getIssue(held.key)?.attention).toBeUndefined();
    expect(engine.liveRun(running.key)).toBeUndefined();
    expect(sm.sessions[1].destroyed).toBe(true);
    expect(loadWorkflowRuns(running.key)).toMatchObject([{ status: "stopped", error: expect.stringContaining("workflow was removed") }]);
    await settle();
    expect(sm.sessions).toHaveLength(2);
  });
});

describe("after a restart", () => {
  function leftover(issue: Issue, id: string, startedAt: number, over: Partial<WorkflowRun> = {}): void {
    oldRun(issue, id, {
      workStatus: "Refining",
      skill: "plan-issue",
      sessionId: `gone-${id}`,
      status: "running",
      startedAt,
      from: "Refine Ready",
      to: undefined,
      messageCount: 0,
      ...over,
    });
  }

  it("closes a run that was cut short and puts its issue back to wait once", async () => {
    setup();
    const issue = makeIssue("Refining");
    leftover(issue, "cut", Date.now() - 5000);
    engine.start();

    expect(loadWorkflowRuns(issue.key)).toMatchObject([{ id: "cut", status: "failure", error: expect.stringContaining("restarted") }]);
    expect(getIssue(issue.key)).toMatchObject({ status: "Refine Ready" });
    expect(getIssue(issue.key)?.attention).toBeUndefined();
    await settle();
    expect(sm.sessions).toHaveLength(1);
  });

  it("holds an issue whose run was cut short twice running", async () => {
    setup();
    const issue = makeIssue("Refining");
    leftover(issue, "first", Date.now() - 9000, { status: "failure", error: "Cockpit restarted while this run was going" });
    leftover(issue, "second", Date.now() - 5000);
    engine.start();
    await settle();
    expect(getIssue(issue.key)).toMatchObject({
      status: "Refine Ready",
      attention: { reason: expect.stringContaining("restarted twice") },
    });
    expect(sm.sessions).toHaveLength(0);
  });

  it("closes the run and leaves alone an issue that has gone or moved on, or a run from before workflows ran skills", () => {
    setup();
    const moved = makeIssue("Done");
    leftover(moved, "moved", Date.now() - 5000);
    leftover({ ...moved, key: "CK-404" }, "orphan", Date.now() - 5000);
    const old = makeIssue("Refining");
    leftover(old, "stage", Date.now() - 5000, { workStatus: undefined as never, skill: undefined as never });
    engine.start();
    expect(loadWorkflowRuns(moved.key)[0].status).toBe("failure");
    expect(loadWorkflowRuns("CK-404")[0].status).toBe("failure");
    expect(getIssue(moved.key)).toMatchObject({ status: "Done" });
    expect(loadWorkflowRuns(old.key)[0].status).toBe("failure");
    expect(getIssue(old.key)).toMatchObject({ status: "Refining" });
  });
});

describe("the activity view", () => {
  it("is empty and marked off when workflows are off", () => {
    setup();
    makeIssue("Refine Ready");
    setDefaults({ workflowsEnabled: false });
    expect(engine.activity()).toEqual({
      enabled: false,
      paused: false,
      slots: { used: 0, max: 3 },
      running: [],
      queued: [],
      waiting: [],
      statuses: {},
      blocked: [],
      attention: [],
    });
  });

  it("shows what is waiting while paused, for a slot and for a person, and what each status is", () => {
    setup();
    const issue = makeIssue("Refine Ready");
    const yours = makeIssue("Plan Review", { title: "Read me" });
    makeIssue("Backlog");
    setDefaults({ workflowsPaused: true });
    expect(engine.activity()).toMatchObject({
      enabled: true,
      paused: true,
      waiting: [{ issueKey: yours.key, title: "Read me", status: "Plan Review" }],
      statuses: {
        [project.id]: [
          { status: "Refine Ready", kind: "queue", to: "Refining", skill: "plan-issue" },
          { status: "Refining", kind: "agent", skill: "plan-issue" },
          { status: "Plan Review", kind: "human", review: "plan" },
          { status: "Implementation Ready", kind: "agent", skill: "implement-issue" },
        ],
      },
      blocked: [],
      queued: [{ issueKey: issue.key, title: "Widget", status: "Refine Ready", skill: "plan-issue" }],
    });
  });
});
