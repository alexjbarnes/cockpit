import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getProject } from "@/server/issue-storage";
import { getWorkflowEngine } from "@/server/singleton";
import { deleteWorkflow, reusableForProject, setProjectWorkflow, type WorkflowInput } from "@/server/workflow-storage";
import { workflowView } from "@/server/workflow-view";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

type Params = { params: Promise<{ id: string }> };

/** A project's workflow with what is needed to edit it: its statuses in board
 *  order, the skills in its repo, and what stops an agent starting. */
export async function GET(req: NextRequest, { params }: Params) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = getProject((await params).id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(workflowView(project));
}

/** Create or change the project's workflow. `statuses` merges by name unless
 *  `replace` is true, when it is the whole workflow. */
export async function PUT(req: NextRequest, { params }: Params) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = getProject((await params).id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.reusableWorkflowId) {
    const shared = reusableForProject(project);
    return NextResponse.json(
      {
        error: `${project.name} uses the reusable workflow "${shared?.name ?? project.reusableWorkflowId}". Change it in Settings, Workflows, or stop using it first.`,
      },
      { status: 400 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "A workflow is required" }, { status: 400 });
  // Only the fields a workflow has, so nothing else a caller sends is stored.
  const patch: WorkflowInput = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
  if (body.maxParallel !== undefined) patch.maxParallel = body.maxParallel as number;
  if (body.statuses !== undefined) patch.statuses = body.statuses;
  if (body.replace === true) patch.replace = true;
  try {
    const saved = setProjectWorkflow(project, patch);
    // Issues may now be waiting for an agent.
    getWorkflowEngine()?.kick();
    return NextResponse.json({ ...workflowView(getProject(project.id) ?? project), addedStatuses: saved.added });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save the workflow" }, { status: 400 });
  }
}

/** Remove the project's own workflow. Its runs are stopped and nothing stays
 *  held. A project using a reusable workflow must stop using it first. */
export async function DELETE(req: NextRequest, { params }: Params) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = getProject((await params).id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.reusableWorkflowId) {
    const shared = reusableForProject(project);
    return NextResponse.json(
      {
        error: `${project.name} uses the reusable workflow "${shared?.name ?? project.reusableWorkflowId}". Stop using it first, in Settings, Workflows.`,
      },
      { status: 400 },
    );
  }
  getWorkflowEngine()?.forget(project.id);
  deleteWorkflow(project.id);
  return NextResponse.json({ ok: true });
}
