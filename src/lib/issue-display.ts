import type { Issue, IssueActivity, IssueActor, IssueStatus, Project } from "@/types";
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

export type QuickFilter = "active" | "backlog" | "all";

/**
 * Linear-style quick filter pills on the /issues page (both view modes).
 * "backlog" is the Backlog status alone; "active" is everything started or
 * queued behind it — neither Backlog nor a terminal status; "all" is a
 * no-op passthrough. There's no Linear "Triage" equivalent in cockpit's
 * ISSUE_STATUSES, so Backlog is the whole backlog-type set.
 */
export function filterByQuickFilter(issues: Issue[], filter: QuickFilter): Issue[] {
  if (filter === "backlog") return issues.filter((issue) => issue.status === "Backlog");
  if (filter === "active") {
    return issues.filter((issue) => issue.status !== "Backlog" && issue.status !== "Done" && issue.status !== "Cancelled");
  }
  return issues;
}

export interface IssueLabelGroup {
  label: string;
  issues: Issue[];
}

export interface IssueProjectGroup {
  project: Project;
  issues: Issue[];
  labelGroups: IssueLabelGroup[];
}

// Issues imported from Linear carry their original identifier (e.g.
// "ALE-609") as a label. It's never a real grouping label — excluding it
// keeps the project view from grouping half the board under stray import
// IDs instead of actual labels.
const IMPORT_LABEL_RE = /^ALE-\d+$/;

/** Sentinel bucket for an issue with no (real) label — sorted last in
 *  groupIssuesByLabel regardless of its count. Exported so the page can
 *  special-case its rendering (e.g. a neutral dot) without hand-duplicating
 *  the literal string. */
export const NO_LABEL_GROUP = "No label";

/**
 * The label an issue groups under in the project view: its first label,
 * skipping import-artifact labels (IMPORT_LABEL_RE) so an issue tagged
 * ["ALE-609", "Bug"] groups under "Bug", not the import id. An issue with no
 * labels — or only import-artifact ones — falls into NO_LABEL_GROUP. Never
 * returns more than one label per issue: this is a single value, not a set,
 * so an issue can only ever appear in one label sub-group.
 */
function groupingLabel(issue: Issue): string {
  return (issue.labels ?? []).find((label) => !IMPORT_LABEL_RE.test(label)) ?? NO_LABEL_GROUP;
}

function groupIssuesByLabel(issues: Issue[]): IssueLabelGroup[] {
  const byLabel = new Map<string, Issue[]>();
  for (const issue of issues) {
    const label = groupingLabel(issue);
    const list = byLabel.get(label);
    if (list) list.push(issue);
    else byLabel.set(label, [issue]);
  }

  return [...byLabel.entries()]
    .map(([label, labelIssues]) => ({ label, issues: labelIssues }))
    .sort((a, b) => {
      if (a.label === NO_LABEL_GROUP) return 1;
      if (b.label === NO_LABEL_GROUP) return -1;
      if (a.issues.length !== b.issues.length) return b.issues.length - a.issues.length;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Linear-mobile-style browse view: one group per project, ordered by name,
 * skipping any project with no issues in the input (a group only exists for
 * projects with matching issues — an issue whose projectId matches no known
 * project is silently dropped, same as the flat view's project-name lookup
 * degrading gracefully). Each project group holds label sub-groups (see
 * groupIssuesByLabel). Companion to groupIssuesByStatus for the /issues
 * page's "By project" view toggle; callers apply filterIssues/
 * filterByQuickFilter first, same as they do before groupIssuesByStatus.
 */
export function groupIssuesByProject(issues: Issue[], projects: Project[]): IssueProjectGroup[] {
  const byProject = new Map<string, Issue[]>();
  for (const issue of issues) {
    const list = byProject.get(issue.projectId);
    if (list) list.push(issue);
    else byProject.set(issue.projectId, [issue]);
  }

  const groups: IssueProjectGroup[] = [];
  for (const project of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
    const projectIssues = byProject.get(project.id);
    if (projectIssues && projectIssues.length > 0) {
      groups.push({ project, issues: projectIssues, labelGroups: groupIssuesByLabel(projectIssues) });
    }
  }
  return groups;
}

/**
 * Fixed, theme-safe palette (mid-toned Tailwind swatches read fine on both
 * light and dark backgrounds — they're solid dots, not text needing contrast
 * tuning) for the project view's label-group colour dots. Exported so tests
 * can assert membership without hand-duplicating this list.
 */
export const LABEL_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-cyan-500",
  "bg-sky-500",
  "bg-blue-500",
  "bg-violet-500",
  "bg-purple-500",
  "bg-fuchsia-500",
  "bg-pink-500",
  "bg-rose-500",
] as const;

/**
 * Deterministic label -> palette colour, via a small string hash (same idea
 * as a hashed avatar colour): the same label always renders the same dot,
 * with no per-label colour config to create or maintain as labels come and
 * go.
 */
export function labelColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length];
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
/** Job names are user-authored and unbounded; clip so one can't swallow an
 *  activity sentence. */
const ACTOR_NAME_MAX = 60;
function trimName(name: string): string {
  const flat = name.replace(/\s+/g, " ").trim();
  return flat.length > ACTOR_NAME_MAX ? `${flat.slice(0, ACTOR_NAME_MAX - 1).trimEnd()}…` : flat;
}

export function actorLabel(actor: IssueActor): string {
  switch (actor.kind) {
    case "assistant":
      return "Cockpit Assistant";
    case "job":
      return trimName(actor.jobName);
    case "session":
      // Deliberately not the session's name: cockpit auto-names sessions from
      // their first message, so the name is usually a prompt fragment that
      // adds nothing. The label links to the session (actorHref), which is
      // the real disambiguator.
      return "Session";
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
  return `${actorLabel(entry.actor)} ${describeActivityAction(entry)}`;
}

/**
 * The sentence minus its subject ("created this issue", "changed status from
 * A to B"), so the detail page can render the actor separately — a session
 * actor becomes a link to that session, which a single pre-joined string
 * cannot express.
 */
export function describeActivityAction(entry: IssueActivity): string {
  switch (entry.kind) {
    case "created":
      return "created this issue";
    case "commented":
      return "commented";
    case "attachment_added":
      return "added an attachment";
    case "field_changed": {
      if (entry.field === "status") return `changed status from ${entry.from} to ${entry.to}`;
      if (entry.field === "priority") {
        return `changed priority from ${priorityLabel(entry.from as number | undefined)} to ${priorityLabel(entry.to as number | undefined)}`;
      }
      return `changed the ${entry.field ?? "issue"}`;
    }
    default:
      return "updated this issue";
  }
}

/**
 * Where an actor can be opened, or undefined for the kinds that have no page
 * (user, assistant). A session links to its transcript in history view; the
 * session may have ended long ago, which is exactly what historyView renders.
 * A job links to its job page.
 */
export function actorHref(actor: IssueActor): string | undefined {
  switch (actor.kind) {
    case "session":
      return `/sessions/${actor.sessionId}?historyView=true`;
    case "job":
      return `/jobs/${actor.jobId}`;
    default:
      return undefined;
  }
}
