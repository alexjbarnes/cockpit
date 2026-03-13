import { NextRequest, NextResponse } from "next/server";
import { validateToken } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { scanAllSessions } from "@/server/transcript";

function authenticate(req: NextRequest): boolean {
  const token =
    req.cookies.get("aperture_token")?.value ||
    req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateToken(token);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const groups = await scanAllSessions();

  // Merge running status from active sessions
  const manager = getSessionManager();
  const active = manager.listActiveSessions();
  const activeMap = new Map(active.map((s) => [s.id, s]));

  for (const group of groups) {
    for (const session of group.sessions) {
      const running = activeMap.get(session.id);
      if (running) {
        session.status = running.status;
      }
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
