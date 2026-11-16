// How a workflow and an issue's place in it read on screen.

import { describe, expect, it } from "vitest";
import {
  agentStatuses,
  agentSummary,
  formatDuration,
  infoForStatus,
  issueFlows,
  newRule,
  queuesFor,
  ruleProblem,
  type StatusInfo,
  statusRows,
  statusTag,
  statusTagTitle,
  stopStates,
  stopSummary,
  trackPosition,
  trackStops,
  type WorkflowActivityView,
} from "@/lib/workflow-display";
import type { WorkflowStatusRule } from "@/types";

const RULES: Record<string, WorkflowStatusRule> = {
  "Refine Ready": { kind: "queue", to: "Refining" },
  Refining: { kind: "agent", skill: "plan-issue", next: ["Plan Review", "Needs Detail"], thinkingLevel: "high" },
  "Plan Review": {
    kind: "human",
    review: "plan",
    next: [
      { status: "Implementation Ready", label: "Approve", role: "approve" },
      { status: "Refine Ready", label: "Send back", role: "sendBack" },
    ],
  },
  "Implementation Ready": { kind: "agent", skill: "implement-issue", next: ["Code Review"] },
  "Code Review": { kind: "human", next: [{ status: "Accepted", label: "Accept" }] },
};
const ORDER = ["Backlog", "Refine Ready", "Refining", "Plan Review", "Implementation Ready", "Code Review", "Done"];

function activity(over: Partial<WorkflowActivityView> = {}): WorkflowActivityView {
  return { enabled: true, paused: false, slots: { used: 1, max: 2 }, running: [], queued: [], waiting: [], attention: [], ...over };
}

const row = (issueKey: string, status: string, skill?: string) => ({
  issueKey,
  title: issueKey,
  projectId: "p1",
  status,
  ...(skill ? { skill } : {}),
});

describe("an issue's state", () => {
  it("is read from the activity, and what needs a person wins", () => {
    const flows = issueFlows(
      activity({
        queued: [row("CK-1", "Refine Ready", "plan-issue"), row("CK-4", "Refine Ready", "plan-issue")],
        running: [{ ...row("CK-2", "Refining", "plan-issue"), runId: "r", sessionId: "s2", startedAt: 5 }],
        waiting: [row("CK-3", "Plan Review")],
        // Held and still listed as queued for a moment.
        attention: [{ ...row("CK-4", "Refine Ready", "plan-issue"), reason: "It broke", at: 9 }],
      }),
    );
    expect(flows.get("CK-1")).toEqual({ state: "queued", status: "Refine Ready", skill: "plan-issue" });
    expect(flows.get("CK-2")).toEqual({ state: "running", status: "Refining", skill: "plan-issue", sessionId: "s2", startedAt: 5 });
    expect(flows.get("CK-3")).toEqual({ state: "yours", status: "Plan Review" });
    expect(flows.get("CK-4")).toEqual({ state: "attention", status: "Refine Ready", skill: "plan-issue", reason: "It broke" });
    expect(issueFlows(null).size).toBe(0);
    expect(issueFlows(undefined).size).toBe(0);
  });
});

describe("how long something took", () => {
  it("is in seconds, minutes or hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(7_500_000)).toBe("2h 05m");
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(-1)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
  });
});

describe("what a status heading says", () => {
  const queue: StatusInfo = { status: "Refine Ready", kind: "queue", to: "Refining", skill: "plan-issue" };
  const agent: StatusInfo = { status: "Refining", kind: "agent", skill: "plan-issue" };
  const yours: StatusInfo = { status: "Plan Review", kind: "human", review: "plan" };

  it("is the project's own, or shared only when every project agrees", () => {
    const statuses = {
      p1: [queue, agent, yours],
      p2: [queue, { ...agent, skill: "other-plan" }, { status: "Plan Review", kind: "agent" as const, skill: "x" }],
    };
    expect(infoForStatus(statuses, "Refining", "p1")).toEqual(agent);
    expect(infoForStatus(statuses, "Refining", "p2")?.skill).toBe("other-plan");
    expect(infoForStatus(statuses, "Backlog", "p1")).toBeUndefined();
    expect(infoForStatus(statuses, "Refining", "nope")).toBeUndefined();
    // Across projects: the same everywhere, or nothing.
    expect(infoForStatus(statuses, "Refine Ready")).toEqual(queue);
    expect(infoForStatus(statuses, "Refining")).toBeUndefined();
    expect(infoForStatus(statuses, "Plan Review")).toBeUndefined();
    expect(infoForStatus(statuses, "Backlog")).toBeUndefined();
    expect(infoForStatus(undefined, "Refining")).toBeUndefined();
  });

  it("is a word or two, with the whole of it for a tooltip", () => {
    expect(statusTag(queue)).toBe("Queue");
    expect(statusTag(agent)).toBe("plan-issue");
    expect(statusTag({ status: "X", kind: "agent" })).toBe("Agent");
    expect(statusTag(yours)).toBe("Yours");
    expect(statusTagTitle(queue)).toBe('Issues here wait for an agent, then move to "Refining"');
    expect(statusTagTitle(agent)).toBe('An agent runs the "plan-issue" skill on issues here');
    expect(statusTagTitle({ ...agent, missing: true })).toContain('there is no "plan-issue" skill in the repo, so nothing starts');
    expect(statusTagTitle({ ...queue, missing: true })).toContain("so nothing starts");
    expect(statusTagTitle(yours)).toBe("Issues here wait for you to review the plan");
    expect(statusTagTitle({ status: "Code Review", kind: "human" })).toBe("Issues here wait for you");
  });
});

describe("the workflow page's rows", () => {
  it("are the board's statuses in order, with any the workflow names that the board lacks after them", () => {
    const rows = statusRows({ ...RULES, Triage: { kind: "human", next: [] } }, ORDER);
    expect(rows.map((r) => [r.status, r.rule?.kind])).toEqual([
      ["Backlog", undefined],
      ["Refine Ready", "queue"],
      ["Refining", "agent"],
      ["Plan Review", "human"],
      ["Implementation Ready", "agent"],
      ["Code Review", "human"],
      ["Done", undefined],
      ["Triage", "human"],
    ]);
    // A status is found by its own name only.
    expect(statusRows(RULES, ["toString"])[0]).toEqual({ status: "toString", rule: undefined });
  });

  it("know where an agent works and what queues for it", () => {
    expect(agentStatuses(RULES)).toEqual(["Refining", "Implementation Ready"]);
    expect(queuesFor(RULES, "Refining")).toEqual(["Refine Ready"]);
    expect(queuesFor(RULES, "Implementation Ready")).toEqual([]);
  });

  it("sum up an agent in a few words", () => {
    expect(agentSummary({ kind: "agent", skill: "s", next: ["x"] })).toBe("Default model");
    expect(
      agentSummary({ kind: "agent", skill: "s", next: ["x"], model: "opus", thinkingLevel: "high", permission: "ask", maxParallel: 1 }),
    ).toBe("opus · thinking high · asks you · 1 at once");
    expect(agentSummary({ kind: "agent", skill: "s", next: ["x"], model: "claude-opus", permission: "allowlist" }, "Opus")).toBe(
      "Opus · listed tools only",
    );
  });

  it("start a rule of each kind blank", () => {
    expect(newRule("queue")).toEqual({ kind: "queue", to: "" });
    expect(newRule("human")).toEqual({ kind: "human", next: [] });
    expect(newRule("agent")).toEqual({ kind: "agent", skill: "", next: [""], permission: "bypass" });
  });

  it("say what a rule still needs before it can be saved", () => {
    const rules: Record<string, WorkflowStatusRule> = {
      ...RULES,
      Q1: { kind: "queue", to: "" },
      Q2: { kind: "queue", to: "Plan Review" },
      A1: { kind: "agent", skill: "", next: ["Done"] },
      A2: { kind: "agent", skill: "s", next: [""] },
      H1: { kind: "human", review: "plan", next: [{ status: "Done", label: "Approve", role: "approve" }] },
      H2: { kind: "human", next: [] },
    };
    expect(ruleProblem(rules, "Q1")).toMatch(/Choose the status an agent works/);
    expect(ruleProblem(rules, "Q2")).toMatch(/No agent works in "Plan Review" yet/);
    expect(ruleProblem(rules, "A1")).toMatch(/Choose the skill/);
    expect(ruleProblem(rules, "A2")).toMatch(/Choose where the issue goes/);
    expect(ruleProblem(rules, "H1")).toMatch(/approving and where sending back/);
    for (const fine of ["H2", "Refine Ready", "Refining", "Plan Review", "Backlog"]) expect(ruleProblem(rules, fine), fine).toBeUndefined();
  });
});

describe("an issue's progress", () => {
  const stops = trackStops(RULES, ORDER);

  it("is drawn through where an agent works or a person decides, in board order", () => {
    expect(stops).toEqual([
      { status: "Refining", kind: "agent", skill: "plan-issue" },
      { status: "Plan Review", kind: "human", review: "plan" },
      { status: "Implementation Ready", kind: "agent", skill: "implement-issue" },
      { status: "Code Review", kind: "human" },
    ]);
    expect(stops.map(stopSummary)).toEqual([
      "An agent runs plan-issue",
      "Waits for you to review the plan",
      "An agent runs implement-issue",
      "Waits for you to decide",
    ]);
  });

  it("puts an issue in a queue at the stop it waits for", () => {
    expect(trackPosition(stops, RULES, "Refine Ready")).toBe(0);
    expect(trackPosition(stops, RULES, "Refining")).toBe(0);
    expect(trackPosition(stops, RULES, "Plan Review")).toBe(1);
    expect(trackPosition(stops, RULES, "Code Review")).toBe(3);
    expect(trackPosition(stops, RULES, "Backlog")).toBe(-1);
    expect(trackPosition(stops, RULES, "Done")).toBe(-1);
  });

  it("marks what is behind, here and ahead", () => {
    expect(stopStates(4, 1)).toEqual(["done", "current", "ahead", "ahead"]);
    expect(stopStates(3, -1)).toEqual(["ahead", "ahead", "ahead"]);
    expect(stopStates(0, 0)).toEqual([]);
  });
});
