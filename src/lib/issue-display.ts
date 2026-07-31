import type { Issue, IssueActivity, IssueActor, IssueStatus } from "@/types";
import { ISSUE_STATUSES } from "@/types";

// Re-exported for this module's existing consumers (the detail page's status
// dropdown, this file's own tests): the canonical array — and the lifecycle-
// order reasoning for why Cancelled sits last — now lives in types/index.ts
// alongside IssueStatus itself, so it can't drift into a second hand-written
// copy the way it already had once.
export { ISSUE_STATUSES };

export interface IssueFilter {
  projectId?: string;
  status?: IssueStatus;
}

/**
 * Pure filter backing the /issues list page's project/status dropdowns. Both
 * fields are optional — an absent one matches everything, so passing `{}`
 * returns every issue unchanged (by value, not by reference).
 */
export function filterIssues(issues: Issue[], filter: IssueFilter): Issue[] {
  return issues.filter((issue) => {
    if (filter.projectId && issue.projectId !== filter.projectId) return false;
    if (filter.status && issue.status !== filter.status) return false;
    return true;
  });
}

export interface IssueStatusGroup {
  status: IssueStatus;
  issues: Issue[];
}

/**
 * Groups issues by status in the canonical lifecycle order (ISSUE_STATUSES),
 * not insertion order, and drops any status with zero issues so the list
 * page never renders an empty group heading.
 */
export function groupIssuesByStatus(issues: Issue[]): IssueStatusGroup[] {
  const byStatus = new Map<IssueStatus, Issue[]>();
  for (const issue of issues) {
    const list = byStatus.get(issue.status);
    if (list) list.push(issue);
    else byStatus.set(issue.status, [issue]);
  }

  const groups: IssueStatusGroup[] = [];
  for (const status of ISSUE_STATUSES) {
    const list = byStatus.get(status);
    if (list && list.length > 0) groups.push({ status, issues: list });
  }
  return groups;
}

/**
 * Linear's 0-4 priority scale (see issue-tracker-spec.md 2.1: "so imports map
 * cleanly"). Both `undefined` (field omitted) and `0` read as "No priority" —
 * Linear itself treats unset and explicit-zero the same way, which is why the
 * issue detail page's priority control always sends a concrete 0 rather than
 * trying to clear the field (clearing would serialise to a dropped JSON key,
 * indistinguishable from "no patch at all" — see applyIssueUpdate's `"priority"
 * in patch` check in issue-storage.ts).
 */
export function priorityLabel(priority?: number): string {
  switch (priority) {
    case 1:
      return "Urgent";
    case 2:
      return "High";
    case 3:
      return "Medium";
    case 4:
      return "Low";
    default:
      return "No priority";
  }
}

/**
 * Human-readable name for whoever performed an activity entry or authored a
 * comment. Mirrors IssueActor's kind tag (types/index.ts). The `default` arm
 * is defensive, not dead code: this reads data straight off disk/the API
 * response, so a future actor kind (schema evolution) or a hand-edited issues
 * file must degrade to a safe label rather than throw on a missing field.
 */
export function actorLabel(actor: IssueActor): string {
  switch (actor.kind) {
    case "assistant":
      return "Cockpit Assistant";
    case "job":
      return actor.jobName;
    case "session":
      return actor.sessionName;
    case "user":
      return "You";
    default:
      return "Unknown";
  }
}

/**
 * One human-readable line for an activity-log entry (IssueActivity in
 * types/index.ts) — feeds the issue detail page's activity timeline.
 * `status`/`priority` get a from -> to description; the other diffable
 * fields (title/description/labels) just name the field, since their values
 * are too long or too structured to summarise inline. The `default` arm is
 * defensive for the same reason as actorLabel's.
 */
export function describeActivity(entry: IssueActivity): string {
  const who = actorLabel(entry.actor);
  switch (entry.kind) {
    case "created":
      return `${who} created this issue`;
    case "commented":
      return `${who} commented`;
    case "attachment_added":
      return `${who} added an attachment`;
    case "field_changed": {
      if (entry.field === "status") return `${who} changed status from ${entry.from} to ${entry.to}`;
      if (entry.field === "priority") {
        return `${who} changed priority from ${priorityLabel(entry.from as number | undefined)} to ${priorityLabel(entry.to as number | undefined)}`;
      }
      return `${who} changed the ${entry.field ?? "issue"}`;
    }
    default:
      return `${who} updated this issue`;
  }
}
