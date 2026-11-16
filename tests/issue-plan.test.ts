// An issue's plan: versions written by agents and people, a person's review of
// the newest one, and what each does to the issue. Runs against real storage
// in a tmpdir, and through the route handlers for the HTTP shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_NOTES_HEADING } from "@/lib/plan-review/feedback";
import type { PlanAnnotation } from "@/lib/plan-review/types";
import { onIssueStatusChange } from "@/server/issue-events";
import { IssuePlanError, readIssuePlan, reviewIssuePlan, saveIssuePlanDraft, writeIssuePlan } from "@/server/issue-plan";
import { buildIssue, buildProject, deleteIssue, getIssue, saveIssue, saveProject } from "@/server/issue-storage";
import { readPlanRecord } from "@/server/plan-review-storage";
import { setProjectWorkflow } from "@/server/workflow-storage";
import type { Issue, IssueActor } from "@/types";

vi.mock("@/server/auth", () => ({
  validateSession: (token: string) => token === "valid",
}));

const AGENT: IssueActor = { kind: "session", sessionId: "s1", sessionName: "planner" };
const USER: IssueActor = { kind: "user" };
const PLAN = "# Add a widget\n\nBuild the widget.\nTest the widget.\n";

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cockpit-issueplan-"));
  prevConfigDir = process.env.COCKPIT_CONFIG_DIR;
  process.env.COCKPIT_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.COCKPIT_CONFIG_DIR;
  else process.env.COCKPIT_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeIssue(status = "Plan Review", projectPatch: Parameters<typeof buildProject>[0] = { name: "Cockpit", prefix: "CK" }): Issue {
  const project = buildProject(projectPatch);
  saveProject(project);
  const issue = { ...buildIssue({ projectId: project.id, title: "Widget", description: "We need a widget." }, USER), status };
  saveIssue(issue);
  return issue;
}

function note(body: string, id = "n1"): PlanAnnotation {
  return { id, kind: "note", quote: "", prefix: "", suffix: "", body, createdAt: 1 };
}

function comment(quote: string, body: string, id = "c1"): PlanAnnotation {
  return { id, kind: "comment", quote, prefix: "", suffix: "", body, createdAt: 1 };
}

describe("writing an issue's plan", () => {
  it("keeps each new text as the next version and leaves the description alone", () => {
    const issue = makeIssue();
    const first = writeIssuePlan(issue.key, PLAN, AGENT, 100);
    expect(first).toMatchObject({ created: true, version: { n: 1, author: AGENT } });
    expect(writeIssuePlan(issue.key, PLAN, AGENT, 200)).toMatchObject({ created: false, version: { n: 1 } });
    expect(writeIssuePlan(issue.key, `${PLAN}Ship it.\n`, USER, 300)).toMatchObject({ created: true, version: { n: 2, author: USER } });

    const stored = getIssue(issue.key);
    expect(stored?.description).toBe("We need a widget.");
    expect(stored?.status).toBe("Plan Review");
    expect(stored?.updatedAt).toBe(300);
    expect(stored?.activity.filter((a) => a.kind === "plan_written").map((a) => [a.planVersion, a.actor.kind])).toEqual([
      [1, "session"],
      [2, "user"],
    ]);
  });

  it("says which version is waiting and where a decision sends the issue", () => {
    const issue = makeIssue();
    expect(readIssuePlan(issue.key)).toMatchObject({ versions: [], draft: null, reviewable: null });
    writeIssuePlan(issue.key, PLAN, AGENT);
    expect(readIssuePlan(issue.key)).toMatchObject({
      reviewable: 1,
      targets: { approve: "Implementation Ready", sendBack: "Refine Ready" },
    });
  });

  it("refuses an empty plan, one that is too long, and an unknown issue", () => {
    const issue = makeIssue();
    expect(() => writeIssuePlan(issue.key, "   ", AGENT)).toThrow(/non-empty/);
    expect(() => writeIssuePlan(issue.key, 12, AGENT)).toThrow(IssuePlanError);
    expect(() => writeIssuePlan(issue.key, "x".repeat(200_001), AGENT)).toThrow(/longer than/);
    expect(() => writeIssuePlan("CK-99", PLAN, AGENT)).toThrow(/not found/i);
    expect(() => readIssuePlan("NOPE-1")).toThrow(/not found/i);
    expect(getIssue(issue.key)?.activity.some((a) => a.kind === "plan_written")).toBe(false);
  });

  it("is deleted with its issue", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT);
    expect(readPlanRecord({ kind: "issue", key: issue.key }).versions).toHaveLength(1);
    expect(deleteIssue(issue.key)).toBe(true);
    expect(readPlanRecord({ kind: "issue", key: issue.key }).versions).toHaveLength(0);
  });
});

describe("a draft on an issue's plan", () => {
  it("is stored against its version and cleared by null", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT);
    const stored = saveIssuePlanDraft(issue.key, { version: 1, annotations: [note("Think about tests")], updatedAt: 5 });
    expect(stored).toMatchObject({ version: 1, annotations: [{ body: "Think about tests" }] });
    expect(readIssuePlan(issue.key).draft).toMatchObject({ version: 1 });
    expect(saveIssuePlanDraft(issue.key, null)).toBeNull();
    expect(readIssuePlan(issue.key).draft).toBeNull();
    expect(() => saveIssuePlanDraft("CK-99", null)).toThrow(/not found/i);
  });
});

describe("sending an issue's plan back", () => {
  it("keeps the review on the version, posts the feedback, and returns the issue to be planned again", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT, 100);
    saveIssuePlanDraft(issue.key, { version: 1, annotations: [note("draft")], updatedAt: 150 });
    const moves: string[] = [];
    const off = onIssueStatusChange((e) => moves.push(`${e.from}>${e.to}`));

    const result = reviewIssuePlan(
      issue.key,
      { version: 1, action: "request_changes", annotations: [comment("Test the widget.", "Say how")] },
      USER,
      200,
    );
    off();

    expect(result.issue.status).toBe("Refine Ready");
    expect(moves).toEqual(["Plan Review>Refine Ready"]);
    const version = result.plan.versions[0];
    expect(version.review).toMatchObject({ outcome: "changes_requested", reviewer: USER, reviewedAt: 200 });
    expect(version.review?.feedback).toContain("Say how");
    expect(version.review?.annotations).toHaveLength(1);
    // Nothing is waiting any more, and the markup that became the review is spent.
    expect(result.plan.reviewable).toBeNull();
    expect(result.plan.draft).toBeNull();

    const stored = getIssue(issue.key);
    expect(stored?.description).toBe("We need a widget.");
    expect(stored?.comments).toHaveLength(1);
    expect(stored?.comments[0].body).toMatch(/^\*\*Plan version 1: changes requested\*\*/);
    expect(stored?.comments[0].body).toContain("Say how");
    expect(stored?.activity.find((a) => a.kind === "plan_reviewed")).toMatchObject({ planVersion: 1, planOutcome: "changes_requested" });
  });

  it("sends the reviewer's own edits as a diff", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT);
    const result = reviewIssuePlan(
      issue.key,
      { version: 1, action: "request_changes", editedText: PLAN.replace("Test the widget.", "Test it twice.") },
      USER,
    );
    expect(result.plan.versions[0].review?.feedback).toContain("+Test it twice.");
    // An edit sent back is feedback, not a version: the agent writes the next one.
    expect(result.plan.versions).toHaveLength(1);
  });

  it("refuses to send back with nothing said", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT);
    expect(() => reviewIssuePlan(issue.key, { version: 1, action: "request_changes", annotations: [], editedText: PLAN }, USER)).toThrow(
      /Say what should change/,
    );
    expect(getIssue(issue.key)?.status).toBe("Plan Review");
    expect(readIssuePlan(issue.key).reviewable).toBe(1);
  });
});

describe("approving an issue's plan", () => {
  it("records the approval and moves the issue on to be implemented", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT, 100);
    const result = reviewIssuePlan(issue.key, { version: 1, action: "approve" }, USER, 200);

    expect(result.issue.status).toBe("Implementation Ready");
    expect(result.plan.versions).toHaveLength(1);
    expect(result.plan.versions[0].review).toMatchObject({ outcome: "approved", feedback: "" });
    expect(result.plan.reviewable).toBeNull();
    expect(result.issue.comments).toHaveLength(0);
    expect(result.issue.activity.filter((a) => a.kind === "plan_reviewed")).toMatchObject([{ planVersion: 1, planOutcome: "approved" }]);
  });

  it("keeps an edited plan with notes as the reviewer's own version", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT, 100);
    const edited = PLAN.replace("Build the widget.", "Build the widget in Go.");
    const result = reviewIssuePlan(
      issue.key,
      { version: 1, action: "approve", editedText: edited, annotations: [note("Mind the cache")] },
      USER,
      200,
    );

    expect(result.plan.versions.map((v) => [v.n, v.author?.kind, v.review?.outcome])).toEqual([
      [1, "session", "approved"],
      [2, "user", "approved"],
    ]);
    expect(result.plan.versions[1].content).toContain("Build the widget in Go.");
    expect(result.plan.versions[1].content).toContain(PLAN_NOTES_HEADING);
    expect(result.plan.versions[1].content).toContain("Mind the cache");
    expect(result.plan.reviewable).toBeNull();
    expect(result.issue.comments[0].body).toMatch(/^\*\*Plan version 1: approved with notes\*\*/);
    expect(result.issue.activity.slice(-4).map((a) => [a.kind, a.planVersion ?? a.field])).toEqual([
      ["commented", undefined],
      ["plan_written", 2],
      ["plan_reviewed", 1],
      ["field_changed", "status"],
    ]);
  });

  it("leaves the issue where it is when its project hides the next status", () => {
    const issue = makeIssue("Plan Review", { name: "Small", prefix: "SM", disabledStatuses: ["Implementation Ready"] });
    writeIssuePlan(issue.key, PLAN, AGENT);
    const result = reviewIssuePlan(issue.key, { version: 1, action: "approve" }, USER);
    expect(result.issue.status).toBe("Plan Review");
    expect(result.plan.versions[0].review?.outcome).toBe("approved");
  });
});

describe("where a review sends an issue whose project has a workflow", () => {
  function withWorkflow(statuses: Record<string, unknown>, status = "Design Review"): Issue {
    const project = buildProject({
      name: "Custom",
      prefix: "CU",
      customStatuses: [{ name: "Design Review" }, { name: "Build Queue" }, { name: "Rethink" }],
    });
    saveProject(project);
    setProjectWorkflow(project, { statuses });
    const issue = { ...buildIssue({ projectId: project.id, title: "Widget", description: "We need a widget." }, USER), status };
    saveIssue(issue);
    return issue;
  }

  it("follows the choices the plan's status marks as approval and send-back", () => {
    const issue = withWorkflow({
      "Design Review": {
        kind: "human",
        review: "plan",
        next: [
          { status: "Rethink", label: "Send back", role: "sendBack" },
          { status: "Build Queue", label: "Approve", role: "approve" },
        ],
      },
    });
    writeIssuePlan(issue.key, PLAN, AGENT);
    expect(readIssuePlan(issue.key).targets).toEqual({ approve: "Build Queue", sendBack: "Rethink" });
    const sent = reviewIssuePlan(issue.key, { version: 1, action: "request_changes", annotations: [note("No")] }, USER);
    expect(sent.issue.status).toBe("Rethink");
    saveIssue({ ...sent.issue, status: "Design Review" });
    writeIssuePlan(issue.key, `${PLAN}\n\nRevised.`, AGENT);
    expect(reviewIssuePlan(issue.key, { version: 2, action: "approve" }, USER).issue.status).toBe("Build Queue");
  });

  it("falls back to the built-in pair when the workflow has no plan review", () => {
    const issue = withWorkflow({ "Design Review": { kind: "human", next: ["Build Queue"] } });
    expect(readIssuePlan(issue.key).targets).toEqual({ approve: "Implementation Ready", sendBack: "Refine Ready" });
  });
});

describe("a review that cannot stand", () => {
  it("is refused when the version is no longer the newest", () => {
    const issue = makeIssue();
    writeIssuePlan(issue.key, PLAN, AGENT);
    writeIssuePlan(issue.key, `${PLAN}More.\n`, AGENT);
    let error: unknown;
    try {
      reviewIssuePlan(issue.key, { version: 1, action: "approve" }, USER);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(IssuePlanError);
    expect((error as IssuePlanError).status).toBe(409);
    expect((error as IssuePlanError).message).toMatch(/version 2 replaced it/);
    expect(getIssue(issue.key)?.status).toBe("Plan Review");
  });

  it("is refused twice on one version, with no plan, and when malformed", () => {
    const issue = makeIssue();
    expect(() => reviewIssuePlan(issue.key, { version: 1, action: "approve" }, USER)).toThrow(/no plan to review/);
    writeIssuePlan(issue.key, PLAN, AGENT);
    expect(() => reviewIssuePlan(issue.key, { version: 1, action: "merge" }, USER)).toThrow(/action must be/);
    expect(() => reviewIssuePlan(issue.key, { version: "1", action: "approve" }, USER)).toThrow(/version must be/);
    expect(() => reviewIssuePlan("CK-99", { version: 1, action: "approve" }, USER)).toThrow(/not found/i);
    reviewIssuePlan(issue.key, { version: 1, action: "approve" }, USER);
    expect(() => reviewIssuePlan(issue.key, { version: 1, action: "approve" }, USER)).toThrow(/already been reviewed/);
  });
});

function req(url: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    headers: { ...(init.auth === false ? {} : { cookie: "cockpit_session=valid" }), "content-type": "application/json" },
  });
}

describe("the issue plan routes", () => {
  const at = (key: string) => ({ params: Promise.resolve({ key }) });

  it("write, read, draft and review a plan over HTTP", async () => {
    const issue = makeIssue();
    const { GET, POST } = await import("@/app/api/issues/[key]/plan/route");
    const { PUT } = await import("@/app/api/issues/[key]/plan/draft/route");
    const review = await import("@/app/api/issues/[key]/plan/review/route");
    const base = `http://localhost/api/issues/${issue.key}/plan`;

    const written = await POST(req(base, { method: "POST", body: { content: PLAN } }), at(issue.key));
    expect(written.status).toBe(201);
    expect(await written.json()).toMatchObject({ created: true, version: { n: 1, author: { kind: "user" } }, plan: { reviewable: 1 } });

    const drafted = await PUT(
      req(`${base}/draft`, { method: "PUT", body: { draft: { version: 1, annotations: [note("hm")], updatedAt: 9 } } }),
      at(issue.key),
    );
    expect((await drafted.json()).draft).toMatchObject({ version: 1 });

    const read = await GET(req(base), at(issue.key));
    expect(await read.json()).toMatchObject({ versions: [{ n: 1 }], draft: { version: 1 }, reviewable: 1 });

    const cleared = await PUT(req(`${base}/draft`, { method: "PUT", body: { draft: null } }), at(issue.key));
    expect(await cleared.json()).toEqual({ draft: null });

    const sent = await review.POST(
      req(`${base}/review`, { method: "POST", body: { version: 1, action: "request_changes", annotations: [note("Split it")] } }),
      at(issue.key),
    );
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ issue: { status: "Refine Ready" }, plan: { reviewable: null } });
  });

  it("answer with the status a refusal names", async () => {
    const issue = makeIssue();
    const { GET, POST } = await import("@/app/api/issues/[key]/plan/route");
    const { PUT } = await import("@/app/api/issues/[key]/plan/draft/route");
    const review = await import("@/app/api/issues/[key]/plan/review/route");
    const base = `http://localhost/api/issues/${issue.key}/plan`;

    expect((await GET(req(base), at("CK-99"))).status).toBe(404);
    expect((await POST(req(base, { method: "POST", body: { content: "" } }), at(issue.key))).status).toBe(400);
    expect((await POST(req(base, { method: "POST" }), at(issue.key))).status).toBe(400);
    expect((await PUT(req(`${base}/draft`, { method: "PUT", body: {} }), at(issue.key))).status).toBe(400);
    expect((await PUT(req(`${base}/draft`, { method: "PUT", body: { draft: { version: "x" } } }), at(issue.key))).status).toBe(400);
    expect((await review.POST(req(`${base}/review`, { method: "POST" }), at(issue.key))).status).toBe(400);
    expect(
      (await review.POST(req(`${base}/review`, { method: "POST", body: { version: 1, action: "approve" } }), at(issue.key))).status,
    ).toBe(404);

    writeIssuePlan(issue.key, PLAN, AGENT);
    writeIssuePlan(issue.key, `${PLAN}More.\n`, AGENT);
    const stale = await review.POST(req(`${base}/review`, { method: "POST", body: { version: 1, action: "approve" } }), at(issue.key));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatch(/replaced it/);
  });

  it("refuse a caller who is not signed in", async () => {
    const issue = makeIssue();
    const { GET, POST } = await import("@/app/api/issues/[key]/plan/route");
    const { PUT } = await import("@/app/api/issues/[key]/plan/draft/route");
    const review = await import("@/app/api/issues/[key]/plan/review/route");
    const base = `http://localhost/api/issues/${issue.key}/plan`;
    expect((await GET(req(base, { auth: false }), at(issue.key))).status).toBe(401);
    expect((await POST(req(base, { method: "POST", body: { content: PLAN }, auth: false }), at(issue.key))).status).toBe(401);
    expect((await PUT(req(`${base}/draft`, { method: "PUT", body: { draft: null }, auth: false }), at(issue.key))).status).toBe(401);
    expect((await review.POST(req(`${base}/review`, { method: "POST", body: {}, auth: false }), at(issue.key))).status).toBe(401);
    expect(readIssuePlan(issue.key).versions).toHaveLength(0);
  });
});
