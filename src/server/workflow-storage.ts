// Workflows and their runs, on disk.
//
// A project has at most one workflow: for each of its statuses, what happens
// to an issue there. Nothing (the status is not named), a queue for an agent,
// an agent working on it by running a skill from the project's repo, or
// waiting for a person. All of them are kept in workflows.json, one entry per
// project. Each run of an agent on an issue is kept in that issue's own file
// under workflow-runs/, so two issues worked at the same moment never write
// the same file.
//
// Synchronous and uncached, like issue-storage: a call reads, changes and
// writes before returning, so two writers in one process cannot interleave.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ISSUE_STATUSES,
  type Project,
  THINKING_LEVELS,
  WORKFLOW_PERMISSIONS,
  type Workflow,
  type WorkflowAgentRule,
  type WorkflowChoice,
  type WorkflowHumanRule,
  type WorkflowRun,
  type WorkflowStatusRule,
} from "@/types";
import { writeJsonAtomic } from "./atomic-write";
import { getDefaults } from "./defaults";
import { allowedStatusesFor, applyProjectUpdate, saveProject } from "./issue-storage";
import { getCockpitDir } from "./paths";
import { SKILL_NAME } from "./skills";

/** Runs kept per issue. The oldest go first. */
export const WORKFLOW_MAX_RUNS_PER_ISSUE = 100;

/** Statuses an issue comes to rest in. Nothing is queued or worked there: the
 *  engine removes the issue's worktree when it arrives. */
const FINISHED: readonly string[] = ["Done", "Cancelled"];

function workflowsFile(): string {
  return join(getCockpitDir(), "workflows.json");
}

function runsDir(): string {
  return join(getCockpitDir(), "workflow-runs");
}

const SAFE_KEY = /^[A-Za-z0-9_-]{1,120}$/;

function runsFile(issueKey: string): string | undefined {
  const key = issueKey.toUpperCase();
  return SAFE_KEY.test(key) ? join(runsDir(), `${key}.json`) : undefined;
}

// ── Workflows ─────────────────────────────────────────────────────────

/** Whether a stored entry is a workflow of this shape. An earlier build kept
 *  shared workflows made of named stages; those are left alone and ignored. */
function isWorkflow(value: unknown): value is Workflow {
  if (!value || typeof value !== "object") return false;
  const w = value as Partial<Workflow>;
  return typeof w.projectId === "string" && !!w.statuses && typeof w.statuses === "object" && !Array.isArray(w.statuses);
}

export function loadWorkflows(): Workflow[] {
  const file = workflowsFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { workflows?: unknown[] };
    return Array.isArray(parsed.workflows) ? parsed.workflows.filter(isWorkflow) : [];
  } catch {
    return [];
  }
}

/** The workflow a project's issues move through, when it has one. */
export function workflowForProject(project: Pick<Project, "id"> | undefined): Workflow | undefined {
  return project ? loadWorkflows().find((w) => w.projectId === project.id) : undefined;
}

/**
 * Whether a project's issues are the workflow engine's to move: workflows are
 * switched on, and the project's own is too. The status-triggered jobs step
 * aside for such a project, or an issue would be worked twice.
 */
export function projectRunsWorkflow(projectId: string): boolean {
  const settings = getDefaults();
  if (!settings.issuesEnabled || !settings.workflowsEnabled) return false;
  return workflowForProject({ id: projectId })?.enabled === true;
}

/** What happens at a status, when anything does. */
export function ruleAt(workflow: Pick<Workflow, "statuses">, status: string): WorkflowStatusRule | undefined {
  return Object.hasOwn(workflow.statuses, status) ? workflow.statuses[status] : undefined;
}

/** A status an agent works issues in, with the queues that feed it. This is
 *  the unit the engine runs: the status is its identity. */
export interface AgentWork {
  workStatus: string;
  queues: string[];
  rule: WorkflowAgentRule;
}

export function agentWork(workflow: Pick<Workflow, "statuses">): AgentWork[] {
  const out: AgentWork[] = [];
  for (const [status, rule] of Object.entries(workflow.statuses)) {
    if (rule.kind !== "agent") continue;
    const queues = Object.entries(workflow.statuses)
      .filter(([, r]) => r.kind === "queue" && r.to === status)
      .map(([name]) => name);
    out.push({ workStatus: status, queues, rule });
  }
  return out;
}

/** The agent's work an issue in `status` belongs to: the status it is worked
 *  in, or a queue that feeds one. */
export function workAt(workflow: Pick<Workflow, "statuses">, status: string): AgentWork | undefined {
  return agentWork(workflow).find((w) => w.workStatus === status || w.queues.includes(status));
}

/** Where issues of this work wait for an agent: its queues, or the status
 *  itself when nothing feeds it. */
export function waitingStatuses(work: AgentWork): string[] {
  return work.queues.length > 0 ? work.queues : [work.workStatus];
}

/** Every status a workflow names: the ones it gives a rule, and the ones those send issues to. */
export function workflowStatuses(workflow: Pick<Workflow, "statuses">): string[] {
  const all = new Set<string>();
  for (const [status, rule] of Object.entries(workflow.statuses)) {
    all.add(status);
    if (rule.kind === "queue") all.add(rule.to);
    else if (rule.kind === "agent") for (const s of rule.next) all.add(s);
    else for (const c of rule.next) all.add(c.status);
  }
  return [...all];
}

function fail(message: string): never {
  throw new Error(message);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} is required`);
  return (value as string).trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail(`${field} must be text`);
  return value as string;
}

function count(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value as number;
}

function names(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) fail(`${field} must be a list of names`);
  const list = (value as string[]).map((v) => v.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function toolFilters(value: unknown, field: string): Record<string, string[]> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail(`${field} must map a server to its tools`);
  const out: Record<string, string[]> = {};
  for (const [server, tools] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) fail(`${field}.${server} must be a list of tool names`);
    out[server] = tools as string[];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One thing a person can decide. A bare status name is a button called that. */
function choice(raw: unknown, where: string): WorkflowChoice {
  if (typeof raw === "string") return { status: text(raw, `${where}: status`), label: raw.trim() };
  if (!raw || typeof raw !== "object") fail(`${where} must be a status and a label`);
  const c = raw as Record<string, unknown>;
  const status = text(c.status, `${where}: status`);
  const role = c.role === "approve" || c.role === "sendBack" ? c.role : undefined;
  if (c.role !== undefined && c.role !== null && c.role !== "" && !role) fail(`${where}: role must be "approve" or "sendBack"`);
  return { status, label: optionalText(c.label, `${where}: label`)?.trim() || status, ...(role ? { role } : {}) };
}

/** Where an agent may send an issue. A bare status name, or an object with one. */
function target(raw: unknown, where: string): string {
  if (typeof raw === "string") return text(raw, where);
  if (raw && typeof raw === "object") return text((raw as Record<string, unknown>).status, `${where}: status`);
  return fail(`${where} must be a status name`);
}

/**
 * One status's rule, reduced to what its kind uses, so a status switched from
 * one kind to another does not carry the old kind's settings along unseen.
 */
function rule(raw: unknown, status: string): WorkflowStatusRule {
  const label = `"${status}"`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label}: a status's rule is an object with a kind`);
  const r = raw as Record<string, unknown>;

  if (r.kind === "queue") return { kind: "queue", to: text(r.to, `${label}: to (the status an agent works it in)`) };

  if (r.kind === "human") {
    if (r.review !== undefined && r.review !== null && r.review !== "" && r.review !== "plan") fail(`${label}: review must be "plan"`);
    if (r.next !== undefined && r.next !== null && !Array.isArray(r.next)) fail(`${label}: next must be a list`);
    const review = r.review === "plan";
    const next = ((r.next as unknown[] | undefined) ?? []).map((c, i) => choice(c, `${label}, choice ${i + 1}`));
    const notifyProviders = names(r.notifyProviders, `${label}: notifyProviders`);
    const human: WorkflowHumanRule = {
      kind: "human",
      ...(review ? { review: "plan" as const } : {}),
      // A role only means something on a plan review.
      next: review ? next : next.map(({ role: _role, ...rest }) => rest),
      ...(notifyProviders ? { notifyProviders } : {}),
    };
    return human;
  }

  if (r.kind !== "agent") fail(`${label}: kind must be "queue", "agent" or "human"`);
  const skill = text(r.skill, `${label}: skill`);
  if (!SKILL_NAME.test(skill)) fail(`${label}: "${skill}" is not a skill name. A skill is named by its folder under .claude/skills.`);
  if (!Array.isArray(r.next)) fail(`${label}: next must be a list of statuses`);
  const next = (r.next as unknown[]).map((t, i) => target(t, `${label}, next ${i + 1}`));
  const permission = r.permission === undefined || r.permission === null || r.permission === "" ? "bypass" : r.permission;
  if (!WORKFLOW_PERMISSIONS.includes(permission as (typeof WORKFLOW_PERMISSIONS)[number])) {
    fail(`${label}: permission must be one of ${WORKFLOW_PERMISSIONS.join(", ")}`);
  }
  const thinkingLevel = optionalText(r.thinkingLevel, `${label}: thinkingLevel`);
  if (thinkingLevel !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
    fail(`${label}: thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  if (r.runtime !== undefined && r.runtime !== null && r.runtime !== "" && r.runtime !== "pty" && r.runtime !== "stream") {
    fail(`${label}: runtime must be "pty" or "stream"`);
  }
  if (r.workspace !== undefined && r.workspace !== null && r.workspace !== "" && r.workspace !== "repo" && r.workspace !== "worktree") {
    fail(`${label}: workspace must be "repo" or "worktree"`);
  }
  const model = optionalText(r.model, `${label}: model`)?.trim() || undefined;
  const contextSize = optionalText(r.contextSize, `${label}: contextSize`)?.trim() || undefined;
  const allowedTools = names(r.allowedTools, `${label}: allowedTools`);
  const mcpServers = names(r.mcpServers, `${label}: mcpServers`);
  const mcpToolFilters = toolFilters(r.mcpToolFilters, `${label}: mcpToolFilters`);
  const maxDurationMinutes = count(r.maxDurationMinutes, `${label}: maxDurationMinutes`, 1, 24 * 60);
  const maxRetries = count(r.maxRetries, `${label}: maxRetries`, 0, 5);
  const maxParallel = count(r.maxParallel, `${label}: maxParallel`, 1, 20);
  const notifyProviders = names(r.notifyProviders, `${label}: notifyProviders`);
  return {
    kind: "agent",
    skill,
    next,
    ...(model ? { model } : {}),
    ...(contextSize ? { contextSize } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as WorkflowAgentRule["thinkingLevel"] } : {}),
    ...(r.runtime === "pty" || r.runtime === "stream" ? { runtime: r.runtime } : {}),
    permission: permission as WorkflowAgentRule["permission"],
    ...(allowedTools ? { allowedTools } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(mcpToolFilters ? { mcpToolFilters } : {}),
    ...(r.sandbox === true ? { sandbox: true } : {}),
    ...(maxDurationMinutes !== undefined ? { maxDurationMinutes } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(maxParallel !== undefined ? { maxParallel } : {}),
    ...(r.workspace === "repo" || r.workspace === "worktree" ? { workspace: r.workspace } : {}),
    ...(r.continueSession === true ? { continueSession: true } : {}),
    ...(notifyProviders ? { notifyProviders } : {}),
  };
}

/**
 * The rules a workflow must keep as a whole. They are what lets the engine
 * tell, from an issue's status alone, whether an agent's work on it is over.
 */
function assertFits(statuses: Record<string, WorkflowStatusRule>): void {
  let planReview: string | undefined;
  for (const [status, r] of Object.entries(statuses)) {
    const label = `"${status}"`;
    if (r.kind !== "human" && FINISHED.includes(status)) {
      fail(`${label} is where an issue comes to rest, so it cannot be a queue or have an agent working in it.`);
    }
    if (r.kind === "queue") {
      const to = Object.hasOwn(statuses, r.to) ? statuses[r.to] : undefined;
      if (r.to === status) fail(`${label} is a queue that sends issues to itself.`);
      if (to?.kind !== "agent") {
        fail(`${label} is a queue for "${r.to}", but no agent works in "${r.to}". Say which skill an agent runs there first.`);
      }
      continue;
    }
    const targets = r.kind === "agent" ? r.next : r.next.map((c) => c.status);
    const seen = new Set<string>();
    for (const t of targets) {
      if (t === status) fail(`${label} cannot move an issue to itself.`);
      if (seen.has(t)) fail(`${label} lists the status "${t}" twice.`);
      seen.add(t);
    }
    if (r.kind === "agent") {
      if (r.next.length === 0) fail(`${label}: an agent needs at least one status to move the issue to when it finishes.`);
      for (const t of r.next) {
        const there = Object.hasOwn(statuses, t) ? statuses[t] : undefined;
        if (there?.kind === "queue" && there.to === status) {
          fail(`${label} cannot move an issue to "${t}": that is its own queue, so the issue would come straight back.`);
        }
      }
      continue;
    }
    if (r.review === "plan") {
      if (planReview) fail(`Both "${planReview}" and ${label} review the plan. A workflow has one plan review.`);
      planReview = status;
      const approvals = r.next.filter((c) => c.role === "approve").length;
      const sendBacks = r.next.filter((c) => c.role === "sendBack").length;
      if (approvals !== 1 || sendBacks !== 1 || r.next.length !== 2) {
        fail(`${label} reviews the plan, so it needs exactly two choices: one with role "approve" and one with role "sendBack".`);
      }
    }
  }
}

export interface WorkflowInput {
  enabled?: boolean;
  maxParallel?: number;
  /** By status name. `null` clears a status. */
  statuses?: unknown;
  /** With `statuses`: they are the whole workflow, and any status not named is cleared. */
  replace?: boolean;
}

export interface ShapedWorkflow {
  workflow: Workflow;
  /** Statuses the workflow names that the project has to gain. */
  added: string[];
  /** Built-in statuses the workflow names that the project had hidden. */
  shown: string[];
}

/**
 * A project's workflow from what a caller sent, on top of the one it has.
 * Pure: nothing is written. Status names are matched to the project's own
 * whatever their case, and one the project lacks is reported in `added`.
 */
export function shapeWorkflow(project: Project, input: WorkflowInput, existing?: Workflow): ShapedWorkflow {
  const now = Date.now();
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (typeof enabled !== "boolean") fail("enabled must be true or false");
  const maxParallel = count(input.maxParallel ?? existing?.maxParallel ?? 2, "maxParallel", 1, 50) ?? 2;

  const known = new Map(allowedStatusesFor(project).map((name) => [name.toLowerCase(), name]));
  const added: string[] = [];
  /** The project's own spelling of a status, or the caller's for a new one. */
  const canon = (name: string): string => {
    const key = name.trim().toLowerCase();
    const found = known.get(key);
    if (found) return found;
    known.set(key, name.trim());
    added.push(name.trim());
    return name.trim();
  };

  const statuses: Record<string, WorkflowStatusRule> = {};
  if (!input.replace || input.statuses === undefined) {
    for (const [status, r] of Object.entries(existing?.statuses ?? {})) statuses[status] = r;
  }
  if (input.statuses !== undefined) {
    if (!input.statuses || typeof input.statuses !== "object" || Array.isArray(input.statuses)) {
      fail("statuses must be an object keyed by status name");
    }
    const named = new Set<string>();
    for (const [rawName, raw] of Object.entries(input.statuses as Record<string, unknown>)) {
      if (rawName.trim() === "") fail("A status name is required");
      const cleared = raw === null || (typeof raw === "object" && (raw as { kind?: unknown }).kind === "none");
      // Clearing a status the project does not have is nothing to do, not a reason to add it.
      if (cleared && !known.has(rawName.trim().toLowerCase())) continue;
      const status = canon(rawName);
      if (named.has(status)) fail(`The status "${status}" is given twice`);
      named.add(status);
      if (cleared) {
        delete statuses[status];
        continue;
      }
      const shaped = rule(raw, status);
      if (shaped.kind === "queue") statuses[status] = { kind: "queue", to: canon(shaped.to) };
      else if (shaped.kind === "agent") statuses[status] = { ...shaped, next: shaped.next.map(canon) };
      else statuses[status] = { ...shaped, next: shaped.next.map((c) => ({ ...c, status: canon(c.status) })) };
    }
  }
  assertFits(statuses);

  const namedNow = new Set(workflowStatuses({ statuses }));
  const builtin = new Set<string>(ISSUE_STATUSES);
  return {
    workflow: {
      projectId: project.id,
      enabled,
      maxParallel,
      statuses,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    // A status named and then cleared in the same call is not one to add.
    added: added.filter((name) => namedNow.has(name) && !builtin.has(name)),
    shown: (project.disabledStatuses ?? []).filter((name) => namedNow.has(name)),
  };
}

function writeWorkflows(workflows: Workflow[]): void {
  writeJsonAtomic(workflowsFile(), { workflows });
}

/**
 * Create or change a project's workflow and persist it. The project gains any
 * status the workflow names that it lacks, and shows again any built-in it had
 * hidden: a workflow that moves issues into a status the board does not have
 * would lose them from view. Throws with the reason when the result would not
 * be a workflow.
 */
export function setProjectWorkflow(project: Project, input: WorkflowInput): ShapedWorkflow {
  const shaped = shapeWorkflow(project, input, workflowForProject(project));
  if (shaped.added.length > 0 || shaped.shown.length > 0) {
    saveProject(
      applyProjectUpdate(project, {
        ...(shaped.added.length > 0
          ? { customStatuses: [...(project.customStatuses ?? []), ...shaped.added.map((name) => ({ name }))] }
          : {}),
        ...(shaped.shown.length > 0
          ? { disabledStatuses: (project.disabledStatuses ?? []).filter((name) => !shaped.shown.includes(name)) }
          : {}),
      }),
    );
  }
  writeWorkflows([...loadWorkflows().filter((w) => w.projectId !== project.id), shaped.workflow]);
  return shaped;
}

/** Remove a project's workflow. False when it had none. */
export function deleteWorkflow(projectId: string): boolean {
  const workflows = loadWorkflows();
  if (!workflows.some((w) => w.projectId === projectId)) return false;
  writeWorkflows(workflows.filter((w) => w.projectId !== projectId));
  return true;
}

/**
 * Refuse a change to a project that would take away a status its workflow
 * names. Called with the project as it would be saved.
 */
export function assertProjectKeepsWorkflowStatuses(project: Project): void {
  const workflow = workflowForProject(project);
  if (!workflow) return;
  const allowed = new Set(allowedStatusesFor(project));
  const hidden = new Set(project.disabledStatuses ?? []);
  const lost = workflowStatuses(workflow).filter((s) => !allowed.has(s) || hidden.has(s));
  if (lost.length > 0) {
    fail(
      `${project.name}'s workflow uses the status "${lost.join('", "')}". Change the workflow first (Settings, Workflows), then remove ${lost.length === 1 ? "it" : "them"}.`,
    );
  }
}

// ── Runs ──────────────────────────────────────────────────────────────

interface RunsFile {
  runs: WorkflowRun[];
  /** Per kind of work (see workKey): when its count of runs on this issue was last started over. */
  resets?: Record<string, number>;
}

function readRuns(issueKey: string): RunsFile {
  const file = runsFile(issueKey);
  if (!file || !existsSync(file)) return { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<RunsFile>;
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [], ...(parsed.resets ? { resets: parsed.resets } : {}) };
  } catch {
    return { runs: [] };
  }
}

function writeRuns(issueKey: string, data: RunsFile): void {
  const file = runsFile(issueKey);
  if (!file) throw new Error(`Not an issue key: ${issueKey}`);
  writeJsonAtomic(file, data);
}

/** An issue's runs, oldest first. */
export function loadWorkflowRuns(issueKey: string): WorkflowRun[] {
  return readRuns(issueKey).runs;
}

export function saveWorkflowRun(run: WorkflowRun): void {
  const data = readRuns(run.issueKey);
  const index = data.runs.findIndex((r) => r.id === run.id);
  if (index >= 0) data.runs[index] = run;
  else data.runs.push(run);
  if (data.runs.length > WORKFLOW_MAX_RUNS_PER_ISSUE) data.runs = data.runs.slice(-WORKFLOW_MAX_RUNS_PER_ISSUE);
  writeRuns(run.issueKey, data);
}

/** What a run was of: the status it worked in and the skill it ran. A
 *  different skill put on a status is different work, and starts clean. */
export function workKey(workStatus: string, skill: string): string {
  return `${workStatus}\n${skill}`;
}

/** An issue's runs of one kind of work, oldest first. */
export function runsOf(issueKey: string, workStatus: string, skill: string): WorkflowRun[] {
  return readRuns(issueKey).runs.filter((r) => r.workStatus === workStatus && r.skill === skill);
}

/**
 * How many times an agent has worked an issue at a status since the count was
 * last started over. This is what stops two statuses handing an issue back
 * and forth forever.
 */
export function workRunCount(issueKey: string, workStatus: string, skill: string): number {
  const data = readRuns(issueKey);
  const since = data.resets?.[workKey(workStatus, skill)] ?? 0;
  return data.runs.filter((r) => r.workStatus === workStatus && r.skill === skill && r.startedAt > since).length;
}

/** Start that count over, as a person retrying it or moving the issue back does. */
export function resetWorkRuns(issueKey: string, workStatus: string, skill: string, now: number = Date.now()): void {
  const data = readRuns(issueKey);
  data.resets = { ...(data.resets ?? {}), [workKey(workStatus, skill)]: now };
  writeRuns(issueKey, data);
}

/** Every run on disk still marked running: what a restart left behind. */
export function loadUnfinishedRuns(): WorkflowRun[] {
  const dir = runsDir();
  if (!existsSync(dir)) return [];
  const out: WorkflowRun[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    out.push(...readRuns(name.slice(0, -5)).runs.filter((r) => r.status === "running"));
  }
  return out;
}

/** The session of every workflow run, so the session lists can leave them out
 *  the way they leave out job runs. */
export function getWorkflowSessionIds(): Set<string> {
  const ids = new Set<string>();
  const dir = runsDir();
  if (!existsSync(dir)) return ids;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    for (const run of readRuns(name.slice(0, -5)).runs) if (run.sessionId) ids.add(run.sessionId);
  }
  return ids;
}

export function deleteWorkflowRuns(issueKey: string): void {
  const file = runsFile(issueKey);
  if (file) rmSync(file, { force: true });
}
