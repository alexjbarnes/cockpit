// The workflow engine: issues waiting for an agent are given a session that
// works on them, as many at once as the limits allow.
//
// Nothing is queued anywhere. What is waiting is worked out, each time, from
// where the issues are: an issue sitting in a queue (or in a status an agent
// works in that nothing queues for) with no run on it and no attention flag is
// waiting. So an event the engine never saw, or a restart, loses nothing: the
// next look finds it.
//
// The engine claims an issue, not the agent: it starts the session, moves the
// issue from its queue to the status the agent works in, and names the issue
// and the skill to run in the prompt. The work is over when the issue has been
// moved to one of the statuses the workflow lists, which is also the only move
// the run is allowed.

import { existsSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { CONTEXT_SIZES, type ContextSize } from "@/lib/models";
import type { Issue, IssueActor, IssueWorkspace, Project, Workflow, WorkflowAgentRule, WorkflowRun } from "@/types";
import { type IdleVerdict, startAgentRun } from "./agent-run";
import { logDiag } from "./debug-logger";
import { getDefaults } from "./defaults";
import { addInboxMessage } from "./inbox";
import { type IssueStatusChangeEvent, onIssueStatusChange } from "./issue-events";
import { allowedStatusesFor, applyIssueUpdate, getIssue, loadIssues, loadProjects, saveIssue } from "./issue-storage";
import { ensureWorkspace, removeWorkspace } from "./issue-workspace";
import { checkJobModel } from "./provider-catalog";
import { releaseRunPorts, reserveRunPort } from "./run-ports";
import type { SessionManager } from "./session-manager";
import { hasRepoSkill, repoSkillPath } from "./skills";
import {
  type AgentWork,
  agentWork,
  loadUnfinishedRuns,
  resetWorkRuns,
  ruleAt,
  runsOf,
  saveWorkflowRun,
  waitingStatuses,
  workAt,
  workflowForProject,
  workRunCount,
} from "./workflow-storage";
import { trustDirectory } from "./workspace-trust";

/** Runs of one agent on one issue before the engine stops and asks. Two
 *  statuses that keep sending an issue back to each other end here. */
export const WORKFLOW_MAX_WORK_RUNS = 5;

/** How often the engine looks again with nothing prompting it. */
const SWEEP_MS = 60_000;

/** Statuses an issue does not come back from: its worktree has no more use. */
const FINISHED = new Set(["Done", "Cancelled"]);

const DEFAULT_RUN_MINUTES = 60;
const DEFAULT_RUN_RETRIES = 1;

interface Live {
  issueKey: string;
  projectId: string;
  work: AgentWork;
  runId: string;
  record?: WorkflowRun;
  settle?: (run: WorkflowRun) => void;
  /** Where the issue was when the run took it. */
  from: string;
  /** Where the run's own move took the issue. Set, its work is over, whatever
   *  becomes of the issue before the session says its last word. */
  left?: string;
  /** The run was told once that it stopped without moving the issue. */
  nudged: boolean;
}

interface Candidate {
  project: Project;
  workflow: Workflow;
  work: AgentWork;
  issue: Issue;
}

export interface WorkflowActivityRow {
  issueKey: string;
  title: string;
  projectId: string;
  /** Where the issue is. */
  status: string;
  /** The skill an agent runs on it, when one does. */
  skill?: string;
}

/** What happens at one of a project's statuses, for the board to say. */
export interface WorkflowStatusInfo {
  status: string;
  kind: "queue" | "agent" | "human";
  /** The skill run here, or in the status this queue feeds. */
  skill?: string;
  /** A queue: the status its issues are worked in. */
  to?: string;
  /** The skill is not in the project's repo, so nothing starts. */
  missing?: boolean;
  /** A person's status: they review the issue's plan here. */
  review?: "plan";
}

export interface WorkflowActivity {
  enabled: boolean;
  paused: boolean;
  slots: { used: number; max: number };
  running: (WorkflowActivityRow & { runId: string; sessionId: string; startedAt: number })[];
  queued: WorkflowActivityRow[];
  /** At a status that is a person's: nothing moves until they act. */
  waiting: WorkflowActivityRow[];
  /** Per project: what each status with a rule is. */
  statuses: Record<string, WorkflowStatusInfo[]>;
  /** Statuses whose agent cannot start because its skill is missing. */
  blocked: { projectId: string; status: string; skill: string }[];
  attention: (WorkflowActivityRow & { reason: string; at: number })[];
}

/** Urgent first, unranked last; then the board's own order; then oldest. */
function byUrgency(a: Issue, b: Issue): number {
  const rank = (i: Issue) => (i.priority && i.priority > 0 ? i.priority : 5);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const order = (i: Issue) => i.order ?? Number.MAX_SAFE_INTEGER;
  if (order(a) !== order(b)) return order(a) - order(b);
  return a.createdAt - b.createdAt;
}

/** Who last changed the issue's status. */
function lastMover(issue: Issue): IssueActor | undefined {
  for (let i = issue.activity.length - 1; i >= 0; i--) {
    const entry = issue.activity[i];
    if (entry.kind === "field_changed" && entry.field === "status") return entry.actor;
  }
  return undefined;
}

function permissionLines(rule: WorkflowAgentRule): string[] {
  if (rule.permission === "ask") {
    return [
      "Permissions: a tool that needs permission is put to the user, who may take a while to answer. Carry on with what does not need it.",
    ];
  }
  if (rule.permission !== "allowlist") return ["Permissions: all tools and MCP servers are available."];
  const tools = rule.allowedTools ?? [];
  const servers = rule.mcpServers ?? [];
  const lines = [
    "Permissions: only the tools and MCP servers listed below are allowed, besides the Skill tool and the cockpit issue tools. Do not attempt to use any others.",
  ];
  if (tools.length > 0) lines.push(`Allowed tools: ${tools.join(", ")}`);
  if (servers.length > 0) lines.push(`Allowed MCP servers: ${servers.join(", ")}`);
  if (tools.some((t) => t.startsWith("Bash "))) {
    lines.push(
      'A "Bash <program>" entry allows commands starting with that program, but only when the command runs nothing else:',
      "no ; && || | > < & backticks or $( ) outside quotes. If a command is refused, rephrasing it will not help: report the",
      "missing permission in your cockpit-error block and stop.",
    );
  }
  return lines;
}

/** Where a run works, as its prompt describes it. */
export interface RunPlace {
  cwd: string;
  /** The port Cockpit keeps for this run. */
  port?: number;
  /** Set when `cwd` is the issue's own worktree. */
  workspace?: IssueWorkspace;
}

function placeLines(place: RunPlace): string[] {
  const lines = [`Working directory: ${place.cwd}`];
  if (place.workspace) {
    lines.push(
      `It is this issue's own git worktree, on the branch ${place.workspace.branch}${place.workspace.base ? `, started from ${place.workspace.base}` : ""}.`,
      "Every agent that works on this issue works here, so what an earlier one left is in it. Work on that branch, in this directory.",
      "Do not make another worktree or branch for the issue, and do not remove this one: Cockpit does when the issue is finished.",
    );
  }
  if (place.port) {
    lines.push(
      `Port ${place.port} is kept for this run, and is in $COCKPIT_RUN_PORT. If you start a server, start it on that port and no other.`,
    );
  }
  return lines;
}

/** What an agent's session is told: where it is, what issue it has, which
 *  skill to run and how its work ends. A session that is being carried on is
 *  told so first, since it has been here before. */
export function buildRunPrompt(issue: Issue, project: Project, work: AgentWork, where: string | RunPlace, resumed = false): string {
  const place: RunPlace = typeof where === "string" ? { cwd: where } : where;
  const { skill, next } = work.rule;
  const opening = resumed
    ? [
        `${issue.key} has come back to "${work.workStatus}", and you are carrying on in the session that worked on it before.`,
        "What you found and wrote then still stands. Something has been asked for since: read the issue again to see what.",
        "There is still no human operator in this session: do not ask questions or wait for input.",
      ]
    : [
        `You are the agent for the "${work.workStatus}" status of a workflow on issue ${issue.key}, in Cockpit. There is no human operator in this session.`,
        "Do not ask clarifying questions and do not wait for input. Make reasonable assumptions and proceed.",
      ];
  return [
    ...opening,
    "",
    `Issue: ${issue.key} ${issue.title}`,
    `Project: ${project.name}`,
    ...placeLines(place),
    "",
    `What to do: run this repository's "${skill}" skill on ${issue.key}, with the Skill tool (skill: "${skill}"), and follow it.`,
    `It is how this project wants an issue in "${work.workStatus}" worked. The skill is at ${repoSkillPath(skill)} if you need to read it yourself.`,
    "",
    `Read the issue with mcp__cockpit-config__get_issue (key "${issue.key}"). Its description is the requirement, as a person wrote it.`,
    "Its `plan`, when it has one, is how the work is to be done, with the reviewer's feedback if the plan was sent back.",
    "Its comments carry what earlier agents found and anything a person has asked for since.",
    "",
    `When the work is done, move the issue on with mcp__cockpit-config__update_issue (key "${issue.key}") to one of these statuses:`,
    ...next.map((status) => `- "${status}"`),
    "The skill says which of them fits. That move is how your work ends, and those are the only statuses you can move the issue to.",
    "Make it your last action. A run that stops without making it counts as stalled.",
    "",
    "Subagents: the Agent tool runs asynchronously. Launching one does not end this run: when your turn ends while it works,",
    "the run stays open and the CLI wakes you with a task notification when the agent reports. Do not poll or sleep waiting for it.",
    "",
    "If you could not do the work at all (a missing permission, a tool that fails, a repository that is not what the issue assumes),",
    "say why in a comment on the issue, leave its status alone, and end your final message with a fenced code block tagged",
    'cockpit-error holding JSON: {"error":"what went wrong","details":"which tools failed and why"}. Emit that block only on failure.',
    "",
    ...permissionLines(work.rule),
  ].join("\n");
}

function nudge(issue: Issue, work: AgentWork): string {
  const moves = work.rule.next.map((status) => `"${status}"`).join(", ");
  return [
    `You stopped without moving ${issue.key} on, so your work on it has not ended.`,
    `If the work is done, move it now with mcp__cockpit-config__update_issue to one of: ${moves}.`,
    "If you could not do the work, say why in a comment on the issue and end with a cockpit-error block.",
  ].join("\n");
}

/** Whether an issue in `status` is one this work has yet to finish with. */
function holds(work: AgentWork, status: string): boolean {
  return status === work.workStatus || work.queues.includes(status);
}

export class WorkflowEngine {
  private live = new Map<string, Live>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private kicked: ReturnType<typeof setTimeout> | null = null;
  private filling = false;
  private again = false;

  constructor(private sessionManager: SessionManager) {}

  start(): void {
    this.recover();
    this.unsubscribe = onIssueStatusChange((event) => this.onStatusChange(event));
    this.timer = setInterval(() => this.kick(), SWEEP_MS);
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kicked) clearTimeout(this.kicked);
    this.timer = null;
    this.kicked = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Look for work soon. Deferred, so it never runs inside the save that prompted it. */
  kick(): void {
    if (this.kicked) return;
    this.kicked = setTimeout(() => {
      this.kicked = null;
      this.fill();
    }, 0);
  }

  private settings() {
    const d = getDefaults();
    return { on: d.issuesEnabled && d.workflowsEnabled, paused: d.workflowsPaused, max: Math.max(1, d.workflowMaxParallel || 1) };
  }

  /** A project's work whose skill is in its repo, and the work whose skill is
   *  not. A project with no folder at all is left for startRun to say so. */
  private workOf(project: Project, workflow: Workflow): { ready: AgentWork[]; blocked: AgentWork[] } {
    const all = agentWork(workflow);
    if (!project.repoPath || !existsSync(project.repoPath)) return { ready: all, blocked: [] };
    return {
      ready: all.filter((w) => hasRepoSkill(project.repoPath, w.rule.skill)),
      blocked: all.filter((w) => !hasRepoSkill(project.repoPath, w.rule.skill)),
    };
  }

  /**
   * Every issue waiting for an agent, most urgent first: in a queue, or in a
   * status an agent works in that nothing queues for. An issue sitting where
   * the agent works, when that status has a queue, is not waiting: it was put
   * there by hand, or was there before the workflow was, and starting an agent
   * on it could be a second one.
   */
  private candidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const project of loadProjects()) {
      if (project.archived) continue;
      const workflow = workflowForProject(project);
      if (!workflow?.enabled) continue;
      const { ready } = this.workOf(project, workflow);
      if (ready.length === 0) continue;
      for (const issue of loadIssues(project.id)) {
        if (issue.attention || this.live.has(issue.key.toUpperCase())) continue;
        const work = ready.find((w) => waitingStatuses(w).includes(issue.status));
        if (work) out.push({ project, workflow, work, issue });
      }
    }
    return out.sort((a, b) => byUrgency(a.issue, b.issue));
  }

  private hasRoom(c: Candidate): boolean {
    let inProject = 0;
    let inWork = 0;
    for (const run of this.live.values()) {
      if (run.projectId !== c.project.id) continue;
      inProject++;
      if (run.work.workStatus === c.work.workStatus) inWork++;
    }
    return inProject < c.workflow.maxParallel && inWork < (c.work.rule.maxParallel ?? Number.MAX_SAFE_INTEGER);
  }

  /** Start as many waiting issues as the limits allow. Safe to call at any time. */
  fill(): void {
    if (this.filling) {
      this.again = true;
      return;
    }
    this.filling = true;
    try {
      do {
        this.again = false;
        const { on, paused, max } = this.settings();
        if (!on || paused) return;
        for (const candidate of this.candidates()) {
          if (this.live.size >= max) break;
          if (this.hasRoom(candidate)) this.startRun(candidate);
        }
      } while (this.again);
    } finally {
      this.filling = false;
    }
  }

  private actor(live: Live, sessionId: string): IssueActor {
    return { kind: "workflow", workStatus: live.work.workStatus, skill: live.work.rule.skill, runId: live.runId, sessionId };
  }

  /** The work as the stored workflow has it now, when it is still the same
   *  work: an agent in that status running that skill. */
  private current(projectId: string, work: AgentWork): AgentWork | undefined {
    const workflow = workflowForProject({ id: projectId });
    if (!workflow) return undefined;
    return agentWork(workflow).find((w) => w.workStatus === work.workStatus && w.rule.skill === work.rule.skill);
  }

  /** The queue an issue goes back to wait in: where the run took it from,
   *  while that still feeds this work. */
  private queueFor(projectId: string, work: AgentWork, from: string | undefined): string | undefined {
    const now = this.current(projectId, work);
    return from && now?.queues.includes(from) ? from : undefined;
  }

  /**
   * Take the issue out of the queue and tell the user why. An issue left where
   * the agent was working goes back to the queue it came from, so where it
   * sits says what it is waiting for.
   */
  private flag(key: string, work: AgentWork, reason: string, by?: { actor: IssueActor; runId: string; from?: string }): void {
    let issue = getIssue(key);
    if (!issue) return;
    const back = by && issue.status === work.workStatus ? this.queueFor(issue.projectId, work, by.from) : undefined;
    if (by && back) {
      issue = applyIssueUpdate(
        issue,
        { status: back },
        by.actor,
        allowedStatusesFor(loadProjects().find((p) => p.id === issue?.projectId)),
      );
    }
    saveIssue({ ...issue, attention: { workStatus: work.workStatus, ...(by ? { runId: by.runId } : {}), reason, at: Date.now() } });
    logDiag(key, "workflow:attention", { workStatus: work.workStatus, reason });
    addInboxMessage({
      title: `${issue.key} needs you: ${work.workStatus}`,
      body: `**${issue.title}**\n\n${reason}\n\n[Open ${issue.key}](/issues/${issue.key})`,
      priority: "warning",
      url: `/issues/${issue.key}`,
      ...(by && by.actor.kind === "workflow" && by.actor.sessionId
        ? { sessionId: by.actor.sessionId, sessionName: `${issue.key} ${work.rule.skill}` }
        : {}),
      notifyProviders: work.rule.notifyProviders,
    });
  }

  private startRun(c: Candidate): void {
    const { project, work } = c;
    const issue = getIssue(c.issue.key);
    if (!issue || !waitingStatuses(work).includes(issue.status) || issue.attention) return;
    const key = issue.key.toUpperCase();
    if (this.live.has(key)) return;

    const ran = workRunCount(issue.key, work.workStatus, work.rule.skill);
    if (ran >= WORKFLOW_MAX_WORK_RUNS) {
      this.flag(
        issue.key,
        work,
        `An agent has worked on this in "${work.workStatus}" ${ran} times and it keeps coming back. Run it again to let it have another go.`,
      );
      return;
    }
    const cwd = project.repoPath;
    if (!cwd || !existsSync(cwd)) {
      this.flag(
        issue.key,
        work,
        `Project "${project.name}" has no repository folder${cwd ? ` at ${cwd}` : ""}. Set one in Settings, Projects.`,
      );
      return;
    }
    const model = checkJobModel(work.rule.model);
    if (!model.ok) {
      this.flag(issue.key, work, model.reason);
      return;
    }

    const runId = uuidv4();
    const live: Live = { issueKey: issue.key, projectId: project.id, work, runId, from: issue.status, nudged: false };
    // Held before the session exists, so nothing else can claim the issue
    // while it is being started.
    this.live.set(key, live);

    if (work.rule.workspace !== "worktree") {
      this.launch(live, issue, project, cwd);
      return;
    }
    // The issue's own checkout may have to be made first, which is git's
    // time to take. The slot is held meanwhile.
    ensureWorkspace(project, issue).then(
      (workspace) => {
        // Moved, held or deleted while git worked: the run is not wanted.
        if (this.live.get(key) !== live) return;
        const fresh = getIssue(issue.key);
        // The workflow may have been changed in that time too. The run is
        // judged by the stored rule, so it starts from it or not at all.
        const now = this.current(project.id, work);
        if (!fresh || !now || !waitingStatuses(now).includes(fresh.status) || fresh.attention) {
          this.release(key);
          return;
        }
        live.work = now;
        live.from = fresh.status;
        const saved = fresh.workspace?.path === workspace.path ? fresh : { ...fresh, workspace };
        if (saved !== fresh) saveIssue(saved);
        this.launch(live, saved, project, workspace.path);
      },
      (err) => {
        if (this.live.get(key) !== live) return;
        this.live.delete(key);
        this.flag(issue.key, work, `Its worktree could not be made: ${err instanceof Error ? err.message : String(err)}`);
        this.kick();
      },
    );
  }

  /** The session an agent worked this issue in last time, when it carries on in it. */
  private sessionToContinue(issue: Issue, work: AgentWork, cwd: string): string | undefined {
    if (!work.rule.continueSession) return undefined;
    const last = runsOf(issue.key, work.workStatus, work.rule.skill)
      .filter((r) => r.status === "success" && r.sessionId && r.cwd === cwd)
      .at(-1);
    return last?.sessionId;
  }

  /** Start the session for a run whose slot is already held. */
  private launch(live: Live, issue: Issue, project: Project, cwd: string): void {
    const { work, runId } = live;
    const rule = work.rule;
    const key = issue.key.toUpperCase();

    // The skill is checked where the run will work. An issue's own worktree is
    // cut from a branch, so a skill that exists only in the project's folder,
    // uncommitted or on another branch, is not in it.
    if (!hasRepoSkill(cwd, rule.skill)) {
      this.live.delete(key);
      const where = issue.workspace?.path === cwd ? `${issue.key}'s worktree (branch ${issue.workspace.branch}, at ${cwd})` : cwd;
      this.flag(
        issue.key,
        work,
        `There is no "${rule.skill}" skill in ${where}. Add ${repoSkillPath(rule.skill)} there${
          issue.workspace?.path === cwd ? ", or merge the branch that has it into this one," : ""
        } and run it again.`,
      );
      this.kick();
      return;
    }

    const permission = rule.permission ?? "bypass";
    const contextSize = rule.contextSize && rule.contextSize in CONTEXT_SIZES ? (rule.contextSize as ContextSize) : undefined;
    const minutes = rule.maxDurationMinutes ?? DEFAULT_RUN_MINUTES;
    logDiag(issue.key, "workflow:run-start", { runId, workStatus: work.workStatus, skill: rule.skill, model: rule.model, permission, cwd });

    try {
      trustDirectory(cwd);
      const port = reserveRunPort(runId);
      const place = { cwd, port, workspace: issue.workspace?.path === cwd ? issue.workspace : undefined };
      startAgentRun<WorkflowRun>(this.sessionManager, {
        log: { prefix: "workflow", fields: { issueKey: issue.key, workStatus: work.workStatus, runId } },
        cwd,
        sessionName: `[${issue.key}] ${rule.skill}`,
        resumeSessionId: this.sessionToContinue(issue, work, cwd),
        prompt: (resumed) => buildRunPrompt(issue, project, work, place, resumed),
        session: {
          bypassPermissions: permission === "bypass",
          sandbox: { enabled: rule.sandbox === true },
          runtime: rule.runtime,
          workflowContext: {
            projectId: project.id,
            workStatus: work.workStatus,
            skill: rule.skill,
            runId,
            issueKey: issue.key,
            notifyProviders: rule.notifyProviders,
          },
          runEnv: { COCKPIT_RUN_PORT: String(port), COCKPIT_ISSUE_KEY: issue.key },
        },
        model: rule.model,
        contextSize,
        thinkingLevel: rule.thinkingLevel,
        permissions:
          permission === "bypass"
            ? { kind: "bypass" }
            : permission === "ask"
              ? { kind: "ask" }
              : {
                  kind: "allowlist",
                  // The Skill tool is how the run does its job, and the issue
                  // tools how it ends, so an allowlist never has to name them.
                  allowedTools: [...new Set([...(rule.allowedTools ?? []), "Skill"])],
                  mcpToolFilters: rule.mcpToolFilters,
                  inboxTool: true,
                },
        mcpServers: permission === "allowlist" ? [...(rule.mcpServers ?? []), "cockpit-config"] : (rule.mcpServers ?? []),
        // Whatever the rule lists, the server the run ends through stays on.
        keepServers: ["cockpit-config"],
        maxDurationMinutes: minutes,
        record: (session) => ({
          id: runId,
          workStatus: work.workStatus,
          skill: rule.skill,
          issueKey: issue.key,
          projectId: project.id,
          sessionId: session.id,
          status: "running",
          startedAt: Date.now(),
          from: live.from,
          ...(rule.model ? { model: rule.model } : {}),
          toolsUsed: [],
          messageCount: 0,
          cwd,
        }),
        save: saveWorkflowRun,
        started: (run, settle) => {
          live.record = run;
          live.settle = settle;
          try {
            this.claim(live, run);
          } catch (err) {
            // The status the agent works in is gone from the project, or the
            // like. The session is already up and has nothing it can do.
            const reason = `It could not be moved to "${work.workStatus}": ${err instanceof Error ? err.message : String(err)}`;
            this.stopLive(live, reason);
            this.flag(issue.key, work, reason, { actor: this.actor(live, run.sessionId), runId: run.id });
            this.kick();
          }
        },
        idle: () => this.onIdle(live),
        ended: (run) => this.onEnded(live, run),
        released: () => this.release(key),
        stopped: () => this.release(key),
      });
    } catch (err) {
      releaseRunPorts(runId);
      this.live.delete(key);
      this.flag(issue.key, work, `The run could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The run owns the issue from here: it moves from its queue to where the agent works. */
  private claim(live: Live, run: WorkflowRun): void {
    const { work } = live;
    const issue = getIssue(live.issueKey);
    if (!issue) return;
    // Read now, not when the slot was taken: the worktree step in between is long enough for it to have moved.
    live.from = issue.status;
    run.from = issue.status;
    if (issue.status === work.workStatus || !work.queues.includes(issue.status)) {
      saveWorkflowRun(run);
      return;
    }
    const project = loadProjects().find((p) => p.id === issue.projectId);
    saveIssue(applyIssueUpdate(issue, { status: work.workStatus }, this.actor(live, run.sessionId), allowedStatusesFor(project)));
    saveWorkflowRun(run);
  }

  /** A turn ended. The work is over only if the issue has moved on. */
  private onIdle(live: Live): IdleVerdict {
    const issue = getIssue(live.issueKey);
    if (!issue) return { status: "failure", error: "The issue no longer exists" };
    if (live.left || !holds(live.work, issue.status)) return { status: "success" };
    const sessionId = live.record?.sessionId;
    if (!live.nudged && sessionId) {
      live.nudged = true;
      logDiag(live.issueKey, "workflow:nudge", { runId: live.runId });
      this.sessionManager.sendMessage(sessionId, nudge(issue, live.work));
      return "wait";
    }
    return { status: "failure", error: `The run ended without moving ${issue.key} on to a next status.` };
  }

  /** The run is over and saved. Decide what becomes of the issue. */
  private onEnded(live: Live, run: WorkflowRun): void {
    const issue = getIssue(live.issueKey);
    if (!issue) return;
    const { work } = live;
    if (live.left || !holds(work, issue.status)) {
      // Wherever it went, the work is over, whatever the turn's last words were.
      run.to = live.left ?? issue.status;
      saveWorkflowRun(run);
      return;
    }
    const by = { actor: this.actor(live, run.sessionId), runId: run.id, from: live.from };
    const reason = run.error || "The run failed without saying why.";
    // A failure gets another go, up to the rule's limit; a run that used up
    // its whole time allowance does not, since the next would do the same.
    const failed = this.failedInARow(live.issueKey, work);
    if (run.status === "failure" && failed <= (work.rule.maxRetries ?? DEFAULT_RUN_RETRIES)) {
      logDiag(live.issueKey, "workflow:retry", { runId: run.id, failed, error: reason });
      const back = issue.status === work.workStatus ? this.queueFor(issue.projectId, work, live.from) : undefined;
      if (back) {
        const project = loadProjects().find((p) => p.id === issue.projectId);
        saveIssue(applyIssueUpdate(issue, { status: back }, by.actor, allowedStatusesFor(project)));
      } else if (work.queues.length > 0 && issue.status === work.workStatus) {
        // Its queue is gone, so it cannot wait there for another go.
        this.flag(live.issueKey, work, reason, by);
      }
      return;
    }
    this.flag(live.issueKey, work, reason, by);
  }

  /** How many runs of this work on an issue have failed since one last succeeded. */
  private failedInARow(issueKey: string, work: AgentWork): number {
    const runs = runsOf(issueKey, work.workStatus, work.rule.skill);
    let failed = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i].status !== "success" && runs[i].status !== "stopped"; i--) failed++;
    return failed;
  }

  private release(key: string): void {
    const live = this.live.get(key);
    this.live.delete(key);
    if (live) {
      releaseRunPorts(live.runId);
      this.tidy(live.issueKey);
    }
    this.kick();
  }

  /**
   * Remove the worktree of an issue that is finished. Not while a run is
   * still in it: the agent that merges moves the issue to Done before its
   * session has said its last word.
   */
  private tidy(issueKey: string): void {
    const issue = getIssue(issueKey);
    if (!issue?.workspace || !FINISHED.has(issue.status) || this.live.has(issue.key.toUpperCase())) return;
    const { workspace: gone, ...rest } = issue;
    saveIssue(rest);
    logDiag(issue.key, "workflow:worktree-removed", { path: gone.path });
    void removeWorkspace(
      loadProjects().find((p) => p.id === issue.projectId),
      gone,
    );
  }

  /** An issue is about to be deleted: its worktree goes with it. */
  discard(issueKey: string): void {
    const issue = getIssue(issueKey);
    if (!issue?.workspace) return;
    void removeWorkspace(
      loadProjects().find((p) => p.id === issue.projectId),
      issue.workspace,
    );
  }

  private onStatusChange(event: IssueStatusChangeEvent): void {
    const { on } = this.settings();
    if (on) this.react(event);
    this.kick();
  }

  /** What a status change means beyond "look for work": a run that moved its
   *  issue on is done with it, a person who moved an issue has taken it over,
   *  and a person may be who it now waits for. */
  private react(event: IssueStatusChangeEvent): void {
    const issue = getIssue(event.key);
    if (!issue) return;
    const project = loadProjects().find((p) => p.id === issue.projectId);
    const workflow = workflowForProject(project);
    const mover = lastMover(issue);
    const live = this.live.get(issue.key.toUpperCase());

    if (mover?.kind === "workflow") {
      // The run's own move out of where it works is the end of its work. It
      // is noted now because a person may send the issue straight back before
      // the session has stopped, and that must not look like it never moved.
      if (live && mover.runId === live.runId && !holds(live.work, issue.status)) live.left = issue.status;
    } else {
      // A person (or a session of theirs) moved it. A run still working on it
      // is working on something that is no longer asked for.
      if (live && !live.left && !holds(live.work, issue.status)) {
        this.stopLive(live, `Stopped: ${issue.key} was moved to "${issue.status}" while an agent was working on it.`);
      }
      // Moving it into a queue or to where an agent works, by hand, is asking for that work afresh.
      const arrived = workflow ? workAt(workflow, issue.status) : undefined;
      if (arrived) resetWorkRuns(issue.key, arrived.workStatus, arrived.rule.skill);
      if (issue.attention) {
        const { attention: _cleared, ...rest } = issue;
        saveIssue(rest);
      }
    }

    this.tidy(issue.key);

    if (!workflow?.enabled) return;
    const rule = ruleAt(workflow, issue.status);
    if (rule?.kind === "human" && event.from !== event.to) {
      addInboxMessage({
        title: `${issue.key} is waiting for you: ${issue.status}`,
        body: `**${issue.title}**\n\n[Open ${issue.key}](/issues/${issue.key})`,
        priority: "info",
        url: `/issues/${issue.key}`,
        notifyProviders: rule.notifyProviders,
      });
    }
  }

  private stopLive(live: Live, reason: string): void {
    const run = live.record;
    this.live.delete(live.issueKey.toUpperCase());
    releaseRunPorts(live.runId);
    if (!run || run.completedAt) return;
    run.status = "stopped";
    run.error = reason;
    run.completedAt = Date.now();
    run.durationMs = run.completedAt - run.startedAt;
    this.sessionManager.destroySession(run.sessionId);
    saveWorkflowRun(run);
    live.settle?.(run);
    logDiag(live.issueKey, "workflow:stopped", { runId: run.id, reason });
  }

  /** Stop the run on an issue and hold the issue until someone retries it. */
  stopRun(issueKey: string): WorkflowRun {
    const live = this.live.get(issueKey.toUpperCase());
    if (!live?.record) throw new Error(`No run is working on ${issueKey}`);
    const run = live.record;
    this.stopLive(live, "Stopped by you");
    this.flag(live.issueKey, live.work, "Stopped by you.", { actor: this.actor(live, run.sessionId), runId: run.id, from: live.from });
    this.kick();
    return run;
  }

  /**
   * Let an agent work on an issue again: one that is held, or one left where
   * an agent works with nothing working on it. It goes back to wait its turn.
   */
  retry(issueKey: string): Issue {
    const issue = getIssue(issueKey);
    if (!issue) throw new Error(`Issue not found: ${issueKey}`);
    const project = loadProjects().find((p) => p.id === issue.projectId);
    const workflow = workflowForProject(project);
    const work = workflow ? workAt(workflow, issue.status) : undefined;
    if (!work) throw new Error(`${issue.key} is not at a status an agent works on`);
    if (this.live.has(issue.key.toUpperCase())) throw new Error(`A run is already working on ${issue.key}`);
    resetWorkRuns(issue.key, work.workStatus, work.rule.skill);
    const { attention: _cleared, ...rest } = issue;
    let next: Issue = rest;
    if (work.queues.length > 0 && next.status === work.workStatus) {
      const from = runsOf(issue.key, work.workStatus, work.rule.skill).at(-1)?.from;
      const back = from && work.queues.includes(from) ? from : work.queues[0];
      next = applyIssueUpdate(next, { status: back }, { kind: "user" }, allowedStatusesFor(project));
    }
    saveIssue(next);
    this.kick();
    return next;
  }

  /** A project's workflow is gone: its runs stop, and nothing of its stays held. */
  forget(projectId: string): void {
    for (const live of [...this.live.values()]) {
      if (live.projectId === projectId) this.stopLive(live, "Stopped: the project's workflow was removed.");
    }
    for (const issue of loadIssues(projectId)) {
      if (!issue.attention) continue;
      const { attention: _cleared, ...rest } = issue;
      saveIssue(rest);
    }
  }

  /**
   * Runs a restart cut short. Each is closed as failed, and its issue goes
   * back to wait for an agent again, once: an issue whose last run of that
   * work was also cut short is held, in case it is what brings Cockpit down.
   */
  private recover(): void {
    for (const run of loadUnfinishedRuns()) {
      const before = run.workStatus ? runsOf(run.issueKey, run.workStatus, run.skill).filter((r) => r.id !== run.id) : [];
      const repeat = before.at(-1)?.error === RESTART_ERROR;
      run.status = "failure";
      run.error = RESTART_ERROR;
      run.completedAt = Date.now();
      run.durationMs = run.completedAt - run.startedAt;
      saveWorkflowRun(run);
      const issue = getIssue(run.issueKey);
      if (!issue || !run.workStatus) continue;
      const project = loadProjects().find((p) => p.id === issue.projectId);
      const workflow = workflowForProject(project);
      const work = workflow && agentWork(workflow).find((w) => w.workStatus === run.workStatus && w.rule.skill === run.skill);
      if (!work || !holds(work, issue.status)) continue;
      const actor: IssueActor = { kind: "workflow", workStatus: run.workStatus, skill: run.skill, runId: run.id, sessionId: run.sessionId };
      if (repeat) {
        this.flag(issue.key, work, "Cockpit restarted twice while an agent was working on this. Run it again when you are ready.", {
          actor,
          runId: run.id,
          from: run.from,
        });
      } else if (issue.status === work.workStatus && work.queues.includes(run.from)) {
        saveIssue(applyIssueUpdate(issue, { status: run.from }, actor, allowedStatusesFor(project)));
      } else if (issue.status === work.workStatus && work.queues.length > 0) {
        // Nowhere to wait: it would sit where the agent works with nothing working on it.
        this.flag(issue.key, work, "Cockpit restarted while an agent was working on this. Run it again when you are ready.", {
          actor,
          runId: run.id,
        });
      }
    }
  }

  /** The run on an issue right now, if there is one. */
  liveRun(issueKey: string): WorkflowRun | undefined {
    return this.live.get(issueKey.toUpperCase())?.record;
  }

  /** What is running, what is waiting and what is held, for the activity view. */
  activity(): WorkflowActivity {
    const { on, paused, max } = this.settings();
    const row = (issue: Issue, skill?: string): WorkflowActivityRow => ({
      issueKey: issue.key,
      title: issue.title,
      projectId: issue.projectId,
      status: issue.status,
      ...(skill ? { skill } : {}),
    });
    const running: WorkflowActivity["running"] = [];
    const preparing: WorkflowActivityRow[] = [];
    for (const live of this.live.values()) {
      const issue = getIssue(live.issueKey);
      if (!issue) continue;
      if (!live.record) {
        preparing.push(row(issue, live.work.rule.skill));
        continue;
      }
      running.push({
        ...row(issue, live.work.rule.skill),
        runId: live.runId,
        sessionId: live.record.sessionId,
        startedAt: live.record.startedAt,
      });
    }
    const attention: WorkflowActivity["attention"] = [];
    const waiting: WorkflowActivity["waiting"] = [];
    const statuses: WorkflowActivity["statuses"] = {};
    const blocked: WorkflowActivity["blocked"] = [];
    if (on) {
      for (const project of loadProjects()) {
        const workflow = workflowForProject(project);
        if (!workflow || project.archived) continue;
        const missing = new Set(this.workOf(project, workflow).blocked.map((w) => w.workStatus));
        for (const status of missing)
          blocked.push({ projectId: project.id, status, skill: (workflow.statuses[status] as WorkflowAgentRule).skill });
        statuses[project.id] = Object.entries(workflow.statuses).map(([status, rule]): WorkflowStatusInfo => {
          if (rule.kind === "human") return { status, kind: "human", ...(rule.review ? { review: rule.review } : {}) };
          if (rule.kind === "agent") return { status, kind: "agent", skill: rule.skill, ...(missing.has(status) ? { missing: true } : {}) };
          const to = ruleAt(workflow, rule.to);
          return {
            status,
            kind: "queue",
            to: rule.to,
            ...(to?.kind === "agent" ? { skill: to.skill } : {}),
            ...(missing.has(rule.to) ? { missing: true } : {}),
          };
        });
        for (const issue of loadIssues(project.id)) {
          if (issue.attention) {
            const held = ruleAt(workflow, issue.attention.workStatus);
            attention.push({
              ...row(issue, held?.kind === "agent" ? held.skill : undefined),
              reason: issue.attention.reason,
              at: issue.attention.at,
            });
          }
          if (ruleAt(workflow, issue.status)?.kind === "human") waiting.push(row(issue));
        }
      }
    }
    return {
      enabled: on,
      paused,
      slots: { used: this.live.size, max },
      running: running.sort((a, b) => a.startedAt - b.startedAt),
      queued: [...preparing, ...(on ? this.candidates().map((c) => row(c.issue, c.work.rule.skill)) : [])],
      waiting,
      statuses,
      blocked,
      attention: attention.sort((a, b) => b.at - a.at),
    };
  }
}

const RESTART_ERROR = "Cockpit restarted while this run was going";
