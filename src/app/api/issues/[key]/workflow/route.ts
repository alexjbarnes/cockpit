import { existsSync } from "node:fs";
import { type NextRequest, NextResponse } from "next/server";
import { resolveProjectStatuses } from "@/lib/issue-display";
import { validateSession } from "@/server/auth";
import { getIssue, getProject } from "@/server/issue-storage";
import { getWorkflowEngine } from "@/server/singleton";
import { hasRepoSkill } from "@/server/skills";
import { agentWork, loadWorkflowRuns, projectRunsWorkflow, workAt, workflowForProject } from "@/server/workflow-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Where an issue is in its project's workflow: what happens at each status,
 * the project's statuses in board order, the run working on it now, and the
 * runs it has had. `workflow` is null for an issue whose project has none,
 * and `active` says whether the engine is moving it.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const issue = getIssue((await params).key);
  if (!issue) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const project = getProject(issue.projectId);
  const workflow = workflowForProject(project);
  if (!workflow) return NextResponse.json({ workflow: null });
  const liveRunId = getWorkflowEngine()?.liveRun(issue.key)?.id ?? null;
  const work = workAt(workflow, issue.status);
  const hasRepo = !!project?.repoPath && existsSync(project.repoPath);
  // The tool calls of every run are not for a status strip; the run's page has them.
  const runs = loadWorkflowRuns(issue.key).map(({ toolsUsed, ...run }) => ({ ...run, toolCount: toolsUsed.length }));
  return NextResponse.json({
    workflow: { enabled: workflow.enabled, statuses: workflow.statuses },
    order: resolveProjectStatuses(project).map((s) => s.name),
    active: projectRunsWorkflow(issue.projectId),
    liveRunId,
    attention: issue.attention ?? null,
    // Where an agent works, with a queue in front, and nothing working on it:
    // it was put here by hand, and waits to be queued.
    idle: !!work && work.queues.length > 0 && issue.status === work.workStatus && !liveRunId && !issue.attention,
    // Agents that cannot start because their skill is not in the repo.
    missingSkills: hasRepo
      ? agentWork(workflow)
          .filter((w) => !hasRepoSkill(project?.repoPath, w.rule.skill))
          .map((w) => w.workStatus)
      : [],
    runs,
  });
}
