// A project's workflow as a caller needs it to read or change it: the
// workflow, where it comes from, the project's statuses in board order, the
// skills its runs could use, and what stands in the way of it running. One
// shape for the settings page and the MCP tools, so an agent setting a
// workflow up sees what a person does.

import { existsSync } from "node:fs";
import { resolveProjectStatuses } from "@/lib/issue-display";
import { ISSUE_STATUSES, type Project, type ReusableWorkflow, type Workflow } from "@/types";
import { loadProjects } from "./issue-storage";
import { hasWorkflowSkill, listWorkflowSkills, repoSkillPath, userSkillPath, type WorkflowSkill } from "./skills";
import { agentWork, loadReusableWorkflows, reusableForProject, workflowForProject, workflowStatuses } from "./workflow-storage";

/** Where a project's effective workflow comes from. */
export type WorkflowSource =
  | { kind: "own" }
  | { kind: "reusable"; id: string; name: string }
  | { kind: "none" }
  | { kind: "missing"; id: string };

export interface WorkflowView {
  project: { id: string; name: string; prefix: string; repoPath?: string; baseBranch?: string };
  workflow: Workflow | null;
  source: WorkflowSource;
  /** The reusable workflows this project could switch to. */
  reusableWorkflows: { id: string; name: string }[];
  /** The project's statuses, in the order its board shows them. */
  statuses: string[];
  /** The skills a run here could use: the repo's, then the user's fallback. */
  skills: WorkflowSkill[];
  /** Why an agent here would not start, in words for a person. */
  problems: string[];
}

export function workflowView(project: Project): WorkflowView {
  const shared = reusableForProject(project);
  const workflow = workflowForProject(project) ?? null;
  const source: WorkflowSource = shared
    ? { kind: "reusable", id: shared.id, name: shared.name }
    : project.reusableWorkflowId
      ? { kind: "missing", id: project.reusableWorkflowId }
      : workflow
        ? { kind: "own" }
        : { kind: "none" };

  const hasRepo = !!project.repoPath && existsSync(project.repoPath);
  const skills = listWorkflowSkills([hasRepo ? project.repoPath : undefined]);
  const problems: string[] = [];
  if (!project.repoPath) {
    problems.push(`${project.name} has no repo path. Set one in Settings, Projects, or no agent can work here.`);
  } else if (!hasRepo) {
    problems.push(`${project.name}'s repo path ${project.repoPath} does not exist.`);
  }
  if (source.kind === "missing") {
    problems.push(
      `This project selects a reusable workflow that no longer exists (${source.id}). Choose its own workflow or another one in Settings, Workflows.`,
    );
  }
  if (workflow) {
    for (const work of agentWork(workflow)) {
      if (!hasWorkflowSkill(hasRepo ? project.repoPath : undefined, work.rule.skill)) {
        problems.push(
          `"${work.workStatus}" runs the skill "${work.rule.skill}", which is not in the repo or your user skills. Add ${repoSkillPath(
            work.rule.skill,
          )} or ${userSkillPath(work.rule.skill)}. Nothing starts there until it exists.`,
        );
      }
    }
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      prefix: project.prefix,
      ...(project.repoPath ? { repoPath: project.repoPath } : {}),
      ...(project.baseBranch ? { baseBranch: project.baseBranch } : {}),
    },
    workflow,
    source,
    reusableWorkflows: loadReusableWorkflows().map(({ id, name }) => ({ id, name })),
    statuses: resolveProjectStatuses(project).map((s) => s.name),
    skills,
    problems,
  };
}

export interface ReusableWorkflowView {
  workflow: ReusableWorkflow;
  /** The projects that select it, with why a run would not start in each. */
  usedBy: { id: string; name: string; prefix: string; problems: string[] }[];
  /** Every skill it could name, across the projects and the user directory. */
  skills: WorkflowSkill[];
  /** Statuses it can be given rules for: the lifecycle and every project's board. */
  statuses: string[];
}

/** A reusable workflow as its editor and the MCP tools need it. */
export function reusableWorkflowView(workflow: ReusableWorkflow): ReusableWorkflowView {
  const projects = loadProjects().filter((p) => !p.archived);
  const usedBy = projects
    .filter((p) => p.reusableWorkflowId === workflow.id)
    .map((p) => ({ id: p.id, name: p.name, prefix: p.prefix, problems: workflowView(p).problems }));

  const statuses = new Set<string>(ISSUE_STATUSES);
  for (const status of workflowStatuses(workflow)) statuses.add(status);
  for (const project of projects) for (const status of resolveProjectStatuses(project)) statuses.add(status.name);

  return {
    workflow,
    usedBy,
    skills: listWorkflowSkills(projects.map((p) => p.repoPath)),
    statuses: [...statuses],
  };
}
