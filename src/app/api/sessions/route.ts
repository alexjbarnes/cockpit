import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { validateSession, isAuthDisabled } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { scanAllSessions } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  if (isAuthDisabled()) return true;
  const token =
    req.cookies.get("cockpit_session")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const groups = await scanAllSessions();

  // Merge status and name from in-memory sessions
  const manager = getSessionManager();
  const active = manager.listActiveSessions();
  const known = manager.listKnownSessions();
  const activeMap = new Map(active.map((s) => [s.id, s]));
  const knownMap = new Map(known.map((s) => [s.id, s]));

  const onDiskIds = new Set<string>();
  for (const group of groups) {
    for (const session of group.sessions) {
      onDiskIds.add(session.id);
      const running = activeMap.get(session.id);
      if (running) {
        session.status = running.status;
      }
      const mem = knownMap.get(session.id);
      if (mem) {
        session.name = mem.name;
      }
    }
  }

  // Include in-memory sessions that have no transcript file yet
  for (const mem of known) {
    if (onDiskIds.has(mem.id)) continue;
    const group = groups.find((g) => g.cwd === mem.cwd);
    if (group) {
      group.sessions.push(mem);
    } else {
      const dirName = path.basename(mem.cwd) || mem.cwd;
      groups.push({ cwd: mem.cwd, dirName, sessions: [mem] });
    }
  }

  return NextResponse.json({ groups });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const cwd = body.cwd as string;
  const name = body.name as string | undefined;

  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  const session = getSessionManager().createSession(cwd, name);
  return NextResponse.json({ sessionId: session.id });
}
