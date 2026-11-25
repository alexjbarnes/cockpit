import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { deleteProject, getProject, loadIssues, type ProjectUpdateInput, saveProject } from "@/server/issue-storage";
import { getWorkflowEngine } from "@/server/singleton";
import { deleteWorkflow, prepareProjectUpdate } from "@/server/workflow-storage";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const existing = getProject(id);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "A project patch is required" }, { status: 400 });
    try {
      // The workflow source travels with the patch so the final project is
      // validated and saved once. `prepareProjectUpdate` applies the ordinary
      // fields, syncs a shared workflow's statuses and checks that no status
      // its workflow names has gone.
      const { reusableWorkflowId, ...patch } = body;
      const updated = prepareProjectUpdate(existing, patch as ProjectUpdateInput, reusableWorkflowId as string | null | undefined);
      // Removing a custom status that issues still sit in would orphan them
      // (no column, and the value is no longer accepted on future edits).
      // Refuse and name the offenders so the user moves them first. Disabling a
      // built-in is always fine — its value stays valid and the board keeps a
      // column for any status that has issues.
      if (body.customStatuses !== undefined) {
        const nextNames = new Set((updated.customStatuses ?? []).map((s) => s.name));
        const removed = (existing.customStatuses ?? []).map((s) => s.name).filter((name) => !nextNames.has(name));
        if (removed.length > 0) {
          const inUse = loadIssues(existing.id).filter((i) => removed.includes(i.status));
          if (inUse.length > 0) {
            const names = [...new Set(inUse.map((i) => i.status))].join(", ");
            return NextResponse.json(
              { error: `Move the issues out of these statuses before removing them: ${names} (${inUse.length} issue(s)).` },
              { status: 400 },
            );
          }
        }
      }
      saveProject(updated);
      // The old workflow's rules no longer apply to a project that changed source.
      if (existing.reusableWorkflowId !== updated.reusableWorkflowId) {
        getWorkflowEngine()?.forget(existing.id);
      }
      // A repo path, base branch or workflow source set now may be what its issues were waiting for.
      getWorkflowEngine()?.kick();
      return NextResponse.json({ project: updated });
    } catch (err) {
      // e.g. a prefix change rejected because the project already has issues,
      // or a prefix collision with another project — see saveProject's guards
      // in issue-storage.ts. Surface the message rather than a bare 500.
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save project" }, { status: 400 });
    }
  });
}

export function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id }) => {
    // Its workflow goes with it: runs are stopped while the engine can still tell whose they are.
    getWorkflowEngine()?.forget(id);
    const deleted = deleteProject(id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    deleteWorkflow(id);
    return NextResponse.json({ ok: true });
  });
}
