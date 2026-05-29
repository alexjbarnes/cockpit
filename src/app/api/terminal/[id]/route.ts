import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getTerminalManager } from "@/server/singleton";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const manager = getTerminalManager();
  if (!manager) {
    return NextResponse.json({ error: "Terminal manager not available" }, { status: 503 });
  }

  const { id } = await params;
  manager.destroyTerminal(id);
  return NextResponse.json({ ok: true });
}
