import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { applyProjectUpdate, deleteProject, getProject, saveProject } from "@/server/issue-storage";

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

    const body = await req.json();
    try {
      // applyProjectUpdate now validates its own patch (name/prefix/
      // description/repoPath/archived) and throws on a bad value, so it has
      // to be inside this try too, not just saveProject — otherwise a bad
      // value would 500 instead of 400.
      const updated = applyProjectUpdate(existing, body);
      saveProject(updated);
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
    const deleted = deleteProject(id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
