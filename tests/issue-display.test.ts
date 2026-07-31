import { describe, expect, it } from "vitest";
import { actorLabel, describeActivity, filterIssues, groupIssuesByStatus, ISSUE_STATUSES, priorityLabel } from "@/lib/issue-display";
import type { Issue, IssueActivity, IssueActor } from "@/types";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    key: overrides.key ?? "CK-1",
    projectId: overrides.projectId ?? "proj-1",
    title: overrides.title ?? "Title",
    description: overrides.description ?? "",
    status: overrides.status ?? "Backlog",
    priority: overrides.priority,
    labels: overrides.labels,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    comments: overrides.comments ?? [],
    attachments: overrides.attachments ?? [],
    activity: overrides.activity ?? [],
  };
}

describe("filterIssues", () => {
  const issues = [
    makeIssue({ id: "a", projectId: "p1", status: "Backlog" }),
    makeIssue({ id: "b", projectId: "p1", status: "Done" }),
    makeIssue({ id: "c", projectId: "p2", status: "Backlog" }),
  ];

  it("returns every issue when the filter is empty", () => {
    expect(filterIssues(issues, {})).toEqual(issues);
  });

  it("narrows by projectId", () => {
    const result = filterIssues(issues, { projectId: "p1" });
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("excludes issues from other projects", () => {
    const result = filterIssues(issues, { projectId: "p2" });
    expect(result.map((i) => i.id)).toEqual(["c"]);
  });

  it("narrows by status", () => {
    const result = filterIssues(issues, { status: "Done" });
    expect(result.map((i) => i.id)).toEqual(["b"]);
  });

  it("excludes issues with a different status", () => {
    const result = filterIssues(issues, { status: "Cancelled" });
    expect(result).toEqual([]);
  });

  it("combines projectId and status filters", () => {
    const result = filterIssues(issues, { projectId: "p1", status: "Backlog" });
    expect(result.map((i) => i.id)).toEqual(["a"]);
  });
});

describe("groupIssuesByStatus", () => {
  it("returns an empty array for no issues", () => {
    expect(groupIssuesByStatus([])).toEqual([]);
  });

  it("groups multiple issues sharing a status together", () => {
    const issues = [makeIssue({ id: "a", status: "Backlog" }), makeIssue({ id: "b", status: "Backlog" })];
    const groups = groupIssuesByStatus(issues);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("Backlog");
    expect(groups[0].issues.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("orders groups by the canonical lifecycle order, not insertion order", () => {
    const issues = [makeIssue({ id: "done", status: "Done" }), makeIssue({ id: "backlog", status: "Backlog" })];
    const groups = groupIssuesByStatus(issues);
    expect(groups.map((g) => g.status)).toEqual(["Backlog", "Done"]);
  });

  it("drops statuses with zero issues", () => {
    const issues = [makeIssue({ status: "Accepted" })];
    const groups = groupIssuesByStatus(issues);
    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe("Accepted");
  });

  it("can produce every canonical status when every status has an issue", () => {
    const issues = ISSUE_STATUSES.map((status, i) => makeIssue({ id: String(i), status }));
    const groups = groupIssuesByStatus(issues);
    expect(groups.map((g) => g.status)).toEqual([...ISSUE_STATUSES]);
  });
});

describe("priorityLabel", () => {
  it("reads undefined as No priority", () => {
    expect(priorityLabel(undefined)).toBe("No priority");
  });

  it("reads 0 as No priority", () => {
    expect(priorityLabel(0)).toBe("No priority");
  });

  it("reads 1 as Urgent", () => {
    expect(priorityLabel(1)).toBe("Urgent");
  });

  it("reads 2 as High", () => {
    expect(priorityLabel(2)).toBe("High");
  });

  it("reads 3 as Medium", () => {
    expect(priorityLabel(3)).toBe("Medium");
  });

  it("reads 4 as Low", () => {
    expect(priorityLabel(4)).toBe("Low");
  });
});

describe("actorLabel", () => {
  it("labels the assistant", () => {
    expect(actorLabel({ kind: "assistant" })).toBe("Cockpit Assistant");
  });

  it("labels a job by its jobName", () => {
    expect(actorLabel({ kind: "job", jobId: "j1", jobName: "Nightly build", runId: "r1" })).toBe("Nightly build");
  });

  it("labels a session by its sessionName", () => {
    expect(actorLabel({ kind: "session", sessionId: "s1", sessionName: "My session" })).toBe("My session");
  });

  it("labels a UI user as You", () => {
    expect(actorLabel({ kind: "user" })).toBe("You");
  });

  it("falls back to Unknown for an actor kind outside the known union (defensive: forward-compat / corrupted data)", () => {
    const bogus = { kind: "future-kind" } as unknown as IssueActor;
    expect(actorLabel(bogus)).toBe("Unknown");
  });
});

describe("describeActivity", () => {
  const user: IssueActor = { kind: "user" };

  it("describes creation", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "created" };
    expect(describeActivity(entry)).toBe("You created this issue");
  });

  it("describes a comment", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "commented" };
    expect(describeActivity(entry)).toBe("You commented");
  });

  it("describes an attachment", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "attachment_added" };
    expect(describeActivity(entry)).toBe("You added an attachment");
  });

  it("describes a status change with from/to", () => {
    const entry: IssueActivity = {
      id: "1",
      createdAt: 1,
      actor: user,
      kind: "field_changed",
      field: "status",
      from: "Backlog",
      to: "Refined",
    };
    expect(describeActivity(entry)).toBe("You changed status from Backlog to Refined");
  });

  it("describes a priority change using priority labels, not raw numbers", () => {
    const entry: IssueActivity = {
      id: "1",
      createdAt: 1,
      actor: user,
      kind: "field_changed",
      field: "priority",
      from: undefined,
      to: 1,
    };
    expect(describeActivity(entry)).toBe("You changed priority from No priority to Urgent");
  });

  it("names the field for a title change", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "field_changed", field: "title" };
    expect(describeActivity(entry)).toBe("You changed the title");
  });

  it("names the field for a description change", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "field_changed", field: "description" };
    expect(describeActivity(entry)).toBe("You changed the description");
  });

  it("names the field for a labels change", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "field_changed", field: "labels" };
    expect(describeActivity(entry)).toBe("You changed the labels");
  });

  it("falls back to 'issue' when field_changed carries no field (defensive: malformed/legacy data)", () => {
    const entry: IssueActivity = { id: "1", createdAt: 1, actor: user, kind: "field_changed", field: undefined };
    expect(describeActivity(entry)).toBe("You changed the issue");
  });

  it("falls back to a generic line for a kind outside the known union (defensive: forward-compat / corrupted data)", () => {
    const entry = { id: "1", createdAt: 1, actor: user, kind: "future-kind" } as unknown as IssueActivity;
    expect(describeActivity(entry)).toBe("You updated this issue");
  });
});
