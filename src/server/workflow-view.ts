// A project's workflow as a caller needs it to read or change it: the
// workflow, the project's statuses in board order, the skills its repo holds,
// and what stands in the way of it running. One shape for the settings page
// and the MCP tools, so an agent setting a workflow up sees what a person does.

import { existsSync } from "node:fs";
import { resolveProjectStatuses } from "@/lib/issue-display";
import type { Project, Workflow } from "@/types";
import { listRepoSkills, type RepoSkill, repoSkillPath } from "./skills";
import { agentWork, workflowForProject } from "./workflow-storage";

export interface WorkflowView {
  project: { id: string; name: string; prefix: string; repoPath?: string; baseBranch?: string };
  workflow: Workflow | null;
  /** The project's statuses, in the order its board shows them. */
  statuses: string[];
  /** The skills in the project's repo, by folder name. */
  skills: RepoSkill[];
  /** Why an agent here would not start, in words for a person. */
  problems: string[];
}

export function workflowView(project: Project): WorkflowView {
  const workflow = workflowForProject(project) ?? null;
  const hasRepo = !!project.repoPath && existsSync(project.repoPath);
  const skills = hasRepo ? listRepoSkills(project.repoPath) : [];
  const problems: string[] = [];
  if (!project.repoPath)
    problems.push(`${project.name} has no repo path, so there is nowhere to read skills from. Set one in Settings, Projects.`);
  else if (!hasRepo) problems.push(`${project.name}'s repo path ${project.repoPath} does not exist.`);
  if (workflow && hasRepo) {
    const have = new Set(skills.map((s) => s.name));
    for (const work of agentWork(workflow)) {
      if (!have.has(work.rule.skill)) {
        problems.push(
          `"${work.workStatus}" runs the skill "${work.rule.skill}", which is not in the repo. Add ${repoSkillPath(work.rule.skill)}. Nothing starts there until it exists.`,
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
    statuses: resolveProjectStatuses(project).map((s) => s.name),
    skills,
    problems,
  };
}
