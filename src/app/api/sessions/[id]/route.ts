import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { deleteTranscript } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const cwd = req.nextUrl.searchParams.get("cwd");
    const manager = getSessionManager();

    const session = cwd ? await manager.getSessionByCwd(id, cwd) : await manager.getSession(id);

    if (!session) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ session: session.info, messages: session.messages });
  });
}

export function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const cwd = req.nextUrl.searchParams.get("cwd") || "";
    const manager = getSessionManager();

    if (manager.hasRunningProcess(id)) {
      return NextResponse.json({ error: "Cannot delete a running session" }, { status: 409 });
    }

    manager.destroySession(id);
    await deleteTranscript(id, cwd);

    return NextResponse.json({ ok: true });
  });
}
