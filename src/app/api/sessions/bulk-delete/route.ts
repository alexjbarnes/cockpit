import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { deleteTranscript } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const sessions: { id: string; cwd: string }[] = body.sessions;

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return NextResponse.json({ error: "sessions array required" }, { status: 400 });
  }

  const manager = getSessionManager();
  const results: { id: string; deleted: boolean; error?: string }[] = [];

  for (const { id, cwd } of sessions) {
    if (manager.hasRunningProcess(id)) {
      results.push({ id, deleted: false, error: "running" });
      continue;
    }
    manager.destroySession(id);
    await deleteTranscript(id, cwd || "");
    results.push({ id, deleted: true });
  }

  return NextResponse.json({ results });
}
