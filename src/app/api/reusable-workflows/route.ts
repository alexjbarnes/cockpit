import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { loadProjects } from "@/server/issue-storage";
import { getWorkflowEngine } from "@/server/singleton";
import { loadReusableWorkflows, type ReusableWorkflowInput, setReusableWorkflow } from "@/server/workflow-storage";
import { reusableWorkflowView } from "@/server/workflow-view";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

/** Every reusable workflow and the projects that select it. */
export function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projects = loadProjects();
  return NextResponse.json({
    reusable: loadReusableWorkflows().map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      enabled: workflow.enabled,
      maxParallel: workflow.maxParallel,
      statuses: workflow.statuses,
      usedBy: projects.filter((p) => p.reusableWorkflowId === workflow.id).map((p) => ({ id: p.id, name: p.name, prefix: p.prefix })),
    })),
  });
}

/** Create a reusable workflow. Give a name; rules can follow in the editor. */
export async function POST(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "A workflow is required" }, { status: 400 });
  const input: ReusableWorkflowInput = {};
  if (body.name !== undefined) input.name = body.name;
  if (body.enabled !== undefined) input.enabled = body.enabled;
  if (body.maxParallel !== undefined) input.maxParallel = body.maxParallel;
  if (body.statuses !== undefined) input.statuses = body.statuses;
  if (body.replace === true) input.replace = true;
  try {
    const saved = setReusableWorkflow(input);
    getWorkflowEngine()?.kick();
    return NextResponse.json(reusableWorkflowView(saved.workflow), { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save the workflow" }, { status: 400 });
  }
}
