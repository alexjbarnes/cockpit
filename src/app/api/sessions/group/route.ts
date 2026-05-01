import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { scanSessionsForCwd } from "@/server/transcript";
import type { SessionInfo } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  const sessions = await scanSessionsForCwd(cwd);

  const manager = getSessionManager();
  const activeMap = new Map(manager.listActiveSessions().map((s) => [s.id, s]));
  const knownMap = new Map(manager.listKnownSessions().map((s) => [s.id, s]));

  const onDiskIds = new Set<string>();
  for (const session of sessions) {
    onDiskIds.add(session.id);
    const running = activeMap.get(session.id);
    if (running) {
      session.status = running.status;
      session.pendingRequestCount = running.pendingRequestCount;
    }
    const mem = knownMap.get(session.id);
    if (mem) {
      session.name = mem.name;
    }
  }

  // Include in-memory sessions for this cwd that have no transcript file yet
  for (const mem of knownMap.values()) {
    if (mem.cwd === cwd && !onDiskIds.has(mem.id)) {
      sessions.push(mem);
    }
  }

  const JOB_TITLE_PREFIX = "You are running as an autonomous scheduled job";
  const filtered: SessionInfo[] = sessions.filter((s) => !s.name?.startsWith("[job] ") && !s.name?.startsWith(JOB_TITLE_PREFIX));
  filtered.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  return NextResponse.json({ sessions: filtered });
}
