import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validateSession } from "@/server/auth";
import { getSessionManager } from "@/server/singleton";
import { scanAllSessions } from "@/server/transcript";

const SESSIONS_PER_GROUP_LIMIT = 20;

function authenticate(req: NextRequest): boolean {
  const token = req.cookies.get("cockpit_session")?.value || req.headers.get("authorization")?.replace("Bearer ", "");
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
        session.pendingRequestCount = running.pendingRequestCount;
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
      groups.push({ cwd: mem.cwd, dirName, sessions: [mem], totalSessionCount: 1 });
    }
  }

  // Filter out scheduled job sessions
  const JOB_TITLE_PREFIX = "You are running as an autonomous scheduled job";
  for (const group of groups) {
    group.sessions = group.sessions.filter((s) => !s.name?.startsWith("[job] ") && !s.name?.startsWith(JOB_TITLE_PREFIX));
  }

  const typeParam = req.nextUrl.searchParams.get("type");
  if (typeParam === "reviews") {
    const reviewGroups = groups.filter((g) => g.cwd.includes(".cockpit/reviews"));
    const allReviews = reviewGroups.flatMap((g) => g.sessions);
    allReviews.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "10", 10), 50);
    return NextResponse.json({ sessions: allReviews.slice(0, limit) });
  }

  const filtered = groups.filter((g) => g.sessions.length > 0 && !g.cwd.endsWith(".cockpit/jobs"));

  // Re-sort after merging in-memory sessions
  for (const group of filtered) {
    group.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
  filtered.sort((a, b) => {
    const aLatest = a.sessions[0]?.lastActiveAt || 0;
    const bLatest = b.sessions[0]?.lastActiveAt || 0;
    return bLatest - aLatest;
  });

  // Truncate the visible list per group; clients fetch the full list for
  // one directory via /api/sessions/group?cwd=... when the user expands it.
  for (const group of filtered) {
    group.totalSessionCount = group.sessions.length;
    if (group.sessions.length > SESSIONS_PER_GROUP_LIMIT) {
      group.sessions = group.sessions.slice(0, SESSIONS_PER_GROUP_LIMIT);
    }
  }

  return NextResponse.json({ groups: filtered });
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const cwd = body.cwd as string;
  const name = body.name as string | undefined;
  const runtimeRaw = body.runtime as string | undefined;
  const runtime = runtimeRaw === "pty" || runtimeRaw === "stream" ? runtimeRaw : undefined;

  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  const session = getSessionManager().createSession(cwd, name, runtime ? { runtime } : undefined);
  return NextResponse.json({ sessionId: session.id });
}
