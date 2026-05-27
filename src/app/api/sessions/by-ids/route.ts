import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { scanSessionsByIds } from "@/server/transcript";
import type { SessionInfo } from "@/types";

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && validateSession(token);
}

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const idsParam = req.nextUrl.searchParams.get("ids") || "";
  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ sessions: [] });
  }

  const sessions = await scanSessionsByIds(ids);
  console.log(`[api/sessions/by-ids] scanSessionsByIds(${ids.length} ids) took ${(performance.now() - t0).toFixed(0)}ms`);

  const manager = getSessionManager();
  const activeMap = new Map(manager.listActiveSessions().map((s) => [s.id, s]));
  const knownMap = new Map(manager.listKnownSessions().map((s) => [s.id, s]));

  const found = new Set<string>();
  for (const session of sessions) {
    found.add(session.id);
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

  // Include in-memory sessions matching the requested IDs that have no
  // transcript file yet (newly created sessions)
  const requested = new Set(ids);
  for (const mem of knownMap.values()) {
    if (requested.has(mem.id) && !found.has(mem.id)) {
      sessions.push(mem);
      found.add(mem.id);
    }
  }

  const result: SessionInfo[] = sessions;
  return NextResponse.json({ sessions: result, foundIds: [...found] });
}
