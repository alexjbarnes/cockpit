import { NextRequest, NextResponse } from "next/server";
import { validateSession, isAuthDisabled } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token =
    req.cookies.get("cockpit_session")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(async ({ id }) => {
    const cwd = req.nextUrl.searchParams.get("cwd");
    const manager = getSessionManager();

    const session = cwd
      ? await manager.getSessionByCwd(id, cwd)
      : await manager.getSession(id);

    if (!session) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ session: session.info, messages: session.messages });
  });
}

export function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return params.then(({ id }) => {
    const deleted = getSessionManager().destroySession(id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
