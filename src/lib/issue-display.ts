import type { Issue, IssueActivity, IssueActor, Project } from "@/types";
import { ISSUE_STATUSES } from "@/types";

// Re-exported for this module's existing consumers (the detail page's status
// dropdown, this file's own tests): the canonical array — and the lifecycle-
// order reasoning for why Cancelled sits last — now lives in types/index.ts
// alongside IssueStatus itself, so it can't drift into a second hand-written
// copy the way it already had once.
export { ISSUE_STATUSES };

export interface IssueFilter {
  projectId?: string;
  status?: string;
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
  status: string;
  issues: Issue[];
}

/**
 * The order issues appear in inside one status group. Numbered issues
 * (`Issue.order`, set by a drag) come first in that order; unnumbered ones
 * follow in the array order they arrived in, which is what every list showed
 * before any of this existed — so nothing moves until a group is first
 * dragged.
 *
 * A partition rather than `(a.order ?? Infinity) - (b.order ?? Infinity)`,
 * which compares `NaN` between two unnumbered issues and leans on the engine
 * happening to keep them put.
 */
export function sortIssuesByOrder(issues: Issue[]): Issue[] {
  return rankIssues(issues).map((entry) => entry.issue);
}

/** The rank each issue currently sorts by: numbered issues keep their `order`,
 *  and unnumbered ones are imagined after all of them, a step apart, in the
 *  order they arrived. Sorting by this is the same as "numbered first in their
 *  order, then the rest as they came" — but it also gives a drag something to
 *  land *between*, including after an issue that has never been numbered. */
export function effectiveOrders(issues: Issue[]): Map<string, number> {
  return new Map(rankIssues(issues).map((entry) => [entry.issue.id, entry.rank]));
}

function rankIssues(issues: Issue[]): { issue: Issue; rank: number }[] {
  const numbered = issues.filter((issue) => typeof issue.order === "number");
  const top = numbered.reduce((max, issue) => Math.max(max, issue.order as number), 0);
  const ranked = issues.map((issue) => ({ issue, rank: typeof issue.order === "number" ? issue.order : 0 }));
  // Unnumbered issues are imagined after everything numbered, a step apart in
  // the order they arrived — which is exactly where the old "numbered first,
  // then the rest" rule put them, but now expressible as one rank so a drop can
  // land after one of them.
  let next = top;
  for (const entry of ranked) {
    if (typeof entry.issue.order !== "number") {
      next += ORDER_STEP;
      entry.rank = next;
    }
  }
  return ranked.sort((a, b) => a.rank - b.rank);
}

/** What a drop asks the server to do: put `key` in `status`, between the two
 *  keys the user saw around it. Either neighbour may be absent, which means the
 *  top or the bottom of that status. `index` is the client's own copy of the
 *  same thing — the position within the group it can see — used to render the
 *  drop before the server answers; it is not sent. */
export interface IssuePlacement {
  key: string;
  status: string;
  index?: number;
  beforeKey?: string;
  afterKey?: string;
}

/** The gap the server leaves between issues when it numbers a status. */
export const ORDER_STEP = 1000;

/**
 * The index a drop lands at, for `placementAt`: the slot the hovered row holds
 * in its group as the user is looking at it, which is where the moved issue
 * goes.
 *
 * Read off the group with the moved issue still in it. Every index taken from
 * the shortened group is one less than that for each row below the moved one,
 * so it is right for a drag upwards and short for a drag downwards — the whole
 * "it lands a row or two away from where I put it" bug. Null when the drop was
 * not on a row at all (an empty group's own body), which means the end.
 */
export function dropIndex(issues: Issue[], targetStatus: string, overId: string): number | null {
  const group = sortIssuesByOrder(issues.filter((issue) => issue.status === targetStatus));
  const index = group.findIndex((issue) => issue.id === overId || issue.key === overId);
  return index < 0 ? null : index;
}

/**
 * The placement for a key dropped at `index` in a status group, from the group
 * as displayed *without* the moved issue. Neighbours are read from that list,
 * so a filtered view asks for the position the user saw.
 */
export function placementAt(status: string, key: string, index: number, groupWithoutActive: string[]): IssuePlacement {
  const after = index > 0 ? groupWithoutActive[index - 1] : undefined;
  const before = index < groupWithoutActive.length ? groupWithoutActive[index] : undefined;
  return {
    key,
    status,
    index,
    ...(before ? { beforeKey: before } : {}),
    ...(after ? { afterKey: after } : {}),
  };
}

/**
 * The list as it should look the moment the drop lands: the moved issue takes
 * its new status and its new position, and the group it landed in is numbered
 * as the server is about to number it — 1000, 2000, … in the order shown. The
 * numbering is local (this client may only hold part of the status), but the
 * sequence is the one the user dropped into, which is what the server then
 * makes true of the whole. Its answer replaces exactly these issues.
 */
export function placeOptimistically(issues: Issue[], placement: IssuePlacement): Issue[] {
  const moved = issues.find((issue) => issue.key === placement.key);
  if (!moved) return issues;

  const group = sortIssuesByOrder(issues.filter((issue) => issue.status === placement.status && issue.key !== placement.key));
  const index = placement.index ?? group.length;
  const ordered = [...group.slice(0, index), moved, ...group.slice(index)];
  const numbers = new Map(ordered.map((issue, i) => [issue.id, (i + 1) * ORDER_STEP]));

  return issues.map((issue) => {
    const order = numbers.get(issue.id);
    if (order === undefined) return issue;
    return { ...issue, status: placement.status, order };
  });
}

/**
 * The project a session's working directory belongs to: the longest `repoPath`
 * that contains it. Segment-aware, so a project in `/repos/cockpit` does not
 * claim a session in `/repos/cockpit-2`, and tolerant of the exact directory
 * and of a trailing slash on either side. A `repoPath` that is not an absolute
 * path is not a location on this machine and never matches.
 */
export function projectForCwd(projects: Project[], cwd: string | undefined): Project | undefined {
  if (!cwd) return undefined;
  const target = stripTrailingSlash(cwd);
  if (!target) return undefined;

  let best: Project | undefined;
  for (const project of projects) {
    if (project.archived || !project.repoPath) continue;
    const repo = stripTrailingSlash(project.repoPath);
    if (!repo?.startsWith("/")) continue;
    if (target !== repo && !target.startsWith(`${repo}/`)) continue;
    const bestRepo = best?.repoPath ? stripTrailingSlash(best.repoPath) : "";
    if (best === undefined || repo.length > bestRepo.length) best = project;
  }
  return best;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Groups issues by status: built-in statuses first in canonical lifecycle order
 * (ISSUE_STATUSES), then any custom status present in the input (in first-seen
 * order), and drops any status with zero issues so the list page never renders
 * an empty heading. The shared "By status" list spans every project, so it can't
 * key off one project's status config — a custom status shows wherever it has
 * issues; the per-project column set lives in resolveProjectStatuses / the board.
 */
export function groupIssuesByStatus(issues: Issue[], options?: { includeEmpty?: boolean; statuses?: string[] }): IssueStatusGroup[] {
  const byStatus = new Map<string, Issue[]>();
  const customOrder: string[] = [];
  for (const issue of issues) {
    const list = byStatus.get(issue.status);
    if (list) list.push(issue);
    else {
      byStatus.set(issue.status, [issue]);
      if (!(ISSUE_STATUSES as readonly string[]).includes(issue.status)) customOrder.push(issue.status);
    }
  }

  // A caller with a project in hand passes its own status list, so a status
  // that is empty (or disabled) still renders where the project defines it.
  const statuses = options?.statuses ?? [...ISSUE_STATUSES, ...customOrder];
  const groups: IssueStatusGroup[] = [];
  for (const status of statuses) {
    const list = byStatus.get(status);
    if (list && list.length > 0) groups.push({ status, issues: sortIssuesByOrder(list) });
    else if (options?.includeEmpty) groups.push({ status, issues: [] });
  }
  // With an explicit status list, an issue sitting in a status the list does not
  // name (disabled in the project, or removed from its config) would otherwise
  // vanish from the view entirely — the same rule boardColumns follows.
  for (const status of byStatus.keys()) {
    if (statuses.includes(status)) continue;
    const list = byStatus.get(status);
    if (list && list.length > 0) groups.push({ status, issues: sortIssuesByOrder(list) });
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
 * Default dot colour per built-in status, tracking the lifecycle: greys for the
 * not-started/terminal ends, warmer/cooler mid-tones through the active middle.
 * A custom status without a stored colour falls back to a hashed LABEL_COLORS
 * swatch (statusColor), so every column always has a stable dot.
 */
export const STATUS_COLORS: Record<string, string> = {
  Backlog: "bg-slate-400",
  "Needs Detail": "bg-amber-500",
  "Refine Ready": "bg-yellow-500",
  Refining: "bg-lime-500",
  "Plan Review": "bg-teal-500",
  "Implementation Ready": "bg-sky-500",
  Implementation: "bg-blue-500",
  "Code Review": "bg-violet-500",
  Accepted: "bg-fuchsia-500",
  Done: "bg-emerald-500",
  Cancelled: "bg-slate-500",
};

export interface ResolvedStatus {
  name: string;
  builtin: boolean;
  color: string;
}

/** The dot colour for a status name: a stored custom colour wins, then the
 *  built-in default, then a deterministic hashed swatch so a custom status with
 *  no colour still renders a stable dot. */
export function statusColor(name: string, project?: Project): string {
  const custom = project?.customStatuses?.find((s) => s.name === name);
  if (custom?.color) return custom.color;
  return STATUS_COLORS[name] ?? labelColor(name);
}

/**
 * The ordered status columns for a project: built-in statuses in canonical
 * lifecycle order minus the project's disabledStatuses, then its customStatuses
 * in array order. With no project (the All-Projects board) it's the full
 * built-in lifecycle. This is the single source of truth for a project's column
 * set and their order — the board, the detail-page status picker, and the
 * settings editor all read it rather than hand-rolling the merge.
 */
export function resolveProjectStatuses(project?: Project): ResolvedStatus[] {
  const disabled = new Set(project?.disabledStatuses ?? []);
  const builtins = ISSUE_STATUSES.filter((s) => !disabled.has(s)).map((name) => ({
    name,
    builtin: true,
    color: statusColor(name, project),
  }));
  const customs = (project?.customStatuses ?? []).map((c) => ({
    name: c.name,
    builtin: false,
    color: statusColor(c.name, project),
  }));
  return [...builtins, ...customs];
}

/**
 * The Kanban board's column set: a project's resolved statuses, then any status
 * that currently has issues but isn't already a column — so disabling a status,
 * or an issue left in a removed/unknown one, never hides work off the board.
 */
export function boardColumns(issues: Issue[], project?: Project): { name: string; color: string }[] {
  const columns = resolveProjectStatuses(project).map((s) => ({ name: s.name, color: s.color }));
  const known = new Set(columns.map((c) => c.name));
  for (const issue of issues) {
    if (!known.has(issue.status)) {
      known.add(issue.status);
      columns.push({ name: issue.status, color: statusColor(issue.status, project) });
    }
  }
  return columns;
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

/**
 * Where an issue was opened from: a `?from=` path the issue's own pages return
 * to, so an issue opened from a session's modal closes and deletes back to that
 * session. Only a path inside cockpit is honoured — anything else (an absolute
 * URL, a protocol-relative `//host`, an absent value) falls back to the Issues
 * list rather than becoming an open redirect.
 */
export function issueReturnPath(from: string | null | undefined): string {
  if (!from?.startsWith("/") || from.startsWith("//")) return "/issues";
  return from;
}
