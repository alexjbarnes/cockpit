import { describe, expect, it } from "vitest";
import type { WorkflowActivityView } from "@/lib/workflow-display";
import { activityIssues } from "@/lib/workflow-issues";
import type { Issue } from "@/types";

const issue = (key: string, projectId = "p1"): Issue => ({ key, projectId, title: `Issue ${key}` }) as Issue;
const row = (issueKey: string) => ({ issueKey, title: `Issue ${issueKey}`, projectId: "p1", status: "Refining" });

const view = (lists: Partial<Record<"running" | "queued" | "waiting" | "attention", { issueKey: string }[]>>) =>
  ({
    enabled: true,
    paused: false,
    slots: { used: 0, max: 1 },
    running: [],
    queued: [],
    waiting: [],
    attention: [],
    ...lists,
  }) as unknown as WorkflowActivityView;

describe("activityIssues", () => {
  const issues = [issue("CK-1"), issue("CK-2"), issue("CK-3"), issue("CK-4")];

  it("puts held and waiting issues in waiting, running and queued in active", () => {
    const { waiting, active } = activityIssues(
      view({ attention: [row("CK-1")], waiting: [row("CK-2")], running: [row("CK-3")], queued: [row("CK-4")] }),
      issues,
    );
    expect(waiting.map((i) => i.key)).toEqual(["CK-1", "CK-2"]);
    expect(active.map((i) => i.key)).toEqual(["CK-3", "CK-4"]);
  });

  it("keeps each list's order", () => {
    const { waiting } = activityIssues(view({ waiting: [row("CK-3"), row("CK-1")], attention: [row("CK-2")] }), issues);
    expect(waiting.map((i) => i.key)).toEqual(["CK-2", "CK-3", "CK-1"]);
  });

  it("gives an issue to one section only, a person's needing it first", () => {
    const { waiting, active } = activityIssues(
      view({ attention: [row("CK-1")], running: [row("CK-1")], waiting: [row("CK-2")], queued: [row("CK-2")] }),
      issues,
    );
    expect(waiting.map((i) => i.key)).toEqual(["CK-1", "CK-2"]);
    expect(active).toEqual([]);
  });

  it("skips an issue the page does not have", () => {
    const { waiting } = activityIssues(view({ waiting: [row("CK-9"), row("CK-2")] }), issues);
    expect(waiting.map((i) => i.key)).toEqual(["CK-2"]);
  });

  it("matches keys whatever their case", () => {
    const { waiting } = activityIssues(view({ waiting: [row("ck-1")] }), issues);
    expect(waiting.map((i) => i.key)).toEqual(["CK-1"]);
  });

  it("is empty without an activity view", () => {
    expect(activityIssues(null, issues)).toEqual({ waiting: [], active: [] });
    expect(activityIssues(undefined, issues)).toEqual({ waiting: [], active: [] });
  });
});
