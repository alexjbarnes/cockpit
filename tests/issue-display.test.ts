import { describe, expect, it } from "vitest";
import {
  actorHref,
  actorLabel,
  describeActivity,
  describeActivityAction,
  filterByQuickFilter,
  filterIssues,
  groupIssuesByProject,
  groupIssuesByStatus,
  ISSUE_STATUSES,
  LABEL_COLORS,
  labelColor,
  NO_LABEL_GROUP,
  priorityLabel,
} from "@/lib/issue-display";
import type { Issue, IssueActivity, IssueActor, Project } from "@/types";

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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? "proj-1",
    name: overrides.name ?? "Project",
    prefix: overrides.prefix ?? "PRJ",
    description: overrides.description,
    repoPath: overrides.repoPath,
    archived: overrides.archived,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    nextNumber: overrides.nextNumber ?? 1,
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

describe("filterByQuickFilter", () => {
  const issues = [
    makeIssue({ id: "a", status: "Backlog" }),
    makeIssue({ id: "b", status: "Refining" }),
    makeIssue({ id: "c", status: "Accepted" }),
    makeIssue({ id: "d", status: "Done" }),
    makeIssue({ id: "e", status: "Cancelled" }),
  ];

  it("all returns every issue unchanged", () => {
    expect(filterByQuickFilter(issues, "all")).toEqual(issues);
  });

  it("backlog keeps only Backlog-status issues", () => {
    expect(filterByQuickFilter(issues, "backlog").map((i) => i.id)).toEqual(["a"]);
  });

  it("active keeps started/unstarted work, excluding Backlog, Done, and Cancelled", () => {
    expect(filterByQuickFilter(issues, "active").map((i) => i.id)).toEqual(["b", "c"]);
  });
});

describe("groupIssuesByProject", () => {
  it("returns an empty array for no issues", () => {
    expect(groupIssuesByProject([], [makeProject()])).toEqual([]);
  });

  it("excludes projects with zero matching issues", () => {
    const projects = [makeProject({ id: "p1", name: "Alpha" }), makeProject({ id: "p2", name: "Beta" })];
    const issues = [makeIssue({ id: "a", projectId: "p1" })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups.map((g) => g.project.id)).toEqual(["p1"]);
  });

  it("orders project groups by name, not id or insertion order", () => {
    const projects = [makeProject({ id: "p1", name: "Zeta" }), makeProject({ id: "p2", name: "Alpha" })];
    const issues = [makeIssue({ id: "a", projectId: "p1" }), makeIssue({ id: "b", projectId: "p2" })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups.map((g) => g.project.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("drops issues whose projectId matches no known project", () => {
    const projects = [makeProject({ id: "p1", name: "Alpha" })];
    const issues = [makeIssue({ id: "a", projectId: "p1" }), makeIssue({ id: "b", projectId: "ghost" })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups).toHaveLength(1);
    expect(groups[0].issues.map((i) => i.id)).toEqual(["a"]);
  });

  it("carries the project's full issue count alongside its label sub-groups", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1" }), makeIssue({ id: "b", projectId: "p1" })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].issues).toHaveLength(2);
  });

  it("groups an issue under its first label", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: ["Bug", "UI"] })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual(["Bug"]);
  });

  it("never lists a multi-label issue under more than one label", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: ["Bug", "UI"] })];
    const groups = groupIssuesByProject(issues, projects);
    const allIds = groups[0].labelGroups.flatMap((g) => g.issues.map((i) => i.id));
    expect(allIds).toEqual(["a"]);
  });

  it("skips ALE-<number> import labels when choosing the grouping label", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: ["ALE-609", "Bug"] })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual(["Bug"]);
  });

  it("buckets an issue with only an ALE-<number> label under No label, not the import id", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: ["ALE-609"] })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual([NO_LABEL_GROUP]);
  });

  it("buckets an issue with no labels at all under No label", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: undefined })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual([NO_LABEL_GROUP]);
  });

  it("sorts No label after a real label when the real label is encountered first", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: ["Bug"] }), makeIssue({ id: "b", projectId: "p1", labels: [] })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual(["Bug", NO_LABEL_GROUP]);
  });

  it("sorts No label after a real label when No label is encountered first", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [makeIssue({ id: "a", projectId: "p1", labels: [] }), makeIssue({ id: "b", projectId: "p1", labels: ["Bug"] })];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual(["Bug", NO_LABEL_GROUP]);
  });

  it("orders label groups by count descending, then name ascending, with No label always last", () => {
    const projects = [makeProject({ id: "p1" })];
    const issues = [
      makeIssue({ id: "a", projectId: "p1", labels: ["Zeta"] }),
      makeIssue({ id: "b", projectId: "p1", labels: ["Bug"] }),
      makeIssue({ id: "c", projectId: "p1", labels: ["Bug"] }),
      makeIssue({ id: "d", projectId: "p1", labels: [] }),
      makeIssue({ id: "e", projectId: "p1", labels: ["Alpha"] }),
      makeIssue({ id: "f", projectId: "p1", labels: ["Alpha"] }),
    ];
    const groups = groupIssuesByProject(issues, projects);
    expect(groups[0].labelGroups.map((g) => g.label)).toEqual(["Alpha", "Bug", "Zeta", NO_LABEL_GROUP]);
    expect(groups[0].labelGroups.map((g) => g.issues.length)).toEqual([2, 2, 1, 1]);
  });
});

describe("labelColor", () => {
  it("is deterministic for the same label", () => {
    expect(labelColor("Bug")).toBe(labelColor("Bug"));
  });

  it("always returns a colour from the fixed palette, including for an empty label", () => {
    expect(LABEL_COLORS).toContain(labelColor("Bug"));
    expect(LABEL_COLORS).toContain(labelColor(""));
  });

  it("varies across different labels", () => {
    const colors = new Set(["Bug", "UI", "Backend", "Docs", "Chore"].map(labelColor));
    expect(colors.size).toBeGreaterThan(1);
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

  it("labels a session generically, never by its auto-generated name", () => {
    expect(actorLabel({ kind: "session", sessionId: "s1", sessionName: "My session" })).toBe("Session");
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
      to: "Refining",
    };
    expect(describeActivity(entry)).toBe("You changed status from Backlog to Refining");
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

describe("actorLabel", () => {
  const longName =
    "Perfect looks good now. Next sometimes when I go to an article I've never opened before it will be already scrolled half";

  it("labels every session actor generically — the session name is a prompt fragment, the link disambiguates", () => {
    expect(actorLabel({ kind: "session", sessionId: "s1", sessionName: longName })).toBe("Session");
    expect(actorLabel({ kind: "session", sessionId: "s1", sessionName: "Fix login bug" })).toBe("Session");
  });

  it("keeps a short job name untouched", () => {
    expect(actorLabel({ kind: "job", jobId: "j1", jobName: "Nightly roundup", runId: "r1" })).toBe("Nightly roundup");
  });

  it("truncates a long job name and collapses its whitespace", () => {
    const label = actorLabel({ kind: "job", jobId: "j1", jobName: longName, runId: "r1" });
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(actorLabel({ kind: "job", jobId: "j1", jobName: "line one\n\nline   two", runId: "r1" })).toBe("line one line two");
  });

  it("flows through describeActivity so the sentence stays readable", () => {
    const line = describeActivity({
      id: "1",
      createdAt: 1,
      actor: { kind: "session", sessionId: "s1", sessionName: longName },
      kind: "commented",
    });
    expect(line).toBe("Session commented");
  });
});

describe("actorHref", () => {
  it("links a session actor to its transcript in history view", () => {
    expect(actorHref({ kind: "session", sessionId: "abc-123", sessionName: "n" })).toBe("/sessions/abc-123?historyView=true");
  });

  it("links a job actor to its job page", () => {
    expect(actorHref({ kind: "job", jobId: "j-9", jobName: "n", runId: "r" })).toBe("/jobs/j-9");
  });

  it("gives user and assistant actors no link", () => {
    expect(actorHref({ kind: "user" })).toBeUndefined();
    expect(actorHref({ kind: "assistant" })).toBeUndefined();
  });
});

describe("describeActivityAction", () => {
  it("is describeActivity minus the actor, for every kind", () => {
    const actor = { kind: "user" as const };
    const entries = [
      { id: "1", createdAt: 1, actor, kind: "created" as const },
      { id: "2", createdAt: 1, actor, kind: "commented" as const },
      { id: "3", createdAt: 1, actor, kind: "attachment_added" as const },
      { id: "4", createdAt: 1, actor, kind: "field_changed" as const, field: "status" as const, from: "Backlog", to: "Refining" },
      { id: "5", createdAt: 1, actor, kind: "field_changed" as const, field: "priority" as const, from: 0, to: 2 },
      { id: "6", createdAt: 1, actor, kind: "field_changed" as const, field: "labels" as const },
    ];
    for (const e of entries) {
      expect(describeActivity(e)).toBe(`You ${describeActivityAction(e)}`);
    }
  });
});
