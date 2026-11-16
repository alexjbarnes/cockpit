// How a workflow and an issue's place in it read on screen: pure helpers the
// issue page, the lists and the workflow settings share.

import type { WorkflowAgentRule, WorkflowRun, WorkflowStatusRule } from "@/types";

/** What the workflow is doing with an issue right now, in the order a person cares. */
export type FlowState = "attention" | "yours" | "running" | "queued";

export interface IssueFlow {
  state: FlowState;
  /** Where the issue is. */
  status: string;
  /** The skill an agent runs on it, when one does. */
  skill?: string;
  /** Why it is held, for "attention". */
  reason?: string;
  /** The session to watch, for "running". */
  sessionId?: string;
  startedAt?: number;
}

/** What happens at one of a project's statuses. */
export interface StatusInfo {
  status: string;
  kind: "queue" | "agent" | "human";
  /** The skill run here, or in the status this queue feeds. */
  skill?: string;
  /** A queue: the status its issues are worked in. */
  to?: string;
  /** The skill is not in the project's repo, so nothing starts. */
  missing?: boolean;
  review?: "plan";
}

interface ActivityRow {
  issueKey: string;
  title: string;
  projectId: string;
  status: string;
  skill?: string;
}

/** The shape /api/workflows/activity answers with. */
export interface WorkflowActivityView {
  enabled: boolean;
  paused: boolean;
  slots: { used: number; max: number };
  running: (ActivityRow & { runId: string; sessionId: string; startedAt: number })[];
  queued: ActivityRow[];
  waiting: ActivityRow[];
  attention: (ActivityRow & { reason: string; at: number })[];
  statuses?: Record<string, StatusInfo[]>;
  blocked?: { projectId: string; status: string; skill: string }[];
}

/**
 * What happens at a status, for a list's section heading. With a project it
 * is that project's. Across all projects it is given only when every workflow
 * that uses the status agrees on it, since the heading is shared and a wrong
 * label is worse than none.
 */
export function infoForStatus(
  statuses: Record<string, StatusInfo[]> | undefined,
  status: string,
  projectId?: string,
): StatusInfo | undefined {
  if (!statuses) return undefined;
  if (projectId) return statuses[projectId]?.find((s) => s.status === status);
  let found: StatusInfo | undefined;
  for (const list of Object.values(statuses)) {
    const mine = list.find((s) => s.status === status);
    if (!mine) continue;
    if (found && (found.kind !== mine.kind || found.skill !== mine.skill)) return undefined;
    found = mine;
  }
  return found;
}

/** The few words a status's heading carries: what waits here, runs here, or whose it is. */
export function statusTag(info: StatusInfo): string {
  if (info.kind === "human") return "Yours";
  if (info.kind === "queue") return "Queue";
  return info.skill ?? "Agent";
}

/** The same, said in full for a tooltip. */
export function statusTagTitle(info: StatusInfo): string {
  if (info.kind === "human") return info.review === "plan" ? "Issues here wait for you to review the plan" : "Issues here wait for you";
  const missing = info.missing ? `, but there is no "${info.skill}" skill in the repo, so nothing starts` : "";
  if (info.kind === "queue") return `Issues here wait for an agent, then move to "${info.to}"${missing}`;
  return `An agent runs the "${info.skill}" skill on issues here${missing}`;
}

/**
 * Each issue's state, by key. An issue can be in more than one list for a
 * moment (held and still marked running while its session is torn down), so
 * the one that needs a person wins.
 */
export function issueFlows(activity: WorkflowActivityView | null | undefined): Map<string, IssueFlow> {
  const flows = new Map<string, IssueFlow>();
  if (!activity) return flows;
  for (const q of activity.queued) flows.set(q.issueKey, { state: "queued", status: q.status, skill: q.skill });
  for (const r of activity.running)
    flows.set(r.issueKey, { state: "running", status: r.status, skill: r.skill, sessionId: r.sessionId, startedAt: r.startedAt });
  for (const w of activity.waiting) flows.set(w.issueKey, { state: "yours", status: w.status });
  for (const a of activity.attention) flows.set(a.issueKey, { state: "attention", status: a.status, skill: a.skill, reason: a.reason });
  return flows;
}

export const FLOW_LABEL: Record<FlowState, string> = {
  attention: "Held",
  yours: "Yours",
  running: "Running",
  queued: "Queued",
};

/** One line on what the workflows are doing, for the bar above the issue list. */
/** How long something took or has been going: "45s", "4m 12s", "2h 05m". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const RUN_STATUS_LABEL: Record<WorkflowRun["status"], string> = {
  running: "Running",
  success: "Finished",
  failure: "Failed",
  timeout: "Ran out of time",
  stopped: "Stopped",
};

type Rules = Record<string, WorkflowStatusRule>;

function ruleOf(rules: Rules, status: string): WorkflowStatusRule | undefined {
  return Object.hasOwn(rules, status) ? rules[status] : undefined;
}

/** One line of the workflow page: a status of the project, and what happens there. */
export interface StatusRow {
  status: string;
  rule?: WorkflowStatusRule;
}

/**
 * The project's statuses in board order, each with its rule. A status the
 * workflow names that the board does not list (one about to be added, or
 * hidden) follows them, so nothing the workflow does is left off the page.
 */
export function statusRows(rules: Rules, order: readonly string[]): StatusRow[] {
  const rows: StatusRow[] = order.map((status) => ({ status, rule: ruleOf(rules, status) }));
  const listed = new Set(order);
  for (const status of Object.keys(rules)) if (!listed.has(status)) rows.push({ status, rule: rules[status] });
  return rows;
}

/** The statuses an agent works in, for a queue to point at. */
export function agentStatuses(rules: Rules): string[] {
  return Object.keys(rules).filter((status) => rules[status].kind === "agent");
}

/** The queues that feed an agent's status. */
export function queuesFor(rules: Rules, status: string): string[] {
  return Object.keys(rules).filter((name) => {
    const rule = rules[name];
    return rule.kind === "queue" && rule.to === status;
  });
}

/** A place on an issue's way through its workflow: where an agent works on it or a person decides. */
export interface TrackStop {
  status: string;
  kind: "agent" | "human";
  skill?: string;
  review?: "plan";
}

/**
 * The stops an issue's progress is drawn through, in board order. A queue is
 * not one: it is the wait before the stop it feeds.
 */
export function trackStops(rules: Rules, order: readonly string[]): TrackStop[] {
  const stops: TrackStop[] = [];
  for (const { status, rule } of statusRows(rules, order)) {
    if (rule?.kind === "agent") stops.push({ status, kind: "agent", skill: rule.skill });
    else if (rule?.kind === "human") stops.push({ status, kind: "human", ...(rule.review ? { review: rule.review } : {}) });
  }
  return stops;
}

/** The stop an issue in `status` is at, or waiting for: -1 when it is at none. */
export function trackPosition(stops: readonly TrackStop[], rules: Rules, status: string): number {
  const rule = ruleOf(rules, status);
  const at = rule?.kind === "queue" ? rule.to : status;
  return stops.findIndex((s) => s.status === at);
}

/** Where each stop stands for an issue at stop `at`: behind it, on it, or ahead. */
export function stopStates(count: number, at: number): ("done" | "current" | "ahead")[] {
  return Array.from({ length: count }, (_, i) => (at === -1 ? "ahead" : i < at ? "done" : i === at ? "current" : "ahead"));
}

/** What a stop is, in a sentence. */
export function stopSummary(stop: TrackStop): string {
  if (stop.kind === "agent") return `An agent runs ${stop.skill}`;
  return stop.review === "plan" ? "Waits for you to review the plan" : "Waits for you to decide";
}

const PERMISSION_LABEL = { bypass: "", allowlist: "listed tools only", ask: "asks you" } as const;

/** An agent's settings in a few words, after the skill it runs. */
export function agentSummary(rule: WorkflowAgentRule, modelName?: string): string {
  const parts = [modelName || rule.model || "Default model"];
  if (rule.thinkingLevel) parts.push(`thinking ${rule.thinkingLevel}`);
  const permission = PERMISSION_LABEL[rule.permission ?? "bypass"];
  if (permission) parts.push(permission);
  if (rule.maxParallel) parts.push(`${rule.maxParallel} at once`);
  return parts.join(" · ");
}

/** A rule as a blank form starts it. */
export function newRule(kind: WorkflowStatusRule["kind"]): WorkflowStatusRule {
  if (kind === "queue") return { kind, to: "" };
  if (kind === "human") return { kind, next: [] };
  return { kind, skill: "", next: [""], permission: "bypass" };
}

/**
 * What stops a set of rules being saved, in words for the person editing
 * them. The server checks the same things; this says so before they press Save.
 */
export function ruleProblem(rules: Rules, status: string): string | undefined {
  const rule = ruleOf(rules, status);
  if (!rule) return undefined;
  if (rule.kind === "queue") {
    if (!rule.to) return "Choose the status an agent works these issues in.";
    if (ruleOf(rules, rule.to)?.kind !== "agent") return `No agent works in "${rule.to}" yet. Set that status up first.`;
    return undefined;
  }
  if (rule.kind === "agent") {
    if (!rule.skill) return "Choose the skill the agent runs.";
    if (rule.next.filter(Boolean).length === 0) return "Choose where the issue goes when the agent finishes.";
    return undefined;
  }
  if (
    rule.review === "plan" &&
    (!rule.next.some((c) => c.role === "approve" && c.status) || !rule.next.some((c) => c.role === "sendBack" && c.status))
  ) {
    return "Choose where approving and where sending back move the issue.";
  }
  return undefined;
}
