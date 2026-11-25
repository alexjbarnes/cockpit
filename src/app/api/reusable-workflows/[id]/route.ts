import { type NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getWorkflowEngine } from "@/server/singleton";
import { deleteReusableWorkflow, getReusableWorkflow, type ReusableWorkflowInput, setReusableWorkflow } from "@/server/workflow-storage";
import { reusableWorkflowView } from "@/server/workflow-view";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

type Params = { params: Promise<{ id: string }> };

/** One reusable workflow with the projects selecting it, their problems, the
 *  skills it could name and the statuses it can be given rules for. */
export async function GET(req: NextRequest, { params }: Params) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workflow = getReusableWorkflow((await params).id);
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(reusableWorkflowView(workflow));
}

/** Change a reusable workflow. Its statuses are synced into every project that
 *  selects it; the response names the projects whose boards changed. */
export async function PUT(req: NextRequest, { params }: Params) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = (await params).id;
  if (!getReusableWorkflow(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "A workflow is required" }, { status: 400 });
  const input: ReusableWorkflowInput = { id };
  if (body.name !== undefined) input.name = body.name;
  if (body.enabled !== undefined) input.enabled = body.enabled;
  if (body.maxParallel !== undefined) input.maxParallel = body.maxParallel;
  if (body.statuses !== undefined) input.statuses = body.statuses;
  if (body.replace === true) input.replace = true;
  try {
    const saved = setReusableWorkflow(input);
    getWorkflowEngine()?.kick();
    return NextResponse.json({ ...reusableWorkflowView(saved.workflow), projects: saved.projects });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save the workflow" }, { status: 400 });
  }
}

/** Remove a reusable workflow nobody selects. In use, it refuses and names the
 *  projects that have to switch away first. */
export async function DELETE(req: NextRequest, { params }: Params) {
  if (!authenticate(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    if (!deleteReusableWorkflow((await params).id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not remove the workflow" }, { status: 400 });
  }
}
