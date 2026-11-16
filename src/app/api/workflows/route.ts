import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { loadProjects } from "@/server/issue-storage";
import { workflowForProject } from "@/server/workflow-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Every project with its workflow, or null when it has none. A workflow
 *  belongs to one project, so this is the list of them. */
export function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({
    projects: loadProjects()
      .filter((p) => !p.archived)
      .map((p) => ({
        id: p.id,
        name: p.name,
        prefix: p.prefix,
        repoPath: p.repoPath ?? null,
        workflow: workflowForProject(p) ?? null,
      })),
  });
}
