import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { loadProjects } from "@/server/issue-storage";
import { loadReusableWorkflows, reusableForProject, workflowForProject } from "@/server/workflow-storage";
import type { ReusableWorkflow } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/**
 * Every project with its workflow (its own or the reusable one it selects) and
 * every reusable workflow, so Settings can show both without a second fetch.
 */
export function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projects = loadProjects().filter((p) => !p.archived);
  const reusable: ReusableWorkflow[] = loadReusableWorkflows();
  return NextResponse.json({
    projects: projects.map((p) => {
      const shared = reusableForProject(p);
      const workflow = workflowForProject(p);
      return {
        id: p.id,
        name: p.name,
        prefix: p.prefix,
        repoPath: p.repoPath ?? null,
        workflow: workflow ?? null,
        source: shared
          ? { kind: "reusable", id: shared.id, name: shared.name }
          : p.reusableWorkflowId
            ? { kind: "missing", id: p.reusableWorkflowId }
            : workflow
              ? { kind: "own" }
              : { kind: "none" },
      };
    }),
    reusable: reusable.map((w) => ({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      maxParallel: w.maxParallel,
      statuses: w.statuses,
      usedBy: projects.filter((p) => p.reusableWorkflowId === w.id).map((p) => p.prefix),
    })),
  });
}
